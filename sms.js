/**
 * VENTI SMS NOTIFICATIONS
 * ========================
 *
 * M-PESA-style transaction confirmation texts for the Venti demo rail,
 * sent through Africa's Talking.
 *
 * IMPORTANT:
 * - The underlying deposit/withdrawal transaction is unchanged.
 * - This file only generates and sends the notification SMS.
 * - Existing callers of smsDeposit() and smsWithdrawal() remain unchanged.
 * - SMS failures never cause the underlying transaction to fail.
 *
 * Configuration (Render → Environment):
 *
 *   AT_USERNAME   Africa's Talking app username
 *   AT_API_KEY    Africa's Talking API key
 *   AT_SENDER_ID  Optional alphanumeric sender ID / shortcode
 *   SMS_DAILY_LIMIT_KES  Optional, e.g. 489800. When set, the texts add
 *                 "Amount you can transact within the day is Ksh…".
 *   SMS_LINK      Optional link. When set, the texts end with
 *                 "Sell all your balances now <SMS_LINK>".
 *
 * Example withdrawal SMS:
 *
 * U88D05EC06C Confirmed. You have received Ksh1,290.00 from VENTI on
 * 28/09/26 at 5:58 AM. New M-PESA balance is Ksh265,355.00.
 * Amount you can transact within the day is Ksh489,800.00.
 * Sell all your balances now https://venti.example
 */

import { listSites } from "./sites.js";


// ============================================================================
// AFRICA'S TALKING CONFIGURATION
// ============================================================================

const username = () => process.env.AT_USERNAME || "";
const apiKey = () => process.env.AT_API_KEY || "";
const senderId = () => process.env.AT_SENDER_ID || "";

export function isSmsConfigured() {
  return Boolean(username() && apiKey());
}

export function isSmsSandbox() {
  return username() === "sandbox";
}

const host = () =>
  isSmsSandbox()
    ? "https://api.sandbox.africastalking.com"
    : "https://api.africastalking.com";


// ============================================================================
// SEND SMS
// ============================================================================

/**
 * Sends one SMS through Africa's Talking.
 *
 * Resolves to the provider result and never throws.
 *
 * This means a deposit or withdrawal does NOT fail simply because
 * Africa's Talking is unavailable.
 */
export async function sendSms(phone, message) {
  if (!isSmsConfigured()) {
    console.info(
      `[sms] not configured; would have sent to +${phone}: ${message}`
    );

    return {
      sent: false,
      reason: "Africa's Talking is not configured",
    };
  }

  const form = new URLSearchParams({
    username: username(),
    to: `+${phone}`,
    message,
  });

  if (senderId()) {
    form.set("from", senderId());
  }

  try {
    const response = await fetch(`${host()}/version1/messaging`, {
      method: "POST",
      headers: {
        apiKey: apiKey(),
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });

    const body = await response.json().catch(() => null);

    const recipient =
      body?.SMSMessageData?.Recipients?.[0] ?? null;

    const ok =
      response.ok &&
      (
        recipient?.statusCode === 100 ||
        recipient?.statusCode === 101 ||
        recipient?.statusCode === 102 || // queued — accepted, not refused
        recipient?.status === "Success"
      );

    if (ok) {
      console.info(
        `[sms] sent to +${phone} (${recipient?.messageId ?? "no id"})`
      );
    } else {
      console.warn(
        `[sms] refused for +${phone}: ${
          recipient?.status ??
          body?.SMSMessageData?.Message ??
          response.status
        }`
      );
    }

    return {
      sent: ok,
      reason: ok
        ? null
        : String(
            recipient?.status ??
            body?.SMSMessageData?.Message ??
            `HTTP ${response.status}`
          ),
      provider: body?.SMSMessageData ?? null,
    };
  } catch (cause) {
    console.warn(
      `[sms] could not reach Africa's Talking: ${cause?.message}`
    );

    return {
      sent: false,
      reason: "Could not reach Africa's Talking",
    };
  }
}


// ============================================================================
// AFRICA'S TALKING ACCOUNT BALANCE
// ============================================================================

/**
 * Checks the Africa's Talking account balance.
 *
 * This also acts as a basic credentials/connectivity check.
 */
export async function smsAccountBalance() {
  if (!isSmsConfigured()) {
    return {
      ok: false,
      detail: "Not configured",
    };
  }

  const response = await fetch(
    `${host()}/version1/user?username=${encodeURIComponent(username())}`,
    {
      headers: {
        apiKey: apiKey(),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    }
  );

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      detail: `HTTP ${response.status}`,
    };
  }

  return {
    ok: true,
    detail: `Balance ${body?.UserData?.balance ?? "unknown"}`,
  };
}


// ============================================================================
// CURRENCY FORMATTING
// ============================================================================

/**
 * Converts minor currency units to Kenyan Shillings.
 *
 * Example:
 *
 *   129000 -> "1,290.00"
 *   26535500 -> "265,355.00"
 */
const money = (minor) =>
  (Number(minor) / 100).toLocaleString("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });


// ============================================================================
// DATE / TIME FORMATTING
// ============================================================================

/**
 * Returns the current Nairobi date and time.
 *
 * Example:
 *
 *   day  -> 28/09/26
 *   time -> 5:58 AM
 */
function when(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-KE", {
    timeZone: "Africa/Nairobi",
    day: "numeric",
    month: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);

  const get = (type) =>
    parts.find((p) => p.type === type)?.value ?? "";

  return {
    day: `${get("day")}/${get("month")}/${get("year")}`,
    time: `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`,
  };
}


// ============================================================================
// SMS MESSAGE GENERATION
// ============================================================================
//
// THIS IS THE MAIN SECTION THAT CONTROLS WHAT THE USER RECEIVES.
//
// Existing deposit and withdrawal code does not need to change.
//
// The function keeps the exact same arguments as your original production
// version:
//
//   kind
//   brand
//   phone
//   reference
//   amountMinor
//   balanceMinor
//
// Therefore existing callers continue working.
// ============================================================================

export function composeSms({
  kind,
  brand,
  phone,
  reference,
  amountMinor,
  balanceMinor,
}) {
  const { day, time } = when();

  // The optional tail both texts share: daily limit, then the link.
  const link = (process.env.SMS_LINK || "").trim();
  const tail =
    (dailyLimitMinor() ? ` Amount you can transact within the day is Ksh${money(dailyLimitMinor())}.` : "") +
    (link ? ` Sell all your balances now ${link}` : "");

  // ==========================================================================
  // DEPOSIT SMS
  // ==========================================================================
  //
  // Money has left the user's M-PESA handset for their Venti account, so the
  // balance quoted is the handset's new M-PESA balance.
  //
  // ==========================================================================

  if (kind === "DEPOSIT") {
    return (
      `${reference} Confirmed. ` +
      `Ksh${money(amountMinor)} sent to ${brand} for account ${phone} ` +
      `on ${day} at ${time}. ` +
      `New M-PESA balance is Ksh${money(balanceMinor)}. ` +
      `Transaction cost, Ksh0.00.` +
      tail
    );
  }

  // ==========================================================================
  // WITHDRAWAL SMS
  // ==========================================================================
  //
  // Money has arrived on the user's M-PESA handset from their Venti account.
  //
  // ==========================================================================

  return (
    `${reference} Confirmed. ` +
    `You have received Ksh${money(amountMinor)} from ${brand} ` +
    `on ${day} at ${time}. ` +
    `New M-PESA balance is Ksh${money(balanceMinor)}.` +
    tail
  );
}

/** SMS_DAILY_LIMIT_KES in minor units, or null when unset/invalid. */
function dailyLimitMinor() {
  const kes = Number(process.env.SMS_DAILY_LIMIT_KES);
  return Number.isFinite(kes) && kes > 0 ? Math.round(kes * 100) : null;
}


// ============================================================================
// BRAND RESOLUTION
// ============================================================================

/**
 * Gets the Venti/site brand associated with a site ID.
 */
export async function brandForSite(siteId) {
  const sites = await listSites();

  const site =
    sites.find((s) => s.id === siteId) ??
    sites[0];

  return String(site?.name ?? "Venti").toUpperCase();
}


/**
 * Gets the user's site from their profile and resolves its brand.
 */
async function brandFor(db, userId) {
  const { data } = await db
    .from("profiles")
    .select("site")
    .eq("id", userId)
    .maybeSingle();

  return brandForSite(data?.site);
}


// ============================================================================
// NOTIFICATION HANDLER
// ============================================================================

/**
 * Generates the transaction SMS and sends it asynchronously.
 *
 * The transaction itself does not wait for Africa's Talking.
 */
function notify(
  kind,
  {
    db,
    userId,
    phone,
    reference,
    amountMinor,
    balanceMinor,
  }
) {
  void (async () => {
    const brand = await brandFor(db, userId);

    const message = composeSms({
      kind,
      brand,
      phone,
      reference,
      amountMinor,
      balanceMinor,
    });

    await sendSms(phone, message);
  })().catch((cause) =>
    console.warn(
      `[sms] ${kind.toLowerCase()} text failed: ${cause?.message}`
    )
  );
}


// ============================================================================
// TRANSACTION SMS FUNCTIONS
// ============================================================================

/**
 * DEPOSIT
 *
 * Money has left the M-PESA handset for the user's Venti account.
 *
 * Existing code can continue calling:
 *
 *   smsDeposit(input)
 */
export const smsDeposit = (input) =>
  notify("DEPOSIT", input);


/**
 * WITHDRAWAL
 *
 * Money has arrived on the M-PESA handset from the user's Venti account.
 *
 * Existing code can continue calling:
 *
 *   smsWithdrawal(input)
 */
export const smsWithdrawal = (input) =>
  notify("WITHDRAWAL", input);
