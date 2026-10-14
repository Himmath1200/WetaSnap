import type { FieldType } from './types';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(v: string) {
  return EMAIL.test(v.trim());
}

export function normaliseUrl(v: string): string | null {
  const s = v.trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.includes('.') ? u.toString().replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

/** Phone → international format (AI-08). libphonenumber is lazy-loaded on the review screen only. */
export async function normalisePhone(v: string, defaultCountry = 'DE'): Promise<string | null> {
  const s = v.trim();
  if (!s) return '';
  const { parsePhoneNumberFromString } = await import('libphonenumber-js/min');
  const p = parsePhoneNumberFromString(s, defaultCountry as never);
  return p?.isValid() ? p.formatInternational() : null;
}

/** Returns a plain-language error (English key for t()) or null. */
export function fieldError(type: FieldType, value: string, required: boolean): string | null {
  const v = value.trim();
  if (!v) return required ? 'This field is required' : null;
  if (type === 'email' && !isEmail(v)) return 'This does not look like an email address';
  if (type === 'link' && normaliseUrl(v) === null) return 'This does not look like a website';
  return null;
}
