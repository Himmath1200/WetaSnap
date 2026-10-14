/**
 * Steps 6 and 7: validation and normalisation.
 *
 * OCR gets characters wrong in ways that are obvious once you know what a field is meant to hold:
 * an e-mail with a space in it, a phone number with an O instead of a zero, a website written as
 * "www. acme .com". Each field type is checked and tidied here, and a value that cannot be made
 * sense of keeps its text but loses confidence and gains a reason, so the app marks it for a look
 * rather than silently storing nonsense.
 *
 * Nothing is invented. If a value is empty it stays empty.
 */
export interface Value { value: string; by?: string; confidence?: number; reason?: string }
export type Fields = Record<string, Value>;

export interface FieldType { key: string; type: string; required?: boolean; options?: string[] }

export function normaliseFields(fields: Fields, types: FieldType[]): Fields {
  const byKey = new Map(types.map((t) => [t.key, t]));
  const out: Fields = {};
  for (const [key, raw] of Object.entries(fields)) {
    const type = byKey.get(key)?.type ?? guessType(key);
    const tidied = normaliseOne(String(raw?.value ?? ''), type, key);
    if (!tidied.value) continue;
    out[key] = {
      ...raw,
      value: tidied.value,
      ...(tidied.reason ? { reason: tidied.reason } : {}),
      confidence: Math.min(raw?.confidence ?? 1, tidied.ok ? (raw?.confidence ?? 1) : 0.5),
    };
  }
  return out;
}

export function normaliseOne(input: string, type: string, key = ''): { value: string; ok: boolean; reason?: string } {
  const text = collapse(input);
  if (!text) return { value: '', ok: true };

  switch (type) {
    case 'email': return email(text);
    case 'phone': return phone(text);
    case 'link': return link(text);
    default:
      if (/name/.test(key) && !/company|org|file/.test(key)) return { value: titleCase(text), ok: true };
      return { value: text.slice(0, 500), ok: true };
  }
}

// ---------------------------------------------------------------- field types
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

function email(text: string): { value: string; ok: boolean; reason?: string } {
  let v = text.toLowerCase().replace(/\s+/g, '').replace(/^(e-?mail|mail)[:.]?/, '');
  // Common OCR slips inside an address, where only these characters are plausible.
  v = v.replace(/\(at\)|\[at\]|\sat\s/gi, '@').replace(/\(dot\)|\[dot\]/gi, '.');
  v = v.replace(/[,;]$/, '').replace(/\.{2,}/g, '.');
  if (EMAIL_RE.test(v)) return { value: v, ok: true };
  // One @ missing is the usual failure; without a plausible fix, keep the text and flag it.
  return { value: v.slice(0, 200), ok: false, reason: 'This does not look like a complete email address.' };
}

function phone(text: string): { value: string; ok: boolean; reason?: string } {
  const cleaned = text
    .replace(/^(tel|phone|mobile|mob|cell|fax)[.:]?\s*/i, '')
    .replace(/[oO](?=\d)|(?<=\d)[oO]/g, '0')      // O read for 0, but only next to digits
    .replace(/[lI](?=\d)|(?<=\d)[lI]/g, '1')
    .replace(/[^\d+()\-\s./]/g, '')
    .trim();
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 6) return { value: cleaned, ok: false, reason: 'This number looks incomplete.' };
  if (digits.length > 15) return { value: cleaned.slice(0, 40), ok: false, reason: 'This number has too many digits.' };
  // Keep the + when it is there; otherwise leave the local form alone — guessing a country
  // code from an exhibition hall is how leads end up ringing the wrong continent.
  const plus = cleaned.trim().startsWith('+') || cleaned.trim().startsWith('00');
  const normalised = plus ? `+${digits.replace(/^00/, '')}` : groupLocal(digits, cleaned);
  return { value: normalised.slice(0, 40), ok: true };
}

/** Keeps the printed grouping of a local number rather than inventing one. */
const groupLocal = (digits: string, original: string) => (original.match(/[\s./-]/) ? collapse(original) : digits);

function link(text: string): { value: string; ok: boolean; reason?: string } {
  let v = text.toLowerCase().replace(/\s+/g, '').replace(/^(web|site|url)[:.]?/, '');
  if (!v) return { value: '', ok: true };
  if (!/^https?:\/\//.test(v)) v = `https://${v.replace(/^\/+/, '')}`;
  try {
    const url = new URL(v);
    if (!url.hostname.includes('.')) throw new Error('no dot');
    return { value: url.toString().replace(/\/$/, ''), ok: true };
  } catch {
    return { value: text.slice(0, 200), ok: false, reason: 'This does not look like a web address.' };
  }
}

// ---------------------------------------------------------------- helpers
const collapse = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** "ANNA WEBER" → "Anna Weber", but "GmbH" and "IBM" keep their shape. */
export function titleCase(name: string): string {
  if (!/[a-z]/.test(name) || !/[A-Z]/.test(name)) {
    return name
      .toLowerCase()
      .replace(/(^|[\s'’\-([])([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase())
      .replace(/\b(Gmbh|Ag|Bv|Nv|Srl|Sas|Oy|Ab|Plc|Ltd|Llc|Inc)\b/g, (m) => m.toUpperCase());
  }
  return name;
}

const guessType = (key: string) =>
  /mail/.test(key) ? 'email' : /phone|mobile|tel|fax/.test(key) ? 'phone' : /web|site|url|linkedin/.test(key) ? 'link' : 'text';

/** The e-mail domain, which is the most reliable company identifier a card carries. */
export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return '';
  const domain = email.slice(at + 1).toLowerCase().trim();
  const free = /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|gmx|web|aol|proton(mail)?|yandex|mail)\./;
  return free.test(domain) ? '' : domain;
}

/** Digits only, for comparing two numbers that were written differently. */
export const phoneKey = (value: string) => value.replace(/\D/g, '').replace(/^00/, '').slice(-10);
