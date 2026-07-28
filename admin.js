import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The admin console's door — a port of the main repo's `lib/admin/session.ts`
 * with one deliberate change of carrier.
 *
 * The original exchanged the passcode for an HMAC-signed token in an httpOnly
 * `SameSite=strict` cookie. That worked when the console and its API shared an
 * origin; they no longer do — the console is served from the app's domain and
 * this API lives on Render — and a strict cookie is never sent cross-site
 * (Safari would refuse even a lax one). So the *same* signed token now rides
 * an `Authorization: Bearer` header, held by the console in sessionStorage.
 * What is given up: an XSS on the app's origin could read the token for its
 * remaining lifetime. What is kept: forgery is still impossible, expiry is
 * still enforced server-side, and the passcode itself is never stored.
 *
 * Two properties are non-negotiable even at this size:
 *
 *   - No default passcode. Unset means the console is *off*, not open.
 *   - The token is signed and expiring. A bare `admin=true` header is not a
 *     session; it is a suggestion the client is free to forge.
 */

/** Eight hours — a working day, and short enough that a stale tab re-asks. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const passcode = () => process.env.ADMIN_PASSCODE || "";

// Falls back to the passcode so a half-configured env still signs tokens with
// *something* secret rather than with a constant.
const secret = () => process.env.AUTH_SECRET || passcode();

/** True when a passcode has been set. When false, admin serves nothing. */
export function isAdminEnabled() {
  return passcode().length > 0;
}

/**
 * Constant-time comparison. `a === b` short-circuits at the first differing
 * byte, which turns response latency into an oracle that leaks the passcode a
 * character at a time. Lengths are compared through the HMAC so even that
 * does not leak.
 */
function safeEqual(a, b) {
  const key = secret();
  const ha = createHmac("sha256", key).update(a).digest();
  const hb = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Verifies a submitted passcode. */
export function verifyPasscode(input) {
  const expected = passcode();
  if (!expected) return false;
  return safeEqual(input, expected);
}

function sign(payload) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Mints a session token: `<expiry>.<signature>`. */
export function issueToken(now = Date.now()) {
  const expiry = String(now + SESSION_TTL_MS);
  return `${expiry}.${sign(expiry)}`;
}

/** Validates a session token: well-formed, correctly signed, unexpired. */
export function verifyToken(token, now = Date.now()) {
  if (!token || !isAdminEnabled()) return false;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;

  const expiry = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  // Signature first: an expired-but-authentic token and a forged one should
  // be indistinguishable in how long they take to reject.
  if (!safeEqual(signature, sign(expiry))) return false;

  const expiresAt = Number(expiry);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** The bearer token on a request, or "". */
export function bearerToken(req) {
  return (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}
