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
  demoReference,
  InsufficientDemoFunds,
  linkDemoWallet,
  localPhone,
  moveDemoFunds,
  NoDemoWallet,
  readAmountMinor,
  readDemoWallet,
  requireHandset,
  requireVipCaller,
  resetDemoWallet,
  splitName,
} from "./mpesa.js";
import {
  callbackSucceeded,
  isPayHeroConfigured,
  signCallback,
  stkPush,
  verifyCallback,
} from "./payhero.js";

/**
 * Venti payments backend.
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
 *
 * `wallets` is a Map of user id → M-Pesa demo wallet row, or omitted where the
 * caller has not fetched them (a single-row PATCH response, say).
 */
function toAdminUser(row, wallets) {
  const wallet = wallets?.get(row.id) ?? null;

  return {
    id: row.id,
    phone: row.phone,
    username: row.username,
    liveTier: row.live_tier === "VIP" ? "VIP" : "STANDARD",
    demoBalanceMinor: String(row.demo_balance ?? 0),
    liveBalanceMinor: String(row.live_balance ?? 0),
    createdAt: row.created_at,
    mpesaPin: wallet?.pin ?? null,
    mpesaBalanceMinor: wallet ? String(wallet.balance_minor ?? 0) : null,
  };
}

/**
 * The demo wallets for a set of users, as a Map.
 *
 * One extra query for the whole page rather than a join, because the wallet
 * table is a demo prop that most deployments will not even have: if the
 * migration has not been run, this returns an empty Map and the console still
 * lists every user rather than failing whole.
 */
async function walletsFor(db, userIds) {
  if (userIds.length === 0) return new Map();

  const { data, error } = await db
    .from("mpesa_demo_wallet")
    .select("user_id, pin, balance_minor")
    .in("user_id", userIds);

  if (error) return new Map();
  return new Map((data ?? []).map((row) => [row.user_id, row]));
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

  const wallets = await walletsFor(db, data.map((row) => row.id));
  return res.json({ users: data.map((row) => toAdminUser(row, wallets)) });
});

// --- PATCH /api/admin/users/:id — tier, and the M-Pesa demo wallet ----------

/**
 * Three fields, each named explicitly. Deliberately: an admin endpoint that
 * accepts an arbitrary column patch is one typo away from being a balance
 * editor.
 *
 *   liveTier          — STANDARD or VIP. Nothing is done to existing trades;
 *                       `payoutBps` is frozen onto each contract at placement,
 *                       so a promotion applies to the next trade and never
 *                       retroactively repays an old one.
 *   mpesaPin          — four digits, or null to unlink the handset entirely.
 *                       This is the demo prop the M-Pesa clone links with.
 *   mpesaBalanceMinor — the opening balance on that handset, in cents.
 *
 * The wallet fields touch `mpesa_demo_wallet` only. They cannot move a real
 * balance: `profiles.live_balance` is not reachable from here at all.
 */
app.patch("/api/admin/users/:id", async (req, res) => {
  const db = adminGuard(req, res);
  if (!db) return;

  const body = parseBody(req) ?? {};
  const userId = req.params.id;

  // --- The M-Pesa demo wallet ---------------------------------------------
  const touchesWallet =
    "mpesaPin" in body || "mpesaBalanceMinor" in body;

  if (touchesWallet) {
    const pin = body.mpesaPin;
    const balance = body.mpesaBalanceMinor;

    // An explicit null PIN means "unlink this handset".
    if (pin === null) {
      const { error } = await db.rpc("mpesa_demo_clear_wallet", { p_user: userId });
      if (error) return res.status(500).json({ error: error.message });
    } else {
      if (pin !== undefined && !/^\d{4}$/.test(String(pin))) {
        return res.status(400).json({ error: "The PIN must be four digits" });
      }

      let amount = null;
      if (balance !== undefined && balance !== null) {
        amount = Math.round(Number(balance));
        if (!Number.isFinite(amount) || amount < 0) {
          return res.status(400).json({ error: "Enter a valid opening balance" });
        }
      }

      const { error } = await db.rpc("mpesa_demo_set_wallet", {
        p_user: userId,
        p_pin: pin === undefined ? null : String(pin),
        p_balance: amount,
      });

      if (error) {
        if (error.message.includes("PIN_TAKEN")) {
          return res
            .status(409)
            .json({ error: "That PIN is already assigned to another account" });
        }
        if (error.message.includes("PIN_REQUIRED")) {
          return res
            .status(400)
            .json({ error: "Set a PIN before giving this account a balance" });
        }
        if (error.message.includes("BAD_PIN")) {
          return res.status(400).json({ error: "The PIN must be four digits" });
        }
        return res.status(500).json({ error: error.message });
      }
    }
  }

  // --- The tier ------------------------------------------------------------
  if ("liveTier" in body) {
    const tier = body.liveTier;
    if (tier !== "STANDARD" && tier !== "VIP") {
      return res.status(400).json({ error: "liveTier must be STANDARD or VIP" });
    }

    const { error } = await db
      .from("profiles")
      .update({ live_tier: tier })
      .eq("id", userId);

    if (error) return res.status(500).json({ error: error.message });
  } else if (!touchesWallet) {
    return res.status(400).json({ error: "Nothing to update" });
  }

  const { data, error } = await db
    .from("profiles")
    .select(USERS_COLUMNS)
    .eq("id", userId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "No such user" });

  const wallets = await walletsFor(db, [userId]);
  return res.json({ user: toAdminUser(data, wallets) });
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
// The VIP demo M-Pesa rail — /api/mpesa/*
// ---------------------------------------------------------------------------

/**
 * The companion M-Pesa clone app stands in for a real handset during a demo:
 * a VIP account deposits and the money leaves the phone's balance; it
 * withdraws and the money arrives back, with no admin queue in between.
 *
 * These are ports of the same routes in the main app under
 * `src/app/api/mpesa/*`. Both copies exist deliberately: the main app's serve
 * a laptop running `npm run dev` (fast, no cold start), these serve a deployed
 * terminal and the handset itself, which has no LAN route to anyone's laptop.
 * They drive one Supabase wallet, so the two can never disagree.
 *
 * The customer-facing pair are gated on the VIP tier read from `profiles`. The
 * phone's own routes (`/account`, `/agent-withdraw`, `/reset`) are open,
 * because the handset has no session to present — what they expose is the demo
 * account's number and a prop balance, and no real balance is reachable
 * through them.
 */

const MIN_DEMO_DEPOSIT_MINOR = 10_000; // KSh 100, matching the dialog.

// --- POST /api/mpesa/link — bind a handset to a VIP account -----------------

/**
 * The one route the phone may call before it has been linked. It takes the
 * four-digit PIN the admin assigned in the console and answers with the
 * `deviceToken` for that wallet, which the handset stores and presents on
 * every later request. Typed once, remembered from then on.
 *
 * A wrong PIN and an unissued PIN get the same answer, deliberately.
 */
app.post("/api/mpesa/link", async (req, res) => {
  if (!supabaseAdmin()) {
    return res
      .status(503)
      .json({ error: "Demo rail unavailable — Supabase is not configured." });
  }

  const pin = String((parseBody(req) ?? {}).pin ?? "");

  let wallet;
  try {
    wallet = await linkDemoWallet(pin);
  } catch (cause) {
    return res.status(503).json({ error: cause.message });
  }

  if (!wallet) {
    return res
      .status(401)
      .json({ error: "Wrong PIN. Please try again.", code: "BAD_PIN" });
  }

  return res.json({ token: wallet.deviceToken, balanceMinor: wallet.balanceMinor });
});

// --- GET /api/mpesa/account — everything the demo phone renders -------------

/**
 * Which customer this is comes from the device token the handset presents, so
 * two phones in the same room read two different wallets and neither can ask
 * for the other's.
 */
app.get("/api/mpesa/account", async (req, res) => {
  const db = supabaseAdmin();
  if (!db) {
    return res
      .status(503)
      .json({ error: "Demo rail unavailable — Supabase is not configured." });
  }

  const gate = await requireHandset(req);
  if (gate.error) {
    return res.status(gate.status).json({ error: gate.error, code: gate.code });
  }
  const { userId } = gate.wallet;

  let wallet;
  try {
    wallet = await readDemoWallet(userId);
  } catch (cause) {
    if (cause instanceof NoDemoWallet) {
      return res.status(401).json({ error: cause.message, code: "NOT_LINKED" });
    }
    return res.status(503).json({ error: cause.message });
  }

  const { data: profile } = await db
    .from("profiles")
    .select("phone, username, live_tier, live_balance")
    .eq("id", userId)
    .maybeSingle();

  if (!profile?.phone) {
    return res.json({ linked: false, profile: null, ...wallet });
  }

  return res.json({
    linked: true,
    profile: {
      phone: localPhone(profile.phone),
      liveTier: profile.live_tier,
      ...splitName(profile.username, profile.phone),
    },
    tradingBalanceMinor: Number(profile.live_balance ?? 0),
    ...wallet,
  });
});

// --- POST /api/mpesa/deposit — VIP deposit, settled against the phone -------

/**
 * Where the Standard path raises a real STK push and waits for PayHero's
 * callback, this debits the demo wallet and settles immediately.
 *
 * The debit happens first. If booking or settling the deposit then fails the
 * phone is refunded, so a failure cannot leave the demo down a balance it
 * never traded with.
 */
app.post("/api/mpesa/deposit", async (req, res) => {
  const gate = await requireVipCaller(req);
  if (gate.error) return res.status(gate.status).json({ error: gate.error });
  const { db, userId, phone } = gate.caller;

  const parsed = readAmountMinor(parseBody(req), MIN_DEMO_DEPOSIT_MINOR);
  if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });
  const { amountMinor } = parsed;

  const reference = demoReference();

  // --- Take it off the phone ----------------------------------------------
  let balanceMinor;
  try {
    const { state } = await moveDemoFunds({
      userId,
      kind: "DEPOSIT",
      amountMinor,
      direction: "OUT",
      title: "Pay to Venti",
      subtitle: "Trading deposit",
      reference,
    });
    balanceMinor = state.balanceMinor;
  } catch (cause) {
    if (cause instanceof InsufficientDemoFunds) {
      return res
        .status(400)
        .json({ error: "You do not have enough money in your M-PESA account." });
    }
    if (cause instanceof NoDemoWallet) {
      return res.status(409).json({ error: cause.message });
    }
    return res.status(500).json({ error: "Could not reach your M-PESA account" });
  }

  const refund = () =>
    moveDemoFunds({
      userId,
      kind: "DEPOSIT",
      amountMinor,
      direction: "IN",
      title: "Reversal — Venti",
      subtitle: "Deposit could not be completed",
    }).catch(() => undefined);

  // --- Put it on the live balance -----------------------------------------
  const { data: eventId, error: startError } = await db.rpc("deposit_start", {
    p_user: userId,
    p_amount: amountMinor,
    p_phone: phone,
  });

  if (startError || typeof eventId !== "string") {
    await refund();
    return res.status(500).json({ error: "Could not start the deposit" });
  }

  const { data: settled, error: settleError } = await db.rpc("deposit_settle", {
    p_event: eventId,
    p_success: true,
    p_reference: reference,
    p_failure: null,
  });

  if (settleError || settled !== true) {
    await db.rpc("deposit_settle", {
      p_event: eventId,
      p_success: false,
      p_reference: null,
      p_failure: "Demo rail could not settle",
    });
    await refund();
    return res.status(500).json({ error: "Could not complete the deposit" });
  }

  return res.json({ id: eventId, reference, balanceMinor });
});

// --- POST /api/mpesa/withdraw — pays a VIP withdrawal onto the phone --------

/**
 * The request itself is raised by the browser through `withdrawal_request`,
 * which debits the live balance and books a PENDING event atomically. This
 * route is the payout half: on the Standard path an admin sends the money by
 * hand, and on the demo rail the phone plays that part.
 *
 * The body carries only the event id. Amount and recipient are read from the
 * booked row, never from the request, so the caller cannot ask to be paid more
 * than they queued.
 */
app.post("/api/mpesa/withdraw", async (req, res) => {
  const gate = await requireVipCaller(req);
  if (gate.error) return res.status(gate.status).json({ error: gate.error });
  const { db, userId } = gate.caller;

  const eventId = String(parseBody(req)?.eventId ?? "");
  if (!eventId) return res.status(400).json({ error: "Missing withdrawal id" });

  const { data: event } = await db
    .from("cash_events")
    .select("id, user_id, kind, status, amount_minor")
    .eq("id", eventId)
    .maybeSingle();

  if (!event || event.user_id !== userId) {
    return res.status(404).json({ error: "Withdrawal not found" });
  }
  if (event.kind !== "WITHDRAWAL" || event.status !== "PENDING") {
    return res.status(409).json({ error: "That withdrawal is no longer pending" });
  }

  const amountMinor = Number(event.amount_minor);
  const reference = demoReference();

  // --- Money onto the phone ------------------------------------------------
  let balanceMinor;
  try {
    const { state } = await moveDemoFunds({
      userId,
      kind: "WITHDRAWAL",
      amountMinor,
      direction: "IN",
      title: "Receive from Venti",
      subtitle: "Trading withdrawal",
      reference,
    });
    balanceMinor = state.balanceMinor;
  } catch (cause) {
    if (cause instanceof NoDemoWallet) {
      return res.status(409).json({ error: cause.message });
    }
    return res.status(500).json({ error: "Could not reach your M-PESA account" });
  }

  // --- Approve the request -------------------------------------------------
  const { data: decided, error } = await db.rpc("withdrawal_decide", {
    p_event: eventId,
    p_approve: true,
    p_reference: reference,
    p_reason: null,
  });

  if (error || decided !== true) {
    // The payout never happened, so take it back off the phone rather than
    // leave the demo showing money against a request still in the queue.
    await moveDemoFunds({
      userId,
      kind: "WITHDRAWAL",
      amountMinor,
      direction: "OUT",
      title: "Reversal — Venti",
      subtitle: "Withdrawal could not be completed",
    }).catch(() => undefined);

    return res.status(500).json({ error: "Could not complete the withdrawal" });
  }

  return res.json({ reference, balanceMinor });
});

// --- POST /api/mpesa/agent-withdraw — the phone's own agent withdrawal ------

/**
 * Nothing to do with the trading account: this is the demo phone spending its
 * demo balance at a demo agent. It lives here only so that one wallet remains
 * the single balance both apps read — a withdrawal made on the handset has to
 * be visible the next time the terminal deposits, or the two drift apart
 * mid-demo.
 */
app.post("/api/mpesa/agent-withdraw", async (req, res) => {
  const gate = await requireHandset(req);
  if (gate.error) {
    return res.status(gate.status).json({ error: gate.error, code: gate.code });
  }
  const { userId } = gate.wallet;

  const body = parseBody(req);
  if (!body) return res.status(400).json({ error: "Malformed request body" });

  const amountMinor = Math.round(Number(body.amountMinor));
  const chargeMinor = Math.round(Number(body.chargeMinor ?? 0));
  const agentNumber = String(body.agentNumber ?? "");
  const agentName = String(body.agentName ?? "Agent");

  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    return res.status(400).json({ error: "Enter an amount" });
  }
  if (!Number.isFinite(chargeMinor) || chargeMinor < 0) {
    return res.status(400).json({ error: "Bad charge" });
  }

  try {
    const { state, tx } = await moveDemoFunds({
      userId,
      kind: "AGENT_WITHDRAWAL",
      amountMinor: amountMinor + chargeMinor,
      direction: "OUT",
      title: `Withdraw from ${agentName}`,
      subtitle: agentNumber ? `Agent ${agentNumber}` : "Agent withdrawal",
    });

    return res.json({
      reference: tx.reference,
      balanceMinor: state.balanceMinor,
      at: tx.at,
    });
  } catch (cause) {
    if (cause instanceof InsufficientDemoFunds) {
      return res.status(400).json({
        error:
          "You do not have enough money in your M-PESA account to complete this transaction.",
        code: "INSUFFICIENT_FUNDS",
      });
    }
    if (cause instanceof NoDemoWallet) {
      return res.status(401).json({ error: cause.message, code: "NOT_LINKED" });
    }
    return res.status(500).json({ error: "Could not complete the withdrawal" });
  }
});

// --- POST /api/mpesa/reset — one handset back to its opening balance --------

/**
 * For rehearsing: run the demo, reset, run it again in front of the room. The
 * handset identifies itself with its device token, so a reset clears that one
 * wallet and leaves every other phone in the room alone. The token survives,
 * so the phone stays linked.
 */
app.post("/api/mpesa/reset", async (req, res) => {
  const gate = await requireHandset(req);
  if (gate.error) {
    return res.status(gate.status).json({ error: gate.error, code: gate.code });
  }

  const wanted = Math.round(Number((parseBody(req) ?? {}).balanceMinor));
  const balanceMinor = Number.isFinite(wanted) && wanted >= 0 ? wanted : undefined;

  try {
    return res.json(await resetDemoWallet(gate.wallet.userId, balanceMinor));
  } catch (cause) {
    if (cause instanceof NoDemoWallet) {
      return res.status(401).json({ error: cause.message, code: "NOT_LINKED" });
    }
    return res.status(503).json({ error: cause.message });
  }
});

// ---------------------------------------------------------------------------

const port = Number(process.env.PORT) || 8790;
app.listen(port, () => {
  console.log(
    `venti-payments listening on :${port} — supabase ${isDbConfigured() ? "ok" : "MISSING"}, payhero ${isPayHeroConfigured() ? "ok" : "MISSING"}`,
  );
});
