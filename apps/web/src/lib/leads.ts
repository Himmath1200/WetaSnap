import type { Lead, LeadFilters, LeadStatus } from './types';

const val = (l: Lead, k: string) => l.fields[k]?.value?.trim() ?? '';

export function leadName(l: Lead) {
  const n = [val(l, 'first_name'), val(l, 'last_name')].filter(Boolean).join(' ') || val(l, 'name');
  return n || val(l, 'email') || 'Unnamed lead';
}
export const leadEmail = (l: Lead) => val(l, 'email');
export const leadCompany = (l: Lead) => val(l, 'company');

/** Pure filter used by S4 (device data) and the demo backend for S5 (LEAD-06). */
export function applyFilters<T extends Lead>(leads: T[], f: LeadFilters): T[] {
  const q = f.q.trim().toLowerCase();
  const from = f.from ? new Date(f.from + 'T00:00:00').getTime() : -Infinity;
  const to = f.to ? new Date(f.to + 'T23:59:59.999').getTime() : Infinity;
  return leads
    .filter((l) => !l.deleted_at)
    .filter((l) => !f.event_ids.length || f.event_ids.includes(l.event_id))
    .filter((l) => !f.captured_by.length || f.captured_by.includes(l.captured_by))
    .filter((l) => !f.tag_ids.length || f.tag_ids.some((g) => (l.tag_ids ?? []).includes(g)))
    .filter((l) => !f.import_batch_id || l.import_batch_id === f.import_batch_id)
    .filter((l) => !f.status || l.status === f.status)
    .filter((l) => !f.interest || l.interest === f.interest)
    .filter((l) => {
      const t = new Date(l.created_at).getTime();
      return t >= from && t <= to;
    })
    .filter((l) => {
      if (!q) return true;
      const hay = [...Object.values(l.fields).map((v) => v.value), l.notes, l.captured_by_name].join(' ').toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Number of filters in use, excluding the free-text search (drives the badge on the filter button). */
export function activeFilterCount(f: LeadFilters) {
  return f.event_ids.length + f.captured_by.length + f.tag_ids.length
    + (f.status ? 1 : 0) + (f.interest ? 1 : 0) + (f.from || f.to ? 1 : 0);
}

export const STATUS_META: Record<LeadStatus, { label: string; cls: string }> = {
  waiting: { label: 'Waiting', cls: 'bg-amber-100 text-amber-800' },
  synced: { label: 'Synced', cls: 'bg-subtle text-muted' },
  in_crm: { label: 'In CRM', cls: 'bg-brand-100 text-brand-800' },
  check: { label: 'Check', cls: 'bg-red-100 text-red-700' },
};

export const TAG_META: Record<import('./types').TagColour, { chip: string; dot: string }> = {
  green: { chip: 'bg-brand-50 text-brand-800 border-brand-200', dot: 'bg-brand-500' },
  blue: { chip: 'bg-ocean-50 text-ocean-800 border-ocean-200', dot: 'bg-ocean-500' },
  amber: { chip: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-400' },
  red: { chip: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
  purple: { chip: 'bg-purple-50 text-purple-800 border-purple-200', dot: 'bg-purple-500' },
  slate: { chip: 'bg-subtle text-slate-700 border-line', dot: 'bg-slate-400' },
};

export const INTEREST_META: Record<string, { label: string; cls: string; dot: string }> = {
  wetaloop: { label: 'WeTaLoop', cls: 'bg-brand-50 text-brand-700 border-brand-200', dot: 'bg-brand-500' },
  wetanalytics: { label: 'WeTaAnalytics', cls: 'bg-ocean-50 text-ocean-700 border-ocean-200', dot: 'bg-ocean-500' },
  other: { label: 'Other', cls: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-500' },
  hot: { label: 'Hot', cls: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
  warm: { label: 'Warm', cls: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-500' },
  cold: { label: 'Cold', cls: 'bg-subtle text-muted border-line', dot: 'bg-slate-400' },
};

/** CSV export (ADM-06). Excel opens UTF-8 CSV with BOM correctly. */
export function leadsToCsv(leads: Lead[], fieldKeys: { key: string; label: string }[], photoLink: (l: Lead) => string, tagName: (id: string) => string = (i) => i) {
  const esc = (raw: string) => {
    const s = safeCell(raw);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [...fieldKeys.map((f) => f.label), 'Tags', 'Interest', 'Notes', 'Consent', 'Captured by', 'Event', 'Source', 'Status', 'Captured at', 'Card photo'];
  const rows = leads.map((l) => [
    ...fieldKeys.map((f) => l.fields[f.key]?.value ?? ''),
    (l.tag_ids ?? []).map(tagName).join(' | '),
    l.interest ?? '', l.notes, l.consent ? 'yes' : 'no', l.captured_by_name, l.event_id, l.source,
    STATUS_META[l.status].label, l.created_at, l.has_photo ? photoLink(l) : '',
  ]);
  return '\ufeff' + [head, ...rows].map((r) => r.map((c) => esc(String(c))).join(',')).join('\r\n');
}

/**
 * Text from a business card is untrusted: a value starting with = + - @ (or a tab/CR) would run as a
 * formula when the export is opened in Excel. Prefixing an apostrophe shows it as plain text (D-19).
 */
export function safeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
