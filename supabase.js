import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — the same project the main app talks to.
 *
 * The URL is public information (every browser request to Supabase carries it
 * in plain sight), so it is baked in as a literal exactly as the main repo
 * does, and a `SUPABASE_URL` env var wins where one is set.
 *
 * The service-role key is the opposite: it bypasses row-level security
 * completely and can read and write every user's data. It comes from the
 * environment only (Supabase dashboard → Settings → API), set in Render's
 * dashboard — never committed, even though this repository is private.
 */

const FALLBACK_URL = "https://ztieoirzquejbwikcjzy.supabase.co";

const url = () => process.env.SUPABASE_URL || FALLBACK_URL;
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || "";

/** True when the server has everything it needs to talk to Supabase. */
export function isDbConfigured() {
  return Boolean(url() && serviceRoleKey());
}

let cached = null;

/**
 * The shared service-role client.
 *
 * Returns `null` when unconfigured so callers answer with a clear 503 instead
 * of crashing the route.
 */
export function supabaseAdmin() {
  if (cached) return cached;
  const key = serviceRoleKey();
  if (!url() || !key) return null;

  cached = createClient(url(), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
