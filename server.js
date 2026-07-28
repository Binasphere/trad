import express from "express";
import { supabaseAdmin, isDbConfigured } from "./supabase.js";
import {
  callbackSucceeded,
  isPayHeroConfigured,
  signCallback,
  stkPush,
  verifyCallback,
} from "./payhero.js";

/**
 * Meridian payments backend.
 *
 * The two money-moving HTTP endpoints from the main app, extracted so they can
 * live on a small always-public host (Render) while the app itself is served
 * from anywhere — including a laptop. Everything else (accounts, balances,
 * withdrawals, the admin panel) still lives in Supabase and the main app; this
 * service only initiates deposits and receives PayHero's verdict on them.
 *
 * The routes keep their original paths, so the frontend switches over by
 * changing nothing but the origin it fetches:
 *
 *   POST /api/payments/deposit           — signed-in customer raises an STK push
 *   POST /api/payments/payhero/callback  — PayHero reports the M-Pesa result
 *   GET  /health                         — Render's health check; also shows
 *                                          which secrets are still missing
 */

const app = express();
app.disable("x-powered-by");

// Bodies are read as raw text and parsed per-route: the PayHero callback must
// tolerate a malformed payload (and still answer 200), which express.json()'s
// hard 400 would not allow.
app.use(express.text({ type: () => true, limit: "100kb" }));

const parseBody = (req) => {
  try {
    return JSON.parse(req.body);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * The deposit endpoint is called from the browser on a different origin, so
 * CORS must admit it. `*` is safe here: the endpoint authenticates by Bearer
 * token, not cookies, so no ambient credential can be ridden cross-site. Set
 * `ALLOWED_ORIGINS` (comma-separated) to pin it down once the app's origins
 * are settled.
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (allowedOrigins.includes("*")) {
    res.setHeader("access-control-allow-origin", "*");
  } else if (allowedOrigins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---------------------------------------------------------------------------
// Public origin — what PayHero calls back on
// ---------------------------------------------------------------------------

/**
 * Render exposes the service's public URL as `RENDER_EXTERNAL_URL`, so on
 * Render this needs no configuration at all. `PUBLIC_BASE_URL` overrides for
 * any other host; failing both, the proxy headers of the request decide.
 */
function publicOrigin(req) {
  const configured =
    process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (configured) return configured.replace(/\/$/, "");

  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const proto = req.headers["x-forwarded-proto"] ?? "https";
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    ok: isDbConfigured() && isPayHeroConfigured(),
    supabase: isDbConfigured(),
    payhero: isPayHeroConfigured(),
  });
});

// ---------------------------------------------------------------------------
// POST /api/payments/deposit — raise a real M-Pesa STK push via PayHero
// ---------------------------------------------------------------------------

/**
 * The caller is the signed-in customer; their access token arrives as a Bearer
 * header and is verified against Supabase before anything happens. The push
 * always goes to the *registered* number from `profiles.phone` — the request
 * body carries an amount and nothing else, for the same reason the dialog
 * shows the number read-only: a payment endpoint that accepts an arbitrary
 * phone number is how money ends up prompted on a stranger's handset.
 *
 * The flow it starts is settled by the callback below, never by this route:
 * a deposit is credited when M-Pesa says it happened, not when we asked.
 */

const MIN_DEPOSIT_MINOR = 10_000n; // KSh 100, matching the dialog.

app.post("/api/payments/deposit", async (req, res) => {
  const db = supabaseAdmin();
  if (!db) {
    return res
      .status(503)
      .json({ error: "Deposits are unavailable — Supabase is not configured." });
  }
  if (!isPayHeroConfigured()) {
    return res.status(503).json({
      error: "Deposits are unavailable — payment provider is not configured.",
    });
  }

  // --- Who is asking -------------------------------------------------------
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token) {
    return res.status(401).json({ error: "Not signed in" });
  }

  const { data: auth, error: authError } = await db.auth.getUser(token);
  if (authError || !auth.user) {
    return res.status(401).json({ error: "Not signed in" });
  }

  // --- How much ------------------------------------------------------------
  let amountMinor;
  try {
    amountMinor = BigInt(String(parseBody(req)?.amountMinor));
  } catch {
    return res.status(400).json({ error: "Malformed request body" });
  }

  if (amountMinor < MIN_DEPOSIT_MINOR) {
    return res.status(400).json({ error: "Minimum deposit is KSh 100" });
  }
  if (amountMinor % 100n !== 0n) {
    // M-Pesa moves whole shillings; a 50-cent remainder could never settle.
    return res.status(400).json({ error: "Deposits must be whole shillings" });
  }

  // --- To which number: always the registered one --------------------------
  const { data: profile } = await db
    .from("profiles")
    .select("phone")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (!profile?.phone) {
    return res.status(400).json({ error: "No registered number" });
  }

  // --- Book the pending event, then raise the push -------------------------
  const { data: eventId, error: startError } = await db.rpc("deposit_start", {
    p_user: auth.user.id,
    p_amount: Number(amountMinor),
    p_phone: profile.phone,
  });

  if (startError || typeof eventId !== "string") {
    return res.status(500).json({ error: "Could not start the deposit" });
  }

  const callbackUrl = `${publicOrigin(req)}/api/payments/payhero/callback?id=${eventId}&sig=${signCallback(eventId)}`;

  const push = await stkPush({
    amountKes: Number(amountMinor / 100n),
    phone: profile.phone,
    reference: eventId,
    callbackUrl,
  });

  if (!push.ok) {
    // The event must not linger as PENDING when no prompt was ever raised.
    await db.rpc("deposit_settle", {
      p_event: eventId,
      p_success: false,
      p_reference: null,
      p_failure: push.error,
    });
    return res.status(502).json({ error: push.error });
  }

  if (push.checkoutId) {
    await db.rpc("deposit_mark_sent", {
      p_event: eventId,
      p_checkout: push.checkoutId,
    });
  }

  return res.json({ id: eventId });
});

// ---------------------------------------------------------------------------
// POST /api/payments/payhero/callback — where a deposit actually settles
// ---------------------------------------------------------------------------

/**
 * PayHero calls this with the M-Pesa result. Three properties keep an
 * unauthenticated webhook from being a money printer:
 *
 *   - The URL carries an HMAC of the event id (`sig`), minted when the push
 *     was raised. A customer who knows their own pending event id still cannot
 *     forge a confirmation, because they cannot sign it.
 *   - The amount credited is the amount recorded at initiation. Nothing in
 *     this payload can change what a deposit is worth.
 *   - `deposit_settle` is idempotent: a retried or duplicated webhook finds
 *     the event already settled and does nothing.
 *
 * Always answers 200 with a body PayHero can log; a webhook that 500s gets
 * retried into the same idempotent function anyway.
 */
app.post("/api/payments/payhero/callback", async (req, res) => {
  const db = supabaseAdmin();
  if (!db) {
    return res.json({ ok: false, error: "unconfigured" });
  }

  const id = typeof req.query.id === "string" ? req.query.id : "";
  const sig = typeof req.query.sig === "string" ? req.query.sig : "";

  if (!id || !sig || !verifyCallback(id, sig)) {
    return res.json({ ok: false, error: "bad signature" });
  }

  const payload = parseBody(req) ?? {};
  const inner = payload.response ?? {};

  // The signed id in the URL is authoritative; a payload naming a different
  // event is a mismatch we refuse rather than reconcile.
  if (inner.ExternalReference && inner.ExternalReference !== id) {
    return res.json({ ok: false, error: "reference mismatch" });
  }

  const success = callbackSucceeded(payload);

  await db.rpc("deposit_settle", {
    p_event: id,
    p_success: success,
    p_reference: inner.MpesaReceiptNumber ?? null,
    p_failure: success ? null : (inner.ResultDesc ?? "Payment failed"),
  });

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------

const port = Number(process.env.PORT) || 8790;
app.listen(port, () => {
  console.log(
    `meridian-payments listening on :${port} — supabase ${isDbConfigured() ? "ok" : "MISSING"}, payhero ${isPayHeroConfigured() ? "ok" : "MISSING"}`,
  );
});
