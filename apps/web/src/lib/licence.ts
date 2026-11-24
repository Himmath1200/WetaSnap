import type { Licence, LicenceStatus } from './types';

const DAY = 86_400_000;
export const GRACE_DAYS = 7;

/** LIC-03/LIC-04: expires soon ≤ 30 days; 7-day grace after the end date; then read-only. */
export function licenceStatus(l: Pick<Licence, 'type' | 'ends_on'>, now = new Date()): LicenceStatus {
  const end = new Date(l.ends_on + 'T23:59:59').getTime();
  const t = now.getTime();
  if (t > end + GRACE_DAYS * DAY) return 'read_only';
  if (t > end) return 'grace';
  if (end - t <= 30 * DAY) return 'expires_soon';
  return l.type === 'trial' ? 'trial' : 'active';
}

export function daysLeft(ends_on: string, now = new Date()) {
  return Math.ceil((new Date(ends_on + 'T23:59:59').getTime() - now.getTime()) / DAY);
}

export const LICENCE_META: Record<LicenceStatus, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-brand-100 text-brand-800' },
  trial: { label: 'Trial', cls: 'bg-subtle text-muted' },
  expires_soon: { label: 'Expires soon', cls: 'bg-amber-100 text-amber-800' },
  grace: { label: 'Grace period', cls: 'bg-red-100 text-red-700' },
  read_only: { label: 'Read-only', cls: 'bg-subtle text-muted' },
};

/** A person holds a seat while active and not past their access end date (ADM-02, W5). */
export function holdsSeat(p: { active: boolean; access_ends_on: string | null; role: string }, now = new Date()) {
  if (!p.active || p.role === 'super_admin') return false;
  return !p.access_ends_on || new Date(p.access_ends_on + 'T23:59:59').getTime() >= now.getTime();
}

/**
 * Access + 24-hour export grace period status:
 * - If today <= accessEndsOn: active scanning & lead capture allowed.
 * - If today > accessEndsOn && today <= graceEndsOn (access date + 1 day):
 *   account is OPEN for viewing and exporting leads, but scanning is disabled.
 * - If today > graceEndsOn: account access expired.
 */
export function getAccessGraceStatus(effectiveCutoff?: string | null, now = new Date()) {
  if (!effectiveCutoff) {
    return { isExpired: false, isExportOnly: false, canScan: true, accessEndsOn: null, graceEndsOn: null };
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;

  const graceDateObj = new Date(effectiveCutoff + 'T00:00:00Z');
  graceDateObj.setUTCDate(graceDateObj.getUTCDate() + 1);
  const graceEndsOn = graceDateObj.toISOString().slice(0, 10);

  if (today <= effectiveCutoff) {
    return { isExpired: false, isExportOnly: false, canScan: true, accessEndsOn: effectiveCutoff, graceEndsOn };
  } else if (today <= graceEndsOn) {
    return { isExpired: false, isExportOnly: true, canScan: false, accessEndsOn: effectiveCutoff, graceEndsOn };
  } else {
    return { isExpired: true, isExportOnly: false, canScan: false, accessEndsOn: effectiveCutoff, graceEndsOn };
  }
}
