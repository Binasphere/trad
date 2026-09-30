/**
 * M-PESA-style confirmation texts for the VIP demo rail, via Africa's Talking.
 *
 * A VIP deposit or withdrawal moves money on the demo handset (the M-PESA
 * clone app), not on Safaricom — so no real confirmation SMS arrives. This
 * sends one that reads like it, quoting the handset's own new balance, to the
 * customer's registered number.
 *
 * Configuration (Render → Environment):
 *   AT_USERNAME   Africa's Talking app username ("sandbox" for the sandbox)
 *   AT_API_KEY    the app's API key
 *   AT_SENDER_ID  optional alphanumeric sender id / short code
 *
 * Unconfigured, every send is a logged no-op: the deposit or withdrawal itself
 * never waits on, or fails because of, a text message.
 */

import { listSites } from "./sites.js";

const username = () => process.env.AT_USERNAME || "";
const apiKey = () => process.env.AT_API_KEY || "";
const senderId = () => process.env.AT_SENDER_ID || "";

export function isSmsConfigured() {
  return Boolean(username() && apiKey());
}

function endpoint() {
  return username() === "sandbox"
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
}

async function send(phone, message) {
  if (!isSmsConfigured()) {
    console.info("[sms] not configured; would have sent:", message);
    return;
  }

  const form = new URLSearchParams({
    username: username(),
    to: `+${phone}`,
    message,
  });
  if (senderId()) form.set("from", senderId());

  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      apiKey: apiKey(),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    console.warn(`[sms] Africa's Talking answered ${response.status}`);
  }
}

// --- Formatting, the way the real texts read ---------------------------------

const money = (minor) =>
  (Number(minor) / 100).toLocaleString("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function when(date = new Date()) {
  // Nairobi time, whatever timezone the server runs in.
  const parts = new Intl.DateTimeFormat("en-KE", {
    timeZone: "Africa/Nairobi",
    day: "numeric",
    month: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: `${get("day")}/${get("month")}/${get("year")}`,
    time: `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`,
  };
}

async function brandFor(db, userId) {
  const { data } = await db.from("profiles").select("site").eq("id", userId).maybeSingle();
  const sites = await listSites();
  const site = sites.find((s) => s.id === data?.site) ?? sites[0];
  return String(site?.name ?? "Venti").toUpperCase();
}

/**
 * Money left the handset for the trading account.
 * Fire-and-forget: callers do not await it.
 */
export function smsDeposit({ db, userId, phone, reference, amountMinor, balanceMinor }) {
  void (async () => {
    const brand = await brandFor(db, userId);
    const { day, time } = when();
    await send(
      phone,
      `${reference} Confirmed. Ksh${money(amountMinor)} sent to ${brand} for account ${phone} on ${day} at ${time}. New M-PESA balance is Ksh${money(balanceMinor)}. Transaction cost, Ksh0.00.`,
    );
  })().catch((cause) => console.warn("[sms] deposit text failed:", cause?.message));
}

/** Money arrived on the handset from the trading account. */
export function smsWithdrawal({ db, userId, phone, reference, amountMinor, balanceMinor }) {
  void (async () => {
    const brand = await brandFor(db, userId);
    const { day, time } = when();
    await send(
      phone,
      `${reference} Confirmed. You have received Ksh${money(amountMinor)} from ${brand} on ${day} at ${time}. New M-PESA balance is Ksh${money(balanceMinor)}.`,
    );
  })().catch((cause) => console.warn("[sms] withdrawal text failed:", cause?.message));
}
