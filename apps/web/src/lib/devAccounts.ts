/**
 * Demo help on the sign-in page: the accounts this deployment has, and the 6-digit code that was
 * just sent — so showing the app to somebody never means opening a terminal or a second tab.
 *
 * It all hangs off two endpoints the API only serves while it is a development deployment
 * (NODE_ENV is not production, MAIL_DRIVER is `log`, DEV_DEMO_PASSWORD is set). Anywhere else they
 * answer nothing, every call here returns empty, and the panel simply never appears. Nothing is
 * cached and nothing is stored; a failure is silent, because this is a convenience and must never
 * come between somebody and signing in.
 */
const BASE = String(import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export interface DevAccount {
  email: string;
  name: string;
  role: 'super_admin' | 'client_admin' | 'staff' | 'individual';
  company: string;
}

export interface DevAccounts {
  /** The one password they all share. Empty means: show nothing. */
  password: string;
  accounts: DevAccount[];
}

const EMPTY: DevAccounts = { password: '', accounts: [] };

async function ask<T>(path: string, fallback: T): Promise<T> {
  if (!BASE && !import.meta.env.DEV) return fallback;
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? ((await res.json()) as T) : fallback;
  } catch {
    return fallback;                     // no API, not a development one, or simply offline
  }
}

export const devAccounts = () => ask<DevAccounts>('/dev/accounts', EMPTY);

/** The code sent to this address in the last ten minutes, or null. */
export const devCode = async (email: string): Promise<string | null> =>
  (await ask<{ code: string | null }>(`/dev/code?email=${encodeURIComponent(email)}`, { code: null })).code;
