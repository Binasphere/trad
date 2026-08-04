import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { normalisePhone } from "./phone.js";

/**
 * Promo hosts — the staff who run a TikTok live — and their door.
 *
 * A host is not a customer. They never trade, never hold a balance, and never
 * appear in Supabase Auth: the customer identity is derived from the phone
 * number (`254…@meridian.invalid`), so the same person working the live desk
 * *and* holding an account would collide with themselves. Hosts therefore get
 * their own table and their own credential handling, which is all this module
 * is.
 *
 * The session token is the admin console's scheme with the subject added:
 * `<hostId>.<expiry>.<signature>`, signed with AUTH_SECRET. Same properties —
 * unforgeable, expiring, no server-side session store — and one more, that the
 * token names who it is for, so a route never has to be told which host is
 * calling.
 */

/**
 * A week. Longer than the admin console's eight hours, on purpose: a host signs
 * in on their phone between broadcasts, and a token that has expired by the
 * time the camera is rolling means fumbling a password on air.
 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const secret = () =>
  process.env.AUTH_SECRET || process.env.ADMIN_PASSCODE || "";

/** Hosts can only sign in once the service has something to sign tokens with. */
export function areHostsEnabled() {
  return secret().length > 0;
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * scrypt with the Node defaults (N=16384, r=8, p=1) and a 16-byte random salt.
 *
 * Deliberately not the app's PBKDF2: that one exists to match WebCrypto in a
 * browser without a secure context, a constraint that does not apply on a
 * server. Here the only thing that matters is that a leaked table is expensive
 * to attack, and scrypt's memory hardness buys more of that per millisecond.
 *
 * Stored as `scrypt$<salt-hex>$<hash-hex>` so the scheme is legible in the row
 * and a future re-parameterisation can tell old digests from new ones.
 */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${digest.toString("hex")}`;
}

/** Constant-time verification. Any malformed stored digest is a failed match. */
export function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], "hex");
    expected = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function sign(payload) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Mints a host session token: `<hostId>.<expiry>.<signature>`. */
export function issueHostToken(hostId, now = Date.now()) {
  const payload = `${hostId}.${now + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * The host id a token vouches for, or null.
 *
 * Signature before expiry, so an expired-but-authentic token and a forged one
 * are indistinguishable in how long they take to reject.
 */
export function hostFromToken(token, now = Date.now()) {
  if (!token || !areHostsEnabled()) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expected = sign(payload);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  const divide = payload.lastIndexOf(".");
  if (divide <= 0) return null;

  const expiresAt = Number(payload.slice(divide + 1));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  return payload.slice(0, divide);
}

// ---------------------------------------------------------------------------
// Registration rules
// ---------------------------------------------------------------------------

export const MIN_HOST_PASSWORD_LENGTH = 8;

/**
 * Validates a host sign-up and returns the normalised values.
 *
 * Both names are required. The whole point of the roster is answering "who was
 * live", and a page of first names answers it badly the first time two
 * employees share one.
 */
export function validateHost(nameInput, phoneInput, password) {
  const fullName = String(nameInput ?? "").trim().replace(/\s+/g, " ");
  if (fullName.length < 3 || fullName.length > 60) {
    return { ok: false, reason: "Enter your full name" };
  }
  if (!fullName.includes(" ")) {
    return { ok: false, reason: "Enter both your first and last name" };
  }

  const phone = normalisePhone(String(phoneInput ?? ""));
  if (!phone) {
    return { ok: false, reason: "Enter a valid Kenyan mobile number" };
  }

  if (String(password ?? "").length < MIN_HOST_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: `Password must be at least ${MIN_HOST_PASSWORD_LENGTH} characters`,
    };
  }

  return { ok: true, value: { fullName, phone, password: String(password) } };
}
