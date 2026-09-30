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

export function isSmsSandbox() {
  return username() === "sandbox";
}

const host = () =>
  isSmsSandbox() ? "https://api.sandbox.africastalking.com" : "https://api.africastalking.com";

/**
 * Sends one text. Resolves to what happened — never throws — so a caller that
 * wants to show the provider's answer (the admin test) can, and one that does
 * not (a deposit) can ignore it.
 */
export async function sendSms(phone, message) {
  if (!isSmsConfigured()) {
    console.info(`[sms] not configured; would have sent to +${phone}: ${message}`);
    return { sent: false, reason: "Africa's Talking is not configured" };
  }

  const form = new URLSearchParams({ username: username(), to: `+${phone}`, message });
  if (senderId()) form.set("from", senderId());

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
    const recipient = body?.SMSMessageData?.Recipients?.[0] ?? null;
    const ok = response.ok && (recipient?.statusCode === 100 || recipient?.statusCode === 101 || recipient?.status === "Success");

    if (ok) console.info(`[sms] sent to +${phone} (${recipient?.messageId ?? "no id"})`);
    else console.warn(`[sms] refused for +${phone}: ${recipient?.status ?? body?.SMSMessageData?.Message ?? response.status}`);

    return {
      sent: ok,
      reason: ok ? null : String(recipient?.status ?? body?.SMSMessageData?.Message ?? `HTTP ${response.status}`),
      provider: body?.SMSMessageData ?? null,
    };
  } catch (cause) {
    console.warn(`[sms] could not reach Africa's Talking: ${cause?.message}`);
    return { sent: false, reason: "Could not reach Africa's Talking" };
  }
}

/**
 * The account's wallet balance at Africa's Talking — a real liveness check,
 * since it proves the credentials as well as the connection.
 */
export async function smsAccountBalance() {
  if (!isSmsConfigured()) return { ok: false, detail: "Not configured" };
  const response = await fetch(`${host()}/version1/user?username=${encodeURIComponent(username())}`, {
    headers: { apiKey: apiKey(), Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
  return { ok: true, detail: `Balance ${body?.UserData?.balance ?? "unknown"}` };
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

/** The exact text a VIP receives. Pure, so the console can preview it. */
export function composeSms({ kind, brand, phone, reference, amountMinor, balanceMinor }) {
  const { day, time } = when();
  return kind === "DEPOSIT"
    ? `${reference} Confirmed. Ksh${money(amountMinor)} sent to ${brand} for account ${phone} on ${day} at ${time}. New M-PESA balance is Ksh${money(balanceMinor)}. Transaction cost, Ksh0.00.`
    : `${reference} Confirmed. You have received Ksh${money(amountMinor)} from ${brand} on ${day} at ${time}. New M-PESA balance is Ksh${money(balanceMinor)}.`;
}

export async function brandForSite(siteId) {
  const sites = await listSites();
  const site = sites.find((s) => s.id === siteId) ?? sites[0];
  return String(site?.name ?? "Venti").toUpperCase();
}

async function brandFor(db, userId) {
  const { data } = await db.from("profiles").select("site").eq("id", userId).maybeSingle();
  return brandForSite(data?.site);
}

function notify(kind, { db, userId, phone, reference, amountMinor, balanceMinor }) {
  void (async () => {
    const brand = await brandFor(db, userId);
    await sendSms(phone, composeSms({ kind, brand, phone, reference, amountMinor, balanceMinor }));
  })().catch((cause) => console.warn(`[sms] ${kind.toLowerCase()} text failed: ${cause?.message}`));
}

/** Money left the handset for the trading account. Fire-and-forget. */
export const smsDeposit = (input) => notify("DEPOSIT", input);

/** Money arrived on the handset from the trading account. Fire-and-forget. */
export const smsWithdrawal = (input) => notify("WITHDRAWAL", input);
