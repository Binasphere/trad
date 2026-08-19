import { supabaseAdmin } from "./supabase.js";

/**
 * Which product a request belongs to.
 *
 * One build is served on more than one domain, so nothing in the code can say
 * which product a caller is using — only the request can. The `Origin` header
 * is the answer: the browser sets it, the browser cannot lie about it (it is on
 * the forbidden-header list, so page script cannot forge it), and it is already
 * present on every cross-origin call this service receives, which is all of
 * them.
 *
 * An unrecognised origin resolves to the **primary** site rather than being
 * rejected. That is a deliberate choice about which way to fail: a customer on
 * an origin nobody has registered yet — a preview deploy, a new domain added to
 * Vercel before this table was updated — should land on the product that
 * predates the split rather than have their sign-up refused. The cost is that a
 * misconfigured domain silently pools into the primary site, which is why
 * `resolveSite` is the only place that decision is made and why it is logged
 * once per unknown origin.
 */

/** How long the sites table is trusted before it is re-read. */
const CACHE_MS = 5 * 60 * 1000;

/**
 * The list that ships in the code, used until the database answers and if it
 * never does. It must stay in step with the seed rows in `supabase/sites.sql`;
 * the database is the authority, this is the floor.
 */
const FALLBACK_SITES = [
  { id: "venti", origin: "https://ventitradingfx.com", name: "Venti", is_primary: true },
  { id: "candix", origin: "https://candixfx.com", name: "Candix FX", is_primary: false },
  { id: "barsfx", origin: "https://barsfx.com", name: "Bars FX", is_primary: false },
];

let cache = { at: 0, sites: FALLBACK_SITES };
const warned = new Set();

/** Normalises an origin for comparison: no trailing slash, lowercased host. */
function canonical(value) {
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Every site, newest read cached for five minutes.
 *
 * Never throws and never returns empty: a database that is down must not take
 * sign-ups down with it, and every caller here is on a path where "which
 * product is this" has to have an answer.
 */
export async function listSites() {
  if (Date.now() - cache.at < CACHE_MS) return cache.sites;

  const db = supabaseAdmin();
  if (!db) return cache.sites;

  const { data, error } = await db
    .from("sites")
    .select("id, origin, name, is_primary")
    .order("is_primary", { ascending: false });

  if (error || !data?.length) return cache.sites;

  cache = { at: Date.now(), sites: data };
  return data;
}

/** The primary site's id — what anything unattributed belongs to. */
export async function primarySiteId() {
  const sites = await listSites();
  return (sites.find((site) => site.is_primary) ?? sites[0]).id;
}

/**
 * The site a request came from.
 *
 * `Origin` first; `Referer` only as a fallback, because a handful of privacy
 * setups strip Origin on same-site navigations. Neither is trusted for
 * *authorisation* anywhere in this service — it decides which product a new
 * account belongs to, never what an existing caller may do.
 */
export async function resolveSite(req) {
  const sites = await listSites();
  const primary = (sites.find((site) => site.is_primary) ?? sites[0]).id;

  const candidate =
    canonical(req.headers.origin) || canonical(req.headers.referer);

  if (!candidate) return primary;

  const match = sites.find((site) => canonical(site.origin) === candidate);
  if (match) return match.id;

  // Once per origin per process. A domain that is genuinely misconfigured
  // should be visible in the logs without every request from it adding a line.
  if (!warned.has(candidate)) {
    warned.add(candidate);
    console.warn(
      `[sites] unknown origin ${candidate} — attributing to '${primary}'. Add it to public.sites if this is a real domain.`,
    );
  }
  return primary;
}

/** True when `id` names a site. Used to validate an admin's `?site=` filter. */
export async function isSiteId(id) {
  if (!id) return false;
  const sites = await listSites();
  return sites.some((site) => site.id === id);
}

/** Drops the cache. Called after a write so the next read is fresh. */
export function forgetSites() {
  cache = { at: 0, sites: cache.sites };
}
