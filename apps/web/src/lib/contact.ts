import type { FieldDefinition, Lead } from './types';
import { leadName } from './leads';

const v = (l: Lead, k: string) => l.fields[k]?.value?.trim() ?? '';

/** vCard 3.0 — opens the phone's “add contact” screen and imports into Outlook/Google. */
export function leadToVCard(l: Lead, defs: FieldDefinition[], eventName?: string) {
  const first = v(l, 'first_name');
  const last = v(l, 'last_name') || (first ? '' : leadName(l));
  const extra = defs
    .filter((d) => !['first_name', 'last_name', 'company', 'job_title', 'email', 'phone', 'website', 'address', 'country'].includes(d.key))
    .map((d) => (v(l, d.key) ? `${d.label}: ${v(l, d.key)}` : ''))
    .filter(Boolean);
  const note = [l.notes, l.interest ? `Interest: ${l.interest}` : '', eventName ? `Met at: ${eventName}` : '', ...extra].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCARD', 'VERSION:3.0',
    `N:${esc(last)};${esc(first)};;;`,
    `FN:${esc(leadName(l))}`,
    v(l, 'company') && `ORG:${esc(v(l, 'company'))}`,
    v(l, 'job_title') && `TITLE:${esc(v(l, 'job_title'))}`,
    v(l, 'email') && `EMAIL;TYPE=WORK:${esc(v(l, 'email'))}`,
    v(l, 'phone') && `TEL;TYPE=CELL:${esc(v(l, 'phone'))}`,
    v(l, 'website') && `URL:${esc(v(l, 'website'))}`,
    (v(l, 'address') || v(l, 'country')) && `ADR;TYPE=WORK:;;${esc(v(l, 'address'))};;;;${esc(v(l, 'country'))}`,
    note && `NOTE:${esc(note)}`,
    `REV:${new Date().toISOString()}`,
    'END:VCARD',
  ].filter(Boolean) as string[];
  return lines.join('\r\n');
}

/** vCard escaping: backslash, semicolon and comma are escaped, real newlines become \n. */
const esc = (s: string) => s.replace(/([\\;,])/g, '\\$1').replace(/\r?\n/g, '\\n');

export function vcardFile(l: Lead, defs: FieldDefinition[], eventName?: string) {
  const name = leadName(l).replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'lead';
  return new File([leadToVCard(l, defs, eventName)], `${name}.vcf`, { type: 'text/vcard' });
}

/** “Save to device” — downloading a .vcf opens the contact importer on Android and iPhone. */
export function saveToPhone(l: Lead, defs: FieldDefinition[], eventName?: string) {
  const file = vcardFile(l, defs, eventName);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const canShareFiles = (files: File[]) =>
  typeof navigator !== 'undefined' && !!navigator.canShare?.({ files });

/** “Share contact” — the phone's own share sheet (WhatsApp, email, AirDrop…). */
export async function shareContact(l: Lead, defs: FieldDefinition[], eventName?: string) {
  const file = vcardFile(l, defs, eventName);
  const text = contactText(l, defs);
  if (canShareFiles([file])) return navigator.share({ files: [file], title: leadName(l), text });
  if (navigator.share) return navigator.share({ title: leadName(l), text });
  await navigator.clipboard.writeText(text);
  throw new ClipboardFallback();
}

/** “Share card” — the photo of the card itself. */
export async function shareCardPhoto(blob: Blob, l: Lead) {
  const file = new File([blob], `${leadName(l).replace(/\s+/g, '-')}-card.${blob.type.includes('webp') ? 'webp' : 'jpg'}`, { type: blob.type || 'image/jpeg' });
  if (canShareFiles([file])) return navigator.share({ files: [file], title: leadName(l) });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export class ClipboardFallback extends Error {
  constructor() { super('copied'); }
}

export function contactText(l: Lead, defs: FieldDefinition[]) {
  return defs.map((d) => (v(l, d.key) ? `${d.label}: ${v(l, d.key)}` : '')).filter(Boolean).join('\n');
}

/** Tap-to-act links on the lead preview: phone dials, email composes, website and address open. */
export function actionHref(type: FieldDefinition['type'], value: string, key?: string) {
  const s = value.trim();
  if (!s) return null;
  if (type === 'phone') return `tel:${s.replace(/[^\d+]/g, '')}`;
  if (type === 'email') return `mailto:${s}`;
  if (type === 'link') return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  if (key === 'address' || key === 'location' || key === 'city') return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s)}`;
  return null;
}
