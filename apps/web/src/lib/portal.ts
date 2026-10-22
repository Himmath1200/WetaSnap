import type { Role } from './types';

/**
 * Two doors (client decision, 26 Sep 2026):
 *   /super-admin/…   the WeTano Console — Super Admins only, its own sign-in page
 *   /…               the company app — client admins and booth staff, one shared sign-in page
 *
 * Inside each door every screen is a plain path, and the person's role decides which of them
 * they may open. Links from the older three-portal layout (/client-admin/leads, /staff/scan)
 * are redirected to the shared address, so bookmarks keep working.
 */

/** Which door a person belongs to (the Backend contract owns the type). */
export type { Door } from './backend';
import type { Door } from './backend';

/** The WeTano Console lives under its own prefix; the company app has none. */
export const CONSOLE_BASE = '/super-admin';

export const doorForRole = (role: Role): Door => (role === 'super_admin' ? 'console' : 'app');
export const basePath = (door: Door) => (door === 'console' ? CONSOLE_BASE : '');
export const signInPath = (door: Door) => `${basePath(door)}/signin`;

/** A link to a screen for this role: /leads for the app, /super-admin/companies for the console. */
export const linkFor = (role: Role, path: string) => `${basePath(doorForRole(role))}${path}`;

/** What each door is called on screen, and where a role lands after signing in. */
export const ROLE_META: Record<Role, { name: string; tagline: string; home: string }> = {
  super_admin: {
    name: 'WeTano Console',
    tagline: 'Companies, licences and support for every client.',
    home: '/companies',
  },
  client_admin: {
    name: 'Admin',
    tagline: 'Your leads, team, events and CRM.',
    home: '/leads',
  },
  staff: {
    name: 'Scanner',
    tagline: 'Scan cards at the booth — with or without internet.',
    // ponytail: lands on the scanner until the Home screen exists; then '/home'.
    home: '/scan-v2',
  },
};

/** Company links people may still have from the days of three portals. */
const OLD_APP_PREFIXES = ['/client-admin', '/staff'] as const;

/** Splits a URL into the door it belongs to and the screen inside it. */
export function readPath(path: string): { door: Door; here: string } {
  if (path === CONSOLE_BASE || path.startsWith(`${CONSOLE_BASE}/`)) {
    return { door: 'console', here: path.slice(CONSOLE_BASE.length) || '/' };
  }
  const old = OLD_APP_PREFIXES.find((p) => path === p || path.startsWith(`${p}/`));
  return { door: 'app', here: old ? path.slice(old.length) || '/' : path || '/' };
}

/** True when the URL still carries a prefix the company app no longer uses. */
export const isOldAppPath = (path: string) =>
  OLD_APP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
