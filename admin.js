import { createHmac, timingSafeEqual } from "node:crypto";

export { hashPassword, verifyPassword } from "./hosts.js";

/**
 * The admin console's door.
 *
 * This used to be one shared passcode held in Render's environment, compared
 * against and exchanged for a bearer token that said only "somebody typed the
 * passcode". It is now a table of accounts (`supabase/admins.sql`) and a token
 * that names *which* admin is calling, which is what lets a route ask whether
 * this particular person may create another one.
 *
 * The passcode has not gone; it has narrowed to the one job accounts cannot do
 * for themselves. See "Bootstrap" below.
 *
 * The password hashing is `hosts.js`'s, re-exported rather than reimplemented.
 * Two scrypt functions in one service is two things to re-parameterise, two
 * places for a subtle difference in salt handling to hide, and no benefit — the
 * threat model for an admin digest and a host digest is identical.
 *
 * Three properties are non-negotiable, and each cost something to keep:
 *
 *   - **The token is signed, subject-bearing and expiring.** A bearer header
 *     that merely asserts an id is not a session; it is a suggestion the client
 *     is free to rewrite.
 *   - **Authority is re-read from the database on every request**, never
 *     carried in the token. A role baked into a token is a role that keeps
 *     working after you revoke it — a suspended admin would hold a valid
 *     session for up to eight more hours.
 *   - **A password change invalidates every existing session.** That is the
 *     only thing that makes "change my password" a *response* to a compromise
 *     rather than a note about one.
 */

/** Eight hours — a working day, and short enough that a stale tab re-asks. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Bootstrap sessions are minutes, not hours. The window only has to be long
 * enough to fill in one form, and it is the last moment at which a shared
 * environment secret can do anything at all.
 */
const BOOTSTRAP_TTL_MS = 15 * 60 * 1000;

/** The literal subject of a bootstrap token. A uuid can never collide with it. */
const BOOTSTRAP_SUBJECT = "bootstrap";

const passcode = () => process.env.ADMIN_PASSCODE || "";

// Falls back to the passcode so a half-configured env still signs tokens with
// *something* secret rather than with a constant.
const secret = () => process.env.AUTH_SECRET || passcode();

/**
 * Whether the service can run a console at all.
 *
 * True once there is anything to sign tokens with. Note what this no longer
 * means: it is not "the passcode is set", because the passcode is no longer the
 * credential. A deployment with accounts and no passcode is fully operational —
 * it simply has no bootstrap door left open, which is the desired end state.
 */
export function isAdminEnabled() {
  return secret().length > 0;
}

/** Whether the environment still carries a passcode to bootstrap with. */
export function isBootstrapPasscodeSet() {
  return passcode().length > 0;
}

// ---------------------------------------------------------------------------
// Passcode
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison. `a === b` short-circuits at the first differing
 * byte, which turns response latency into an oracle that leaks the secret a
 * character at a time. Lengths are compared through the HMAC so even that does
 * not leak.
 */
function safeEqual(a, b) {
  const key = secret();
  const ha = createHmac("sha256", key).update(String(a)).digest();
  const hb = createHmac("sha256", key).update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** Verifies the bootstrap passcode. Unset means "no", never "anything works". */
export function verifyPasscode(input) {
  const expected = passcode();
  if (!expected) return false;
  return safeEqual(input, expected);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function sign(payload) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function mint(subject, ttl, now) {
  const payload = `${subject}.${now}.${now + ttl}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Reads a token back: verifies the signature, then the clock.
 *
 * Signature first, always. An expired-but-authentic token and an outright
 * forgery should take the same time to reject and return the same nothing;
 * checking the clock first would let a forger learn that their signature was
 * the part that failed.
 */
function open(token, now) {
  if (!token || !isAdminEnabled()) return null;

  const cut = token.lastIndexOf(".");
  if (cut <= 0) return null;

  const payload = token.slice(0, cut);
  const signature = token.slice(cut + 1);
  const expected = sign(payload);

  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  const parts = payload.split(".");
  if (parts.length !== 3) return null;

  const [subject, issued, expires] = parts;
  const issuedAt = Number(issued);
  const expiresAt = Number(expires);

  if (!subject) return null;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= now) return null;

  return { subject, issuedAt };
}

/** Mints an admin session token: `<adminId>.<issuedAt>.<expiry>.<signature>`. */
export function issueAdminToken(adminId, now = Date.now()) {
  return mint(adminId, SESSION_TTL_MS, now);
}

/**
 * The admin id a token vouches for and when it was minted, or null.
 *
 * The issue time is returned rather than discarded because the caller has to
 * compare it against `password_changed_at` — this module cannot do that itself
 * without a database handle, and giving it one would put an I/O dependency in
 * the middle of the only code here that must stay trivially auditable.
 */
export function adminFromToken(token, now = Date.now()) {
  const opened = open(token, now);
  if (!opened || opened.subject === BOOTSTRAP_SUBJECT) return null;
  return { id: opened.subject, issuedAt: opened.issuedAt };
}

/** Mints the short-lived token the passcode buys. */
export function issueBootstrapToken(now = Date.now()) {
  return mint(BOOTSTRAP_SUBJECT, BOOTSTRAP_TTL_MS, now);
}

/**
 * True for a live bootstrap token, and only for one.
 *
 * Kept a separate function from {@link adminFromToken} rather than a flag on a
 * shared return, because the two authorise entirely different things and the
 * cost of confusing them is a permanent shared-secret backdoor into every
 * admin route.
 */
export function verifyBootstrapToken(token, now = Date.now()) {
  const opened = open(token, now);
  return Boolean(opened && opened.subject === BOOTSTRAP_SUBJECT);
}

/** The bearer token on a request, or "". */
export function bearerToken(req) {
  return (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

// ---------------------------------------------------------------------------
// Account rules
// ---------------------------------------------------------------------------

/**
 * What each role may do, as capabilities rather than a list of routes.
 *
 * Routes change; the question "may this person see money" does not. Naming the
 * capability at each route means adding a fourth role is one line here instead
 * of an audit of every handler — and it makes the grant legible: you can read
 * this table and know exactly what a SESSION_MANAGER can reach.
 *
 *   admins   — create, suspend and delete console accounts
 *   finance  — customers, balances, withdrawals, and every money figure
 *   sessions — start and end broadcasts, and the host roster
 *
 * `finance` is the one that matters. A SESSION_MANAGER runs the promo desk and
 * has no business knowing what the platform holds, what any customer is worth,
 * or what a broadcast collected. Withholding it is the entire point of the
 * role, so it is withheld at the routes and in the payload, never in the UI.
 */
export const CAPABILITIES = {
  SUPER_ADMIN: ["admins", "finance", "sessions"],
  ADMIN: ["finance", "sessions"],
  SESSION_MANAGER: ["sessions"],
};

export const ADMIN_ROLES = Object.keys(CAPABILITIES);

/** Whether a role carries a capability. An unknown role carries none. */
export function roleCan(role, capability) {
  return (CAPABILITIES[role] ?? []).includes(capability);
}

/**
 * Ten, where a promo host's is eight.
 *
 * Not arbitrary: a host password guards one person's broadcast statistics, and
 * an admin password guards every customer's balance and every withdrawal
 * approval. The two should not cost the same to guess.
 */
export const MIN_ADMIN_PASSWORD_LENGTH = 10;

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,22})[a-z0-9]$/;

/**
 * Normalises and checks a username.
 *
 * Lowercased on the way in so the stored value matches what the unique index
 * enforces — otherwise the roster shows `Deon` while the constraint sees `deon`
 * and the two disagree about who exists. The character set excludes whitespace
 * and lookalike punctuation so that two admins cannot end up with names that
 * are indistinguishable in a list someone is scanning for an intruder.
 */
export function normaliseUsername(input) {
  const username = String(input ?? "").trim().toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : null;
}

/** Validates a new admin account and returns the normalised values. */
export function validateAdmin(usernameInput, nameInput, password) {
  const username = normaliseUsername(usernameInput);
  if (!username) {
    return {
      ok: false,
      reason:
        "Username must be 3–24 characters: lowercase letters, numbers, dot, dash or underscore",
    };
  }

  const fullName = String(nameInput ?? "").trim().replace(/\s+/g, " ");
  if (fullName.length < 3 || fullName.length > 60) {
    return { ok: false, reason: "Enter the admin's full name" };
  }

  const check = validatePassword(password);
  if (!check.ok) return check;

  return { ok: true, value: { username, fullName, password: String(password) } };
}

/**
 * The password rule, alone, because changing a password re-runs exactly this
 * check and nothing else — no username, no name.
 */
export function validatePassword(password) {
  if (String(password ?? "").length < MIN_ADMIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`,
    };
  }
  return { ok: true };
}
