import express from "express";
import { supabaseAdmin, isDbConfigured } from "./supabase.js";
import {
  bearerToken,
  isAdminEnabled,
  issueToken,
  verifyPasscode,
  verifyToken,
} from "./admin.js";
import { identityEmail, validateRegistration } from "./phone.js";
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
 *   POST /api/auth/register              — create an account, pre-confirmed
 *   POST /api/payments/deposit           — signed-in customer raises an STK push
 *   POST /api/payments/payhero/callback  — PayHero reports the M-Pesa result
 *   GET/POST/DELETE /api/admin/session   — the admin console's door
 *   GET  /api/admin/users                — every profile, newest first
 *   PATCH /api/admin/users/:id           — change a user's live tier
 *   GET  /api/admin/withdrawals          — the payout queue
 *   PATCH /api/admin/withdrawals/:id     — decide a pending request
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
  res.setHeader(
    "access-control-allow-methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
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
// POST /api/auth/register — create an account
// ---------------------------------------------------------------------------

/**
 * Sign-in happens in the browser against Supabase directly; only *creation*
 * comes through here, for one reason: the project has email confirmation on,
 * and the identity address derived from a phone number is on a reserved
 * domain that can never receive mail. A browser `signUp` would create an
 * unconfirmed user, mail a link into the void, and strand the customer. The
 * service role creates the user already confirmed.
 *
 * Creating a user is the only thing this route can do. It takes no role, no
 * tier and no balance from the request — a registration endpoint that accepts
 * a `live_tier` is a self-service VIP button.
 *
 * Rate-limited per address: account creation is the one unauthenticated write
 * in the system. In-memory and therefore per-instance — enough for a single
 * Render service.
 */

const REGISTER_WINDOW_MS = 10 * 60 * 1000;
const REGISTER_MAX_ATTEMPTS = 8;
const registerAttempts = new Map();

function registerThrottled(key) {
  const now = Date.now();
  const entry = registerAttempts.get(key);

  if (!entry || entry.resetAt <= now) {
    registerAttempts.set(key, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > REGISTER_MAX_ATTEMPTS;
}

app.post("/api/auth/register", async (req, res) => {
  const db = supabaseAdmin();
  if (!db) {
    return res
      .status(503)
      .json({ error: "Sign-up is unavailable — Supabase is not configured." });
  }

  const client =
    (req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "local";
  if (registerThrottled(client)) {
    return res
      .status(429)
      .json({ error: "Too many sign-up attempts. Try again later." });
  }

  const body = parseBody(req) ?? {};

  // Re-run the same rules the form ran. The client's copy is there to give
  // instant feedback; this one is the one that decides.
  const validated = validateRegistration(
    typeof body.phone === "string" ? body.phone : "",
    typeof body.username === "string" ? body.username : "",
    typeof body.password === "string" ? body.password : "",
  );
  if (!validated.ok) {
    return res.status(400).json({ error: validated.reason });
  }

  const { phone, username, password } = validated.value;

  const { error } = await db.auth.admin.createUser({
    email: identityEmail(phone),
    password,
    // Pre-confirmed: nothing can be sent to the derived address, so waiting on
    // a confirmation that will never arrive would strand the account.
    email_confirm: true,
    // `handle_new_user` reads these to populate `public.profiles`.
    user_metadata: { phone, username },
  });

  if (error) {
    // Supabase reports a duplicate as 422 "already been registered". Say what
    // it means in the app's own terms; anything else is passed through as a
    // server fault rather than as the customer's mistake.
    const duplicate =
      error.status === 422 || /already/i.test(error.message ?? "");

    return res.status(duplicate ? 409 : 500).json({
      error: duplicate
        ? "An account already exists for this number"
        : (error.message ?? "Could not create the account"),
    });
  }

  return res.json({ ok: true });
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
// Admin console API
// ---------------------------------------------------------------------------

/**
 * The one gate every privileged route passes through. Returns the
 * service-role client, or answers the request itself and returns null.
 * Having a single function that decides "may this request touch other
 * people's data" is what keeps the check from being forgotten on the third
 * route someone adds — a forgotten guard here is a full database leak.
 */
function adminGuard(req, res) {
  if (!isAdminEnabled()) {
    res
      .status(503)
      .json({ error: "Admin console is disabled. Set ADMIN_PASSCODE." });
    return null;
  }
  if (!verifyToken(bearerToken(req))) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  const db = supabaseAdmin();
  if (!db) {
    res
      .status(503)
      .json({ error: "Supabase is not configured. Set SUPABASE_SERVICE_ROLE_KEY." });
    return null;
  }
  return db;
}

/**
 * Passcode-attempt throttle. A shared passcode with unlimited attempts is a
 * passcode with a few hours of life. In-memory, per-instance — enough against
 * a single Render service.
 */
const ADMIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_MAX_ATTEMPTS = 10;
const adminAttempts = new Map();

function adminThrottled(key) {
  const now = Date.now();
  const entry = adminAttempts.get(key);

  if (!entry || entry.resetAt <= now) {
    adminAttempts.set(key, { count: 1, resetAt: now + ADMIN_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > ADMIN_MAX_ATTEMPTS;
}

// The console probes this on load to decide what to render: the setup notice,
// the passcode gate, or the console itself.
app.get("/api/admin/session", (req, res) => {
  res.json({
    enabled: isAdminEnabled(),
    db: isDbConfigured(),
    signedIn: verifyToken(bearerToken(req)),
  });
});

// Passcode in, signed token out. The token is the console's to hold — there
// is no cookie, because the console and this API live on different origins
// and a strict cookie would never be sent (see admin.js).
app.post("/api/admin/session", (req, res) => {
  if (!isAdminEnabled()) {
    return res
      .status(503)
      .json({ error: "Admin console is disabled. Set ADMIN_PASSCODE." });
  }

  const client =
    (req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "local";
  if (adminThrottled(client)) {
    return res
      .status(429)
      .json({ error: "Too many attempts. Try again later." });
  }

  const body = parseBody(req) ?? {};
  const passcode = typeof body.passcode === "string" ? body.passcode : "";

  if (!verifyPasscode(passcode)) {
    return res.status(401).json({ error: "Incorrect passcode" });
  }

  return res.json({ ok: true, token: issueToken() });
});

// Sessions are stateless — sign-out is the client forgetting the token. The
// endpoint exists so the console's sign-out has something honest to call.
app.delete("/api/admin/session", (_req, res) => {
  res.json({ ok: true });
});

// --- GET /api/admin/users?q=… — every profile, newest first ----------------

const USERS_PAGE_SIZE = 200;
const USERS_COLUMNS =
  "id, phone, username, live_tier, demo_balance, live_balance, created_at";

/**
 * BIGINT arrives as a string from PostgREST when it exceeds the safe integer
 * range and as a number when it does not. Normalising to a string means the
 * console never has to care which it got.
 */
function toAdminUser(row) {
  return {
    id: row.id,
    phone: row.phone,
    username: row.username,
    liveTier: row.live_tier === "VIP" ? "VIP" : "STANDARD",
    demoBalanceMinor: String(row.demo_balance ?? 0),
    liveBalanceMinor: String(row.live_balance ?? 0),
    createdAt: row.created_at,
  };
}

app.get("/api/admin/users", async (req, res) => {
  const db = adminGuard(req, res);
  if (!db) return;

  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";

  let select = db
    .from("profiles")
    .select(USERS_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(USERS_PAGE_SIZE);

  if (query) {
    // `%` and `_` are wildcards in ILIKE; escaping them keeps a search for
    // "100%" from matching everything. Commas and parens would break out of
    // PostgREST's `or` filter syntax, so they are dropped.
    const safe = query.replace(/[%_,()]/g, "");
    if (safe) {
      select = select.or(`phone.ilike.%${safe}%,username.ilike.%${safe}%`);
    }
  }

  const { data, error } = await select;

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json({ users: data.map(toAdminUser) });
});

// --- PATCH /api/admin/users/:id — change a user's live tier ----------------

/**
 * The tier is the only field this route will write. Deliberately: an admin
 * endpoint that accepts an arbitrary column patch is one typo away from being
 * a balance editor. Nothing is done to existing trades — `payoutBps` is
 * frozen onto each contract at placement, so a promotion applies to the next
 * trade and never retroactively repays an old one.
 */
app.patch("/api/admin/users/:id", async (req, res) => {
  const db = adminGuard(req, res);
  if (!db) return;

  const tier = (parseBody(req) ?? {}).liveTier;
  if (tier !== "STANDARD" && tier !== "VIP") {
    return res.status(400).json({ error: "liveTier must be STANDARD or VIP" });
  }

  const { data, error } = await db
    .from("profiles")
    .update({ live_tier: tier })
    .eq("id", req.params.id)
    .select(USERS_COLUMNS)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!data) {
    return res.status(404).json({ error: "No such user" });
  }

  return res.json({ user: toAdminUser(data) });
});

// --- GET /api/admin/withdrawals — the payout queue --------------------------

/**
 * Every withdrawal event, pending first and newest within each group, joined
 * with the requester's profile so the console can show who is being paid
 * without a second round-trip per row.
 */
app.get("/api/admin/withdrawals", async (req, res) => {
  const db = adminGuard(req, res);
  if (!db) return;

  const { data, error } = await db
    .from("cash_events")
    .select(
      "id, user_id, amount_minor, status, phone, reference, failure_reason, created_at, settled_at, profiles(username, phone)",
    )
    .eq("kind", "WITHDRAWAL")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const withdrawals = data.map((row) => ({
    id: row.id,
    userId: row.user_id,
    phone: row.phone || (row.profiles?.phone ?? ""),
    username: row.profiles?.username ?? "—",
    amountMinor: String(row.amount_minor ?? 0),
    status:
      row.status === "COMPLETED"
        ? "COMPLETED"
        : row.status === "FAILED"
          ? "FAILED"
          : "PENDING",
    reference: row.reference,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  }));

  // Pending first — the queue is the point of the page.
  withdrawals.sort((a, b) => {
    const aPending = a.status === "PENDING" ? 0 : 1;
    const bPending = b.status === "PENDING" ? 0 : 1;
    return aPending - bPending || b.createdAt.localeCompare(a.createdAt);
  });

  return res.json({ withdrawals });
});

// --- PATCH /api/admin/withdrawals/:id — decide a pending request ------------

/**
 * { action: "PAID", reference } — money was sent via M-Pesa by hand; record
 * the receipt and close the request. { action: "REJECT", reason? } — decline;
 * the held funds go back onto the customer's balance.
 *
 * The route only relays the verdict. The money movement happens inside
 * `withdrawal_decide`, a single SQL function, so no partial outcome (event
 * closed but hold kept, or refunded twice) is reachable from here. A request
 * no longer PENDING answers 409: two admins racing on one row means the
 * second one's click changes nothing, and is told so.
 */
app.patch("/api/admin/withdrawals/:id", async (req, res) => {
  const db = adminGuard(req, res);
  if (!db) return;

  const body = parseBody(req) ?? {};

  const action = body.action;
  if (action !== "PAID" && action !== "REJECT") {
    return res.status(400).json({ error: "action must be PAID or REJECT" });
  }

  const reference =
    typeof body.reference === "string" ? body.reference.trim() : "";
  if (action === "PAID" && !reference) {
    // The reference is the proof the money actually moved; a paid-without-ref
    // row is an unauditable one.
    return res
      .status(400)
      .json({ error: "Enter the M-Pesa reference of the payment" });
  }

  const { data, error } = await db.rpc("withdrawal_decide", {
    p_event: req.params.id,
    p_approve: action === "PAID",
    p_reference: action === "PAID" ? reference : null,
    p_reason:
      action === "REJECT" && typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : null,
  });

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  if (data !== true) {
    return res
      .status(409)
      .json({ error: "This request has already been decided" });
  }

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------

const port = Number(process.env.PORT) || 8790;
app.listen(port, () => {
  console.log(
    `meridian-payments listening on :${port} — supabase ${isDbConfigured() ? "ok" : "MISSING"}, payhero ${isPayHeroConfigured() ? "ok" : "MISSING"}`,
  );
});
