import { supabaseAdmin } from "./supabase.js";

/**
 * The demo M-Pesa wallets — a port of `src/lib/server/mpesaWallet.ts` from the
 * main Venti repository. Both copies drive the same Supabase tables
 * (`mpesa_demo_wallet`, `mpesa_demo_tx`, see `supabase/mpesa-demo.sql` there),
 * which is the whole point: the terminal may be running on a laptop or on the
 * deployed site, and the handset must see the same balance either way.
 *
 * Each VIP has their own wallet. The admin assigns a PIN and an opening balance
 * from the console; the customer types that PIN into the M-Pesa clone once and
 * the handset keeps the `device_token` it is given from then on.
 *
 * It is a **presentation rail and nothing else** — it touches no PayHero
 * credential and moves no real money. Real cash moves only on the Standard
 * path: a genuine STK push settled by the callback.
 */

/** Newest first, and only as long as any statement screen will show. */
const MAX_HISTORY = 60;

const TX_COLUMNS =
  "id, kind, title, subtitle, amount_minor, balance_after_minor, reference, created_at";

function toTx(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    subtitle: row.subtitle,
    amountMinor: Number(row.amount_minor),
    balanceAfterMinor: Number(row.balance_after_minor),
    reference: row.reference,
    at: row.created_at,
  };
}

/** Thrown when the phone cannot cover a debit; routes map it to a 400. */
export class InsufficientDemoFunds extends Error {
  constructor() {
    super("INSUFFICIENT_FUNDS");
    this.name = "InsufficientDemoFunds";
  }
}

/** Thrown when the account has no wallet — the admin has not set one up. */
export class NoDemoWallet extends Error {
  constructor() {
    super(
      "No M-PESA demo wallet for this account. An admin sets the PIN and opening balance in the console.",
    );
    this.name = "NoDemoWallet";
  }
}

const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** An M-Pesa-shaped receipt, e.g. `TIL4KX92MB`. */
export function demoReference() {
  let out = "T";
  for (let i = 0; i < 9; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

function db() {
  const client = supabaseAdmin();
  if (!client) throw new Error("Supabase is not configured");
  return client;
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

/**
 * Exchanges a PIN for the wallet it opens, or null when none does.
 *
 * The caller must not distinguish "wrong PIN" from "no such PIN" in what it
 * sends back — one answer for both is what stops the handset being used to
 * enumerate which PINs have been issued.
 */
export async function linkDemoWallet(pin) {
  if (!/^\d{4}$/.test(pin)) return null;

  const { data, error } = await db().rpc("mpesa_demo_link", { p_pin: pin });
  if (error) throw new Error(error.message);
  return data ?? null;
}

/** The wallet a handset's device token identifies, or null when unknown. */
export async function walletByToken(token) {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;

  const { data, error } = await db().rpc("mpesa_demo_by_token", { p_token: token });
  if (error) throw new Error(error.message);
  return data ?? null;
}

/**
 * Resolves the handset's device token to the wallet it may act on.
 *
 * Returns either `{ wallet }` or `{ status, error }` for the route to send
 * back. The token is the phone's whole identity: it was issued when the
 * admin-assigned PIN was accepted, and it scopes every read and every agent
 * withdrawal to that one wallet.
 */
export async function requireHandset(req) {
  const token =
    (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") ||
    (typeof req.query?.token === "string" ? req.query.token : "") ||
    "";

  if (!token) {
    return { status: 401, error: "This phone is not linked yet.", code: "NOT_LINKED" };
  }

  let wallet;
  try {
    wallet = await walletByToken(token);
  } catch (cause) {
    return { status: 503, error: cause.message };
  }

  if (!wallet) {
    // The admin cleared the wallet, or this token belongs to a project the
    // phone is no longer pointed at. Either way it must re-link.
    return { status: 401, error: "This phone is no longer linked.", code: "NOT_LINKED" };
  }

  return { wallet };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function statement(userId) {
  const { data } = await db()
    .from("mpesa_demo_tx")
    .select(TX_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY);

  return (data ?? []).map(toTx);
}

/** One VIP's wallet as it stands, with their recent statement. */
export async function readDemoWallet(userId) {
  const [{ data: wallet }, transactions] = await Promise.all([
    db()
      .from("mpesa_demo_wallet")
      .select("balance_minor")
      .eq("user_id", userId)
      .maybeSingle(),
    statement(userId),
  ]);

  if (!wallet) throw new NoDemoWallet();

  return { balanceMinor: Number(wallet.balance_minor), transactions };
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/**
 * Applies one movement and returns the wallet as it stands afterwards.
 *
 * The balance change and the statement line are one SQL function under a row
 * lock — see `mpesa_demo_move`. Two movements landing together (the terminal
 * depositing while the phone withdraws) serialise there rather than racing.
 */
export async function moveDemoFunds(movement) {
  const amount = Math.round(movement.amountMinor);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("BAD_AMOUNT");

  const { data, error } = await db().rpc("mpesa_demo_move", {
    p_user: movement.userId,
    p_kind: movement.kind,
    p_amount: amount,
    p_direction: movement.direction,
    p_title: movement.title,
    p_subtitle: movement.subtitle ?? "",
    p_reference: movement.reference ?? demoReference(),
  });

  if (error) {
    if (error.message.includes("INSUFFICIENT_FUNDS")) throw new InsufficientDemoFunds();
    if (error.message.includes("NO_WALLET")) throw new NoDemoWallet();
    throw new Error(error.message);
  }

  return {
    state: {
      balanceMinor: Number(data.balanceMinor),
      // Re-read rather than appended to locally, so what comes back reflects
      // anything the phone booked while this movement was in flight.
      transactions: await statement(movement.userId),
    },
    tx: toTx(data.tx),
  };
}

/** Puts one phone back to a chosen balance with an empty statement. */
export async function resetDemoWallet(userId, balanceMinor) {
  const { data, error } = await db().rpc("mpesa_demo_reset", {
    p_user: userId,
    p_balance: balanceMinor ?? null,
  });

  if (error) {
    if (error.message.includes("NO_WALLET")) throw new NoDemoWallet();
    throw new Error(error.message);
  }

  return { balanceMinor: Number(data), transactions: [] };
}

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

/**
 * Verifies the bearer token and that the account is on the VIP tier.
 *
 * The tier is read from `profiles` server-side, never taken from the request,
 * so a Standard account cannot ask for the demo rail and a customer cannot
 * promote themselves into it. Returns either the caller or the failure to send
 * back — callers write `if (gate.error) return res.status(gate.status)…`.
 */
export async function requireVipCaller(req) {
  const client = supabaseAdmin();
  if (!client) {
    return {
      status: 503,
      error: "Demo rail unavailable — Supabase is not configured.",
    };
  }

  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return { status: 401, error: "Not signed in" };

  const { data: auth, error } = await client.auth.getUser(token);
  if (error || !auth.user) return { status: 401, error: "Not signed in" };

  const { data: profile } = await client
    .from("profiles")
    .select("phone, username, live_tier")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (!profile) return { status: 400, error: "No profile for this account" };
  if (profile.live_tier !== "VIP") {
    return {
      status: 403,
      error: "The M-Pesa demo rail is available to VIP accounts only.",
    };
  }

  return {
    caller: {
      db: client,
      userId: auth.user.id,
      phone: profile.phone ?? "",
      username: profile.username ?? null,
    },
  };
}

/** Parses `amountMinor` from a parsed body, in whole shillings. */
export function readAmountMinor(body, minimumMinor) {
  if (!body) return { error: "Malformed request body", status: 400 };

  const amountMinor = Math.round(Number(body.amountMinor));
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    return { error: "Enter an amount", status: 400 };
  }
  if (amountMinor < minimumMinor) {
    return {
      error: `Minimum is KSh ${(minimumMinor / 100).toLocaleString()}`,
      status: 400,
    };
  }
  if (amountMinor % 100 !== 0) {
    return { error: "Use whole shillings", status: 400 };
  }

  return { amountMinor };
}

// ---------------------------------------------------------------------------
// Display helpers for the handset
// ---------------------------------------------------------------------------

/**
 * `254702248984` -> `0702248984`.
 *
 * Profiles store the number in the international form the payment provider
 * needs; the handset shows the local one its owner would recognise.
 */
export function localPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return `0${digits.slice(3)}`;
  return phone;
}

/** "Deon Orina" -> first/last/DO; a single word gets a blank surname. */
export function splitName(username, phone) {
  const cleaned = (username ?? "").trim();
  if (!cleaned) {
    return { firstName: "M-PESA", lastName: "Customer", initials: phone.slice(-2) };
  }

  const parts = cleaned.split(/\s+/);
  const firstName = parts[0] ?? "";
  const lastName = parts.slice(1).join(" ");
  const initials = (
    (firstName[0] ?? "") + (lastName[0] ?? firstName[1] ?? "")
  ).toUpperCase();

  return { firstName, lastName, initials };
}
