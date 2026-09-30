/**
 * Market news from Finnhub.
 *
 * The key lives here and never reaches a browser. Responses are cached per
 * category for five minutes: the free tier allows 60 calls a minute across
 * every visitor, and news does not move faster than that anyway.
 */

const apiKey = () => process.env.FINNHUB_API_KEY || "";

export function isNewsConfigured() {
  return Boolean(apiKey());
}

export const NEWS_CATEGORIES = new Set(["crypto", "general", "forex"]);

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

/** Only the fields the page renders, and only http(s) links. */
function toArticle(item) {
  const safe = (url) => (typeof url === "string" && /^https?:\/\//i.test(url) ? url : null);
  const url = safe(item.url);
  if (!url || !item.headline) return null;
  return {
    id: String(item.id ?? url),
    headline: String(item.headline).slice(0, 300),
    summary: String(item.summary ?? "").slice(0, 600),
    source: String(item.source ?? "").slice(0, 80),
    url,
    image: safe(item.image),
    publishedAt: Number(item.datetime) ? Number(item.datetime) * 1000 : null,
  };
}

export async function fetchNews(category) {
  const hit = cache.get(category);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.articles;

  const url = `https://finnhub.io/api/v1/news?category=${encodeURIComponent(category)}&token=${encodeURIComponent(apiKey())}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    // Serve the last good copy rather than an error when the provider blips.
    if (hit) return hit.articles;
    throw new Error(`Finnhub answered ${response.status}`);
  }

  const body = await response.json();
  const articles = (Array.isArray(body) ? body : [])
    .map(toArticle)
    .filter(Boolean)
    .slice(0, 40);

  cache.set(category, { at: Date.now(), articles });
  return articles;
}

/** A one-quote probe: proves the key without spending the news cache. */
export async function newsStatus() {
  if (!isNewsConfigured()) return { ok: false, detail: "Not configured" };
  const response = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=BINANCE:BTCUSDT&token=${encodeURIComponent(apiKey())}`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: "Key refused" };
  }
  if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
  const body = await response.json().catch(() => null);
  return { ok: true, detail: body?.c ? `BTC ${Number(body.c).toLocaleString("en-US")}` : "Reachable" };
}
