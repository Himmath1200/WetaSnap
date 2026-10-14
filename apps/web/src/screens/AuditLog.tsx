import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Search, SlidersHorizontal, X, Download, ScrollText, ChevronRight } from 'lucide-preact';
import { Avatar, Empty, Sheet, Spinner, Select } from '../components/ui';
import { backend } from '../lib/backend';
import { toast } from '../lib/store';
import { today } from '../lib/id';
import { t, tn } from '../lib/i18n';
import type { AuditEntry, CompanySummary, Role } from '../lib/types';

/** S10 · Audit log — WeTano Super Admin: who changed what, when (PRIV-04). */

interface Filters { q: string; company_id: string; action: string; from: string; to: string }
const emptyAudit = (): Filters => ({ q: '', company_id: '', action: '', from: '', to: '' });
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const ROLE_META: Record<Role | 'system', { label: string; cls: string }> = {
  super_admin: { label: 'WeTano', cls: 'bg-slate-200 text-slate-700' },
  client_admin: { label: 'Client Admin', cls: 'bg-subtle text-muted' },
  staff: { label: 'Staff', cls: 'bg-subtle text-muted' },
  system: { label: 'System', cls: 'bg-subtle text-muted' },
};

/** "licence.updated" → "Licence updated" — readable without a translation for every action name. */
const actionLabel = (a: string) => {
  const words = a.replace(/[._-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export default function AuditLog() {
  const [f, setF] = useState<Filters>(emptyAudit);
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const seenActions = useRef<Set<string>>(new Set());

  useEffect(() => { backend().then((b) => b.companies()).then(setCompanies).catch(() => {}); }, []);

  useEffect(() => {
    let live = true;
    setRows(null);
    void (async () => {
      try {
        const list = await (await backend()).auditLog(f);
        if (!live) return;
        list.forEach((e) => seenActions.current.add(e.action));
        setRows(list);
      } catch (e) {
        if (!live) return;
        setRows([]);
        toast((e as Error).message, 'error');
      }
    })();
    return () => { live = false; };
  }, [f.q, f.company_id, f.action, f.from, f.to]);

  const actions = useMemo(() => {
    const set = new Set(seenActions.current);
    if (f.action) set.add(f.action);
    return [...set].sort();
  }, [rows, f.action]);

  function downloadCsv() {
    const list = rows ?? [];
    if (!list.length) return;
    const head = [t('When'), t('Who'), t('Role'), t('Company'), t('Action'), t('Entity'), t('Entity id'), t('Details')];
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = list.map((e) => [
      new Date(e.at).toLocaleString(), e.actor_email, t(ROLE_META[e.actor_role].label), e.company_name,
      e.action, e.entity, e.entity_id ?? '', JSON.stringify(e.details ?? {}),
    ].map(cell).join(','));
    // ﻿ so Excel opens the UTF-8 file with the right encoding.
    const blob = new Blob([`﻿${[head.map(cell).join(','), ...body].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wetasnap-audit-${today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(tn(list.length, '{n} entry exported', '{n} entries exported'), 'success');
  }

  return (
    <div class="mx-auto max-w-7xl">
      <div class="mb-4">
        <h1 class="text-xl font-bold">{t('Audit log')}</h1>
        <p class="text-sm text-muted">{t('Every change made in WeTa Snap, kept for the retention period.')}</p>
      </div>

      <AuditFilterBar value={f} onChange={setF} companies={companies} actions={actions}
        onExport={downloadCsv} canExport={!!rows?.length} />

      <div class="card mt-4 overflow-hidden">
        {!rows ? <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>
          : rows.length === 0 ? <Empty icon={<ScrollText class="size-6" />} title={t('Nothing logged for this search')} text={t('Try a wider date range or clear the filters.')} />
          : (
            <>
              <ol class="divide-y divide-line">
                {rows.map((e) => (
                  <li key={e.id}>
                    <button class="flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-brand-50/40" onClick={() => setOpen(e)}>
                      <Avatar name={e.actor_email} size="size-8" />
                      <span class="min-w-0 flex-1">
                        <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span class="truncate text-sm font-semibold">{e.actor_email}</span>
                          <span class={`pill ${ROLE_META[e.actor_role].cls}`}>{t(ROLE_META[e.actor_role].label)}</span>
                        </span>
                        {e.action.startsWith('error.') ? (
                          <span class="mt-1 block rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">
                            <span class="font-bold">{t('Error')} · {e.action.slice(6)}</span>
                            {typeof e.details.action === 'string' && <> — {String(e.details.action)}</>}
                            {typeof e.details.message === 'string' && <span class="block truncate">{String(e.details.message)}</span>}
                            {typeof e.details.where === 'string' && <span class="block truncate opacity-80">{t('Where')}: {String(e.details.where)}</span>}
                          </span>
                        ) : (
                          <span class="mt-0.5 block text-sm">
                            {actionLabel(e.action)} <span class="text-muted">· {e.entity}</span>
                          </span>
                        )}
                        <span class="mt-0.5 block text-xs text-muted lg:hidden">
                          {new Date(e.at).toLocaleString()}{e.company_name ? ` · ${e.company_name}` : ''}
                        </span>
                      </span>
                      <span class="hidden w-64 shrink-0 text-right lg:block">
                        <span class="block text-xs text-muted tabular-nums">{new Date(e.at).toLocaleString()}</span>
                        {e.company_name && <span class="block truncate text-xs font-medium text-ink">{e.company_name}</span>}
                      </span>
                      <ChevronRight class="mt-1 size-4 shrink-0 text-muted" />
                    </button>
                  </li>
                ))}
              </ol>
              <p class="border-t border-line px-4 py-2 text-xs text-muted">{tn(rows.length, '{n} entry', '{n} entries')}</p>
            </>
          )}
      </div>

      <Sheet open={!!open} onClose={() => setOpen(null)} wide title={open ? actionLabel(open.action) : ''}>
        {open && (
          <div class="space-y-4">
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt class="text-muted">{t('Who')}</dt><dd class="font-medium break-all">{open.actor_email}</dd>
              <dt class="text-muted">{t('Role')}</dt><dd><span class={`pill ${ROLE_META[open.actor_role].cls}`}>{t(ROLE_META[open.actor_role].label)}</span></dd>
              <dt class="text-muted">{t('When')}</dt><dd class="font-medium tabular-nums">{new Date(open.at).toLocaleString()}</dd>
              <dt class="text-muted">{t('Company')}</dt><dd class="font-medium">{open.company_name || '—'}</dd>
              <dt class="text-muted">{t('Entity')}</dt><dd class="font-medium break-all">{open.entity}{open.entity_id ? ` · ${open.entity_id}` : ''}</dd>
              <dt class="text-muted">{t('Action')}</dt><dd class="font-mono text-xs break-all">{open.action}</dd>
            </dl>
            <section>
              <h3 class="label">{t('Details')}</h3>
              <Details value={open.details} />
            </section>
          </div>
        )}
      </Sheet>
    </div>
  );
}

/** Renders the audit JSON as label/value rows; nested objects and arrays fall back to formatted JSON. */
function Details({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value ?? {});
  if (entries.length === 0) return <p class="rounded-xl bg-subtle px-3 py-2 text-sm text-muted">{t('No extra details were recorded.')}</p>;
  return (
    <dl class="divide-y divide-line rounded-xl border border-line">
      {entries.map(([k, v]) => (
        <div key={k} class="grid grid-cols-1 gap-1 px-3 py-2 sm:grid-cols-[minmax(7rem,auto)_1fr] sm:gap-3">
          <dt class="text-xs font-semibold text-muted">{actionLabel(k)}</dt>
          <dd class="min-w-0 text-sm break-words">
            {v === null || v === undefined ? <span class="text-muted">—</span>
              : typeof v === 'boolean' ? (v ? t('Yes') : t('No'))
              : typeof v === 'object' ? <pre class="overflow-x-auto rounded-lg bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(v, null, 2)}</pre>
              : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Search box with the Filter button right beside it (same pattern as the leads bar):
 * company, action and a date range with Last 7 / Last 30 day presets.
 */
function AuditFilterBar({ value, onChange, companies, actions, onExport, canExport }: {
  value: Filters; onChange: (f: Filters) => void; companies: CompanySummary[]; actions: string[];
  onExport: () => void; canExport: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(value.q);
  const wrap = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });
  const count = (value.company_id ? 1 : 0) + (value.action ? 1 : 0) + (value.from || value.to ? 1 : 0);

  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (q === value.q) return;
    const h = setTimeout(() => onChange({ ...latest.current, q }), 200);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => setQ(value.q), [value.q]);

  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);

  const preset = value.from === daysAgo(6) && value.to === today() ? '7d'
    : value.from === daysAgo(29) && value.to === today() ? '30d'
    : value.from || value.to ? 'custom' : '';

  const chips: { label: string; clear: Partial<Filters> }[] = [];
  if (value.company_id) chips.push({ label: companies.find((c) => c.id === value.company_id)?.name ?? t('Company'), clear: { company_id: '' } });
  if (value.action) chips.push({ label: actionLabel(value.action), clear: { action: '' } });
  if (preset) chips.push({ label: preset === '7d' ? t('Last 7 days') : preset === '30d' ? t('Last 30 days') : `${value.from || '…'} → ${value.to || '…'}`, clear: { from: '', to: '' } });

  return (
    <div class="space-y-2">
      <div class="flex items-center gap-2" ref={wrap}>
        <div class="relative min-w-0 flex-1">
          <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input type="search" class="input pr-9 pl-9" value={q} placeholder={t('Search email, action, entity…')}
            onInput={(e) => setQ(e.currentTarget.value)} aria-label={t('Search the audit log')} />
          {q && (
            <button class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-muted hover:bg-subtle" onClick={() => { setQ(''); set({ q: '' }); }} aria-label={t('Clear search')}>
              <X class="size-4" />
            </button>
          )}
        </div>

        <div class="relative">
          <button class={`btn relative border px-3 ${count ? 'border-ocean-600 bg-ocean-50 text-ocean-700' : 'border-line bg-surface text-ink hover:border-ocean-500 hover:text-ocean-700'}`}
            onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label={t('Filter the audit log')}>
            <SlidersHorizontal class="size-4" />
            <span class="hidden sm:inline">{t('Filter')}</span>
            {count > 0 && <span class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ocean-600 text-[11px] font-bold text-white">{count}</span>}
          </button>

          {open && <div class="fixed inset-0 z-30 bg-slate-900/25 sm:hidden" onClick={() => setOpen(false)} />}
          {open && (
            <div class="fixed inset-x-0 bottom-0 z-40 max-h-[80dvh] overflow-y-auto rounded-t-3xl border border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:pb-4 sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:bottom-auto sm:mt-2 sm:w-[340px] sm:rounded-2xl" role="dialog" aria-label={t('Filter the audit log')}>
              <div class="mb-3 flex items-center justify-between">
                <p class="text-sm font-bold">{t('Filter the audit log')}</p>
                <button class="inline-flex min-h-11 items-center text-xs font-semibold text-ocean-700 hover:underline disabled:opacity-40" disabled={!count} onClick={() => onChange({ ...emptyAudit(), q: value.q })}>{t('Clear all')}</button>
              </div>
              <div class="space-y-4">
                <div class="flex flex-wrap gap-2">
                  <button type="button" aria-pressed={value.action === 'error'}
                    class={`chip ${value.action === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-line bg-surface'}`}
                    onClick={() => set({ action: value.action === 'error' ? '' : 'error' })}>
                    {t('Errors only')}
                  </button>
                </div>
                <div>
                  <span class="label">{t('Company')}</span>
                  <Select class="w-full" label={t('Company')} value={value.company_id} onChange={(v) => set({ company_id: v })}
                    options={[{ value: '', label: t('All companies') }, ...companies.map((c) => ({ value: c.id, label: c.name }))]} />
                </div>
                <div>
                  <span class="label">{t('Action')}</span>
                  <Select class="w-full" label={t('Action')} value={value.action} onChange={(v) => set({ action: v })}
                    options={[{ value: '', label: t('All actions') }, { value: 'error', label: t('Errors') }, ...actions.filter((a) => a !== 'error').map((a) => ({ value: a, label: actionLabel(a) }))]} />
                </div>
                <div>
                  <span class="label">{t('Date range')}</span>
                  <div class="flex flex-wrap gap-2">
                    <button type="button" aria-pressed={preset === '7d'} class={`chip ${preset === '7d' ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface'}`}
                      onClick={() => set(preset === '7d' ? { from: '', to: '' } : { from: daysAgo(6), to: today() })}>{t('Last 7 days')}</button>
                    <button type="button" aria-pressed={preset === '30d'} class={`chip ${preset === '30d' ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface'}`}
                      onClick={() => set(preset === '30d' ? { from: '', to: '' } : { from: daysAgo(29), to: today() })}>{t('Last 30 days')}</button>
                  </div>
                  <div class="mt-2 grid grid-cols-2 gap-2">
                    <input type="date" class="input" value={value.from} max={value.to || undefined} onChange={(e) => set({ from: e.currentTarget.value })} aria-label={t('From date')} />
                    <input type="date" class="input" value={value.to} min={value.from || undefined} onChange={(e) => set({ to: e.currentTarget.value })} aria-label={t('To date')} />
                  </div>
                </div>
              </div>
              <button class="btn-primary mt-4 w-full" onClick={() => setOpen(false)}>{t('Show results')}</button>
            </div>
          )}
        </div>

        <button class="btn-secondary px-3" disabled={!canExport} onClick={onExport} title={t('Download what is on screen as CSV')}>
          <Download class="size-4" /><span class="hidden sm:inline">{t('Export')}</span>
        </button>
      </div>

      {chips.length > 0 && (
        <div class="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span key={c.label} class="inline-flex items-center gap-1 rounded-full bg-ocean-50 py-1 pr-1 pl-2.5 text-xs font-semibold text-ocean-800">
              {c.label}
              <button class="-my-2 flex size-10 items-center justify-center rounded-full hover:bg-ocean-100" onClick={() => set(c.clear)} aria-label={`${t('Remove filter')} ${c.label}`}><X class="size-3.5" /></button>
            </span>
          ))}
          {chips.length > 1 && <button class="inline-flex min-h-11 items-center px-1 text-xs font-semibold text-muted hover:text-ink" onClick={() => onChange({ ...emptyAudit(), q: value.q })}>{t('Clear all')}</button>}
        </div>
      )}
    </div>
  );
}
