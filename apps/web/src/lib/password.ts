import type { SecurityPolicy } from './types';

/** The defaults a fresh installation starts with; WeTano can change them in Security settings. */
export const DEFAULT_POLICY: SecurityPolicy = {
  min_length: 12,
  require_upper: true,
  require_number: true,
  require_symbol: true,
  expiry_days: 180,
  reuse_block: 5,
  lockout_attempts: 5,
  lockout_minutes: 15,
  idle_timeout_minutes: 30,
  device_session_days: 30,
  mfa_required_super_admin: false,
  mfa_required_client_admin: false,
};

/** Plain-language problems with a password, worst first. Empty = acceptable. */
export function checkPassword(password: string, p: SecurityPolicy): string[] {
  const out: string[] = [];
  if (password.length < p.min_length) out.push(`Use at least ${p.min_length} characters.`);
  if (p.require_upper && !/[A-Z]/.test(password)) out.push('Add a capital letter.');
  if (p.require_number && !/\d/.test(password)) out.push('Add a number.');
  if (p.require_symbol && !/[^\w\s]/.test(password)) out.push('Add a symbol, for example ! or #.');
  if (/^(?:password|welcome|wetano|wetasnap|qwerty|123456)/i.test(password)) out.push('That is too easy to guess.');
  return out;
}

/** 0–4, for the strength bar next to the field. */
export function passwordStrength(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password) && /[^\w\s]/.test(password)) score++;
  return Math.min(4, score);
}

export const STRENGTH_LABEL = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

/** Has this password passed its expiry date? */
export function passwordExpired(changedAt: string, p: SecurityPolicy, now = new Date()) {
  if (!p.expiry_days) return false;
  return now.getTime() - new Date(changedAt).getTime() > p.expiry_days * 86_400_000;
}
