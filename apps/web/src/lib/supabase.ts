/**
 * Supabase configuration and connectivity helper for WeTa Snap.
 *
 * To connect your Supabase database:
 * 1. Add your Supabase project URL and Anon key in `apps/web/.env.local`:
 *      VITE_SUPABASE_URL=https://your-project.supabase.co
 *      VITE_SUPABASE_ANON_KEY=your-anon-key
 *      VITE_API_URL=http://localhost:4000   (or your deployed API service URL)
 * 2. In `services/api/.env`, point DATABASE_URL to your Supabase PostgreSQL connection pooler:
 *      DATABASE_URL=postgres://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require
 *      SERVICE_DATABASE_URL=postgres://postgres:[password]@db.[ref].supabase.co:5432/postgres?sslmode=require
 *      DATABASE_SSL=true
 */

const STORAGE_URL_KEY = 'wetasnap-supabase-url';
const STORAGE_KEY_KEY = 'wetasnap-supabase-anon-key';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export function getSupabaseConfig(): SupabaseConfig {
  const env = import.meta.env as Record<string, string | undefined>;
  const url = (
    localStorage.getItem(STORAGE_URL_KEY) ||
    env.VITE_SUPABASE_URL ||
    env.NEXT_PUBLIC_SUPABASE_URL ||
    ''
  ).trim();

  const anonKey = (
    localStorage.getItem(STORAGE_KEY_KEY) ||
    env.VITE_SUPABASE_ANON_KEY ||
    env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ''
  ).trim();

  return { url, anonKey };
}

export function setSupabaseConfig(cfg: { url: string; anonKey: string }): void {
  if (cfg.url.trim()) localStorage.setItem(STORAGE_URL_KEY, cfg.url.trim());
  else localStorage.removeItem(STORAGE_URL_KEY);

  if (cfg.anonKey.trim()) localStorage.setItem(STORAGE_KEY_KEY, cfg.anonKey.trim());
  else localStorage.removeItem(STORAGE_KEY_KEY);
}

export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = getSupabaseConfig();
  return Boolean(url && anonKey);
}

/**
 * Pings the Supabase REST endpoint to verify that the project URL and Anon key are valid.
 */
export async function testSupabaseConnection(
  url = getSupabaseConfig().url,
  anonKey = getSupabaseConfig().anonKey,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!url || !anonKey) {
    return { ok: false, error: 'Supabase URL or Anon key is missing.' };
  }

  const cleanUrl = url.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/rest/v1/`;

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok || res.status === 200 || res.status === 404) {
      // 200 or 404 on base rest endpoint with valid apikey means Supabase gateway responded
      return { ok: true, status: res.status };
    }

    return { ok: false, status: res.status, error: `HTTP ${res.status}: ${res.statusText}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
