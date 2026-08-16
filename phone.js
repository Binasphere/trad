/**
 * Phone identity and account validation — a port of `src/lib/phone.ts` from
 * the main Venti repository. The rules must match exactly: the browser
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
 * never reach a real inbox.
 *
 * Deliberately still `meridian.invalid` after the rename to Venti, and it must
 * stay byte-identical to `IDENTITY_DOMAIN` in the main app's `src/lib/phone.ts`
 * — this service *creates* the auth user and the browser *signs in* as it. If
 * the two disagree, every account registered here can never sign in there.
 */
const IDENTITY_DOMAIN = "meridian.invalid";

/**
 * The site whose customers keep the untagged address.
 *
 * Every account that existed before the platform was split lives on this one,
 * and their identity is already `254…@meridian.invalid` in `auth.users`. Tagging
 * it now would mean none of them could ever sign in again, so the primary site
 * is defined as "the one with no tag" and stays that way permanently.
 */
const UNTAGGED_SITE = "venti";

/**
 * The address carried as a Supabase Auth identity, for a phone number on a site.
 *
 * Supabase's `auth.users.email` is globally unique, so two products that each
 * let the same person hold an account cannot both derive the same address from
 * a phone number. The site therefore joins the *local part*:
 *
 *     venti   254712345678  ->  254712345678@meridian.invalid
 *     candix  254712345678  ->  candix.254712345678@meridian.invalid
 *
 * The domain is untouched, and must stay untouched — see below.
 *
 * Passing no site yields the untagged form. That is the safe default: every
 * caller that predates the split keeps working and keeps addressing the
 * accounts it already created.
 */
export function identityEmail(normalisedPhone, site = UNTAGGED_SITE) {
  const prefix = !site || site === UNTAGGED_SITE ? "" : `${site}.`;
  return `${prefix}${normalisedPhone}@${IDENTITY_DOMAIN}`;
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
