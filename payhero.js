import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * PayHero (payhero.co.ke) — M-Pesa STK push.
 *
 * A near-verbatim port of `src/lib/payments/payhero.ts` from the main Meridian
 * repository, with one difference: secrets come from the environment only.
 * This service runs on Render, where env vars are the native way to configure
 * a deployment, so the `secrets.local.json` fallback the main repo carries for
 * env-less hosts has no job here.
 *
 * Deposits work like this:
 *
 *   1. `POST /api/payments/deposit` books a PENDING cash event and calls
 *      {@link stkPush}. PayHero raises the M-Pesa prompt on the customer's
 *      handset.
 *   2. The customer enters their PIN. PayHero POSTs the result to our callback
 *      URL, which settles the event and credits the balance — or marks it
 *      FAILED.
 *
 * The credentials are the API username/password pair from the PayHero
 * dashboard (Settings → API Keys), sent as HTTP Basic auth. They authorise
 * charges against your PayHero account, so they are secrets: this repository
 * must stay private, and the values themselves belong in Render's environment
 * dashboard, never in a commit.
 *
 * `PAYHERO_CHANNEL_ID` is the numeric id of the payment channel (your till /
 * paybill) under Payment Channels → My Payment Channels.
 */

const PAYHERO_ENDPOINT = "https://backend.payhero.co.ke/api/v2/payments";

const username = () => process.env.PAYHERO_USERNAME || "";
const password = () => process.env.PAYHERO_PASSWORD || "";
const channelId = () => Number(process.env.PAYHERO_CHANNEL_ID) || 0;

export function isPayHeroConfigured() {
  return Boolean(username() && password() && channelId());
}

function basicAuth() {
  return `Basic ${Buffer.from(`${username()}:${password()}`).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Callback URL signing
// ---------------------------------------------------------------------------

/**
 * The callback endpoint is necessarily unauthenticated — PayHero is the
 * caller — but it must not be *forgeable*: a customer knows their own pending
 * event id (RLS lets them read their row), and an unsigned callback would let
 * them "confirm" a deposit they never paid. So the URL we hand PayHero carries
 * an HMAC of the event id under a key no customer holds, and the callback
 * route refuses anything whose signature does not verify.
 */
function callbackKey() {
  return process.env.AUTH_SECRET || password();
}

export function signCallback(eventId) {
  return createHmac("sha256", callbackKey()).update(eventId).digest("base64url");
}

export function verifyCallback(eventId, signature) {
  const expected = Buffer.from(signCallback(eventId));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// STK push
// ---------------------------------------------------------------------------

/**
 * Raises the M-Pesa prompt.
 *
 * `amountKes` is whole shillings — PayHero takes integer KES, which is why the
 * deposit route insists the minor-unit amount divides by 100. The phone goes
 * in normalised `2547XXXXXXXX` form; `reference` is our cash-event id and is
 * what the callback hands back as `ExternalReference`.
 *
 * Resolves `{ ok: true, checkoutId }` or `{ ok: false, error }`.
 */
export async function stkPush({ amountKes, phone, reference, callbackUrl }) {
  let response;
  try {
    response = await fetch(PAYHERO_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basicAuth(),
      },
      body: JSON.stringify({
        amount: amountKes,
        phone_number: phone,
        channel_id: channelId(),
        provider: "m-pesa",
        external_reference: reference,
        callback_url: callbackUrl,
      }),
      // A hung payment gateway must not hold the route open indefinitely.
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Could not reach the payment provider" };
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.success === false) {
    return {
      ok: false,
      error:
        body.error_message ??
        body.message ??
        `Payment provider refused the request (${response.status})`,
    };
  }

  return { ok: true, checkoutId: body.CheckoutRequestID ?? null };
}

// ---------------------------------------------------------------------------
// Callback payload
// ---------------------------------------------------------------------------

/** Whether a callback payload reports a completed payment. */
export function callbackSucceeded(payload) {
  const inner = payload?.response;
  return Boolean(
    inner && (inner.ResultCode === 0 || inner.Status === "Success"),
  );
}
