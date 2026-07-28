/**
 * Phone identity and account validation — a port of `src/lib/phone.ts` from
 * the main Meridian repository. The rules must match exactly: the browser
 * form runs its copy for instant feedback, and this copy is the one whose
 * verdict counts.
 */

/**
 * Normalises a Kenyan mobile number to `2547XXXXXXXX` / `2541XXXXXXXX`.
 * Returns null if it is not a valid Safaricom/Airtel-range mobile number.
 */
export function normalisePhone(input) {
  const digits = input.replace(/[^\d]/g, "");

  let national;
  if (digits.startsWith("254")) national = digits.slice(3);
  else if (digits.startsWith("0")) national = digits.slice(1);
  else national = digits;

  // Kenyan mobile numbers are 9 digits nationally and begin 7 or 1.
  if (!/^[71]\d{8}$/.test(national)) return null;
  return `254${national}`;
}

/**
 * The number carried as a Supabase Auth email identity. `.invalid` is the
 * RFC 2606 reserved TLD — guaranteed never to resolve, so a stray mail can
 * never reach a real inbox. Must match the main app's `IDENTITY_DOMAIN`.
 */
const IDENTITY_DOMAIN = "meridian.invalid";

export function identityEmail(normalisedPhone) {
  return `${normalisedPhone}@${IDENTITY_DOMAIN}`;
}

export const MIN_PASSWORD_LENGTH = 8;
export const MIN_USERNAME_LENGTH = 2;
export const MAX_USERNAME_LENGTH = 24;

/**
 * The one definition of "is this a valid sign-up". Returns the *normalised*
 * values on success, so a caller can never accidentally store raw input.
 */
export function validateRegistration(phoneInput, usernameInput, password) {
  const phone = normalisePhone(phoneInput);
  if (!phone) return { ok: false, reason: "Enter a valid Kenyan mobile number" };

  const username = usernameInput.trim();
  if (username.length < MIN_USERNAME_LENGTH) {
    return {
      ok: false,
      reason: `Username must be at least ${MIN_USERNAME_LENGTH} characters`,
    };
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    return {
      ok: false,
      reason: `Username must be at most ${MAX_USERNAME_LENGTH} characters`,
    };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }

  return { ok: true, value: { phone, username, password } };
}
