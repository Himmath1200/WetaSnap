import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { ComponentChildren } from 'preact';
import {
  Download, SearchX, ChevronRight, ChevronDown, Upload, FileSpreadsheet, FileText, FileDown,
  Clock, Plus, Minus, RefreshCw, Trash, X,
} from 'lucide-preact';
import { SearchFilterBar } from '../components/SearchFilterBar';
import { LeadDetail } from '../components/LeadDetail';
import { ImportLeads } from '../components/ImportLeads';
import { ImportHistory } from '../components/ImportHistory';
import { TagChips } from '../components/TagPicker';
import { Avatar, BulkBar, Counter, Dialog, Empty, InterestPill, SortHeader, SortMenu, Spinner, StatusPill, Tick } from '../components/ui';
import { backend, type Counters, type PersonRow } from '../lib/backend';
import { leadsToXlsx } from '../lib/xlsx';
import { leadsToPdf } from '../lib/pdf';
import { useStore, toast } from '../lib/store';
import { config, session } from '../lib/session';
import { net } from '../lib/net';
import { STATUS_META, INTEREST_META, leadCompany, leadEmail, leadName, leadsToCsv, TAG_META } from '../lib/leads';
import { emptyFilters, type Lead, type LeadFilters, type Sort, type Tag } from '../lib/types';
import { timeAgo } from '../lib/id';
import { t, tn } from '../lib/i18n';

type ExportKind = 'xlsx' | 'csv' | 'pdf';

/** Blue pill button used inside the bulk bar (44 px tall so it stays thumb-sized). */
const BULK = 'inline-flex min-h-11 items-center gap-1.5 rounded-full border border-ocean-200 bg-surface px-3 text-xs font-semibold text-ocean-800 transition hover:bg-ocean-100 disabled:opacity-50';

const INTEREST_RANK = { hot: 3, warm: 2, cold: 1 } as const;
const STATUS_RANK: Record<Lead['status'], number> = { waiting: 0, synced: 1, in_crm: 2, check: 3 };

/** S5 · Leads (admin home): counters, search + filter, sortable table, bulk actions, export (LEAD-06, ADM-06, ADM-07). */
export default function Leads() {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const n = useStore(net);
  const [filters, setFilters] = useState<LeadFilters>(() => ({
    ...emptyFilters(),
    event_ids: s.event_id ? [s.event_id] : [],
    status: (new URLSearchParams(location.search).get('status') as LeadFilters['status']) || '',
  }));
  const [rows, setRows] = useState<Lead[] | null>(null);
  const [counters, setCounters] = useState<Counters | null>(null);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState(false);
  const [importName, setImportName] = useState('');
  const [open, setOpen] = useState<Lead | null>(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [tick, setTick] = useState(0);
  // Bulk selection + sorting live over the loaded rows.
  const [selected, setSelected] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>({ key: 'time', dir: 'desc' });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = () => setTick((x) => x + 1);

  // A notification such as “a lead was rejected” links to /leads?status=check. When this screen is
  // already open only the query changes, so the filter has to follow it (D-17).
  const { query } = useLocation();
  useEffect(() => {
    const asked = (query.status ?? '') as LeadFilters['status'];
    setFilters((f) => (f.status === asked ? f : { ...f, status: asked }));
  }, [query.status]);

  // Picking another event in the header changes what this screen shows (EVT-04).
  const headerEvent = useRef(s.event_id);
  useEffect(() => {
    if (s.event_id === headerEvent.current) return;
    headerEvent.current = s.event_id;
    setFilters((f) => ({ ...f, event_ids: s.event_id ? [s.event_id] : [] }));
    setSelected([]);
  }, [s.event_id]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const b = await backend();
        const [r, c] = await Promise.all([b.listLeads(filters), b.counters(filters.event_ids[0] || s.event_id || '')]);
        if (!live) return;
        setRows(r); setCounters(c); setError('');
      } catch (e) {
        if (live) setError((e as Error).message === 'offline' ? t('You are offline. Leads will load when the connection returns.') : (e as Error).message);
      }
    })();
    return () => { live = false; };
  }, [filters, tick, n.online, n.simulatedOffline]);

  useEffect(() => {
    void backend().then((b) => b.people()).then(setPeople).catch(() => {});
    void backend().then((b) => b.tags()).then(setTags).catch(() => {});
  }, []);
  // Keep statuses fresh while the page is open (In CRM / Failed arrive from the server).
  useEffect(() => { const h = setInterval(reload, 15_000); return () => clearInterval(h); }, []);
  // A different filter shows a different list, so ticks from the old one are dropped.
  useEffect(() => { setSelected([]); }, [filters]);
  // A background refresh may drop a row (deleted elsewhere) — never act on what is no longer listed.
  useEffect(() => {
    if (!rows) return;
    const ids = new Set(rows.map((r) => r.id));
    setSelected((prev) => (prev.every((id) => ids.has(id)) ? prev : prev.filter((id) => ids.has(id))));
  }, [rows]);

  const staff = useMemo(() => people.map((p) => ({ id: p.id, name: p.name })), [people]);
  const eventName = (id: string) => cfg.events.find((e) => e.id === id)?.name ?? '—';

  /** Client-side sort of the loaded rows; newest first by default. */
  const list = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const key = (l: Lead): string | number => {
      switch (sort.key) {
        case 'name': return leadName(l).toLowerCase();
        case 'company': return leadCompany(l).toLowerCase();
        case 'by': return (l.captured_by_name ?? '').toLowerCase();
        case 'interest': return l.interest ? INTEREST_RANK[l.interest] : 0;
        case 'status': return STATUS_RANK[l.status];
        default: return l.created_at;
      }
    };
    return [...(rows ?? [])].sort((a, b) => {
      const x = key(a); const y = key(b);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }, [rows, sort]);

  const sel = useMemo(() => new Set(selected), [selected]);
  const chosen = useMemo(() => list.filter((l) => sel.has(l.id)), [list, sel]);
  const allOn = list.length > 0 && chosen.length === list.length;
  const toggleOne = (id: string, on: boolean) => setSelected((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  const toggleAll = (on: boolean) => setSelected(on ? list.map((l) => l.id) : []);

  /** Excel keeps the colours and a filter arrow per column, PDF is the printable sheet, CSV the plain list. */
  async function exportLeads(kind: ExportKind) {
    setExporting(true);
    try {
      const date = new Date().toISOString().slice(0, 10);
      const only = chosen.length ? chosen : list;
      const ctx = {
        fields: cfg.fields, tags, eventName, filters,
        filterSummary: chosen.length ? [...filterSummary(), t('{n} selected rows only', { n: chosen.length })] : filterSummary(),
        companyName: s.company?.name ?? '', photoLink: (l: Lead) => `${location.origin}/p/${l.id}`,
      };
      let blob: Blob;
      if (kind === 'xlsx') blob = await leadsToXlsx(only, ctx);
      else if (kind === 'pdf') blob = await leadsToPdf(only, ctx);
      else if (chosen.length) {
        // The server export covers the whole filter; a selection is written here.
        const csv = leadsToCsv(only, cfg.fields.map((f) => ({ key: f.key, label: f.label })), ctx.photoLink, (id) => tags.find((g) => g.id === id)?.name ?? id);
        blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      } else blob = await (await backend()).exportCsv(filters);

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `wetasnap-leads-${date}.${kind}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(tn(only.length, 'Export ready — {n} lead', 'Export ready — {n} leads'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setExporting(false);
    }
  }

  /** Plain-English list of what is filtered, written into the Excel file's second sheet and the PDF header. */
  function filterSummary() {
    const out: string[] = [];
    if (filters.q) out.push(`Search: ${filters.q}`);
    if (filters.event_ids.length) out.push(`Events: ${filters.event_ids.map(eventName).join(', ')}`);
    if (filters.captured_by.length) out.push(`Captured by: ${filters.captured_by.map((id) => people.find((p) => p.id === id)?.name ?? id).join(', ')}`);
    if (filters.tag_ids.length) out.push(`Tags: ${filters.tag_ids.map((id) => tags.find((x) => x.id === id)?.name ?? id).join(', ')}`);
    if (filters.status) out.push(`Status: ${STATUS_META[filters.status].label}`);
    if (filters.interest) out.push(`Interest: ${INTEREST_META[filters.interest].label}`);
    if (filters.from || filters.to) out.push(`Date: ${filters.from || '…'} to ${filters.to || '…'}`);
    return out.length ? out : ['No filters — all leads'];
  }

  async function run(work: (b: Awaited<ReturnType<typeof backend>>) => Promise<void>, done: string, clear = false) {
    setBusy(true);
    try {
      await work(await backend());
      toast(done, 'success');
      if (clear) setSelected([]);
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const bulkTag = (id: string, add: boolean) => run(
    (b) => b.bulkTagLeads(selected, add ? [id] : [], add ? [] : [id]),
    add ? tn(selected.length, 'Tag added to {n} lead', 'Tag added to {n} leads') : tn(selected.length, 'Tag removed from {n} lead', 'Tag removed from {n} leads'),
  );

  return (
    <div class="mx-auto max-w-7xl">
      <div class="mb-4">
        <h1 class="text-xl font-bold">{t('Leads')}</h1>
        <p class="text-sm text-muted">{s.company?.name}</p>
      </div>

      <div class="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Counter label={t('Leads in this event')} value={counters?.in_event ?? '–'} tone="brand" />
        <Counter label={t('Today')} value={counters?.today ?? '–'} tone="ocean" />
        <Counter label={t('Waiting on devices')} value={counters?.waiting ?? '–'} tone="amber" />
        <button class="text-left" onClick={() => setFilters({ ...filters, status: 'check' })}><Counter label={t('Failed to send')} value={counters?.failed ?? '–'} tone="red" /></button>
      </div>

      <SearchFilterBar value={filters} onChange={setFilters} events={cfg.events} staff={staff} tags={tags}
        actions={
          <>
            <button class="btn-secondary px-3" onClick={() => setImporting(true)} title={t('Import leads from Excel or CSV')}>
              <Upload class="size-4" /><span class="hidden lg:inline">{t('Import')}</span>
            </button>
            <button class="btn-secondary px-3" onClick={() => setHistory(true)} title={t('Import history')} aria-label={t('Import history')}>
              <Clock class="size-4" />
            </button>
            <ExportMenu
              label={t('Export')} busy={exporting} disabled={exporting || !list.length}
              note={chosen.length ? t('Export {n} selected', { n: chosen.length }) : t('Export all {n}', { n: list.length })}
              onPick={(k) => void exportLeads(k)}
            />
          </>
        } />
      {filters.import_batch_id && (
        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          <span class="inline-flex min-h-11 items-center gap-1 rounded-full bg-ocean-50 pl-3 text-xs font-semibold text-ocean-800">
            {t('Imported from {file}', { file: importName || t('a file') })}
            <button class="flex size-11 items-center justify-center rounded-full hover:bg-ocean-100" aria-label={t('Show all leads again')}
              onClick={() => setFilters({ ...filters, import_batch_id: undefined })}><X class="size-3.5" /></button>
          </span>
        </div>
      )}

      {error && <p class="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">{error}</p>}

      <div class="mt-4">
        <BulkBar count={chosen.length} onClear={() => setSelected([])}>
          <TagMenu label={t('Add tag')} icon={<Plus class="size-3.5" />} tags={tags} disabled={busy} onPick={(id) => void bulkTag(id, true)} />
          <TagMenu label={t('Remove tag')} icon={<Minus class="size-3.5" />} tags={tags} disabled={busy} onPick={(id) => void bulkTag(id, false)} />
          <button class={BULK} disabled={busy} onClick={() => void run((b) => b.bulkResendLeads(selected), tn(selected.length, '{n} lead queued for the CRM', '{n} leads queued for the CRM'))}>
            <RefreshCw class="size-3.5" />{t('Resend to CRM')}
          </button>
          <ExportMenu
            label={t('Export selected')} busy={exporting} disabled={exporting} small
            note={t('Export {n} selected', { n: chosen.length })}
            onPick={(k) => void exportLeads(k)}
          />
          <button class={`${BULK} border-red-200 text-red-700 hover:bg-red-50`} disabled={busy} onClick={() => setConfirmDelete(true)}>
            <Trash class="size-3.5" />{t('Delete')}
          </button>
        </BulkBar>
      </div>

      <div class="card mt-2 overflow-hidden">
        {rows === null ? (
          <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>
        ) : list.length === 0 ? (
          <Empty icon={<SearchX class="size-6" />} title={t('No leads match')} text={t('Try removing a filter or changing the search.')} />
        ) : (
          <>
            {/* Laptop table */}
            <table class="hidden w-full text-sm md:table">
              <thead class="bg-subtle text-left text-xs font-semibold text-muted">
                <tr>
                  <th class="w-10 px-4 py-2.5">
                    <Tick on={allOn} indeterminate={chosen.length > 0 && !allOn} onChange={toggleAll} label={t('Select all leads')} />
                  </th>
                  <SortHeader id="name" sort={sort} onSort={setSort}>{t('Name')}</SortHeader>
                  <SortHeader id="company" sort={sort} onSort={setSort}>{t('Company')}</SortHeader>
                  <SortHeader id="by" sort={sort} onSort={setSort}>{t('Captured by')}</SortHeader>
                  <SortHeader id="interest" sort={sort} onSort={setSort}>{t('Interest')}</SortHeader>
                  <SortHeader id="status" sort={sort} onSort={setSort}>{t('CRM status')}</SortHeader>
                  <SortHeader id="time" sort={sort} onSort={setSort} align="right">{t('Time')}</SortHeader>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                {list.map((l) => (
                  <tr key={l.id} class={`cursor-pointer transition hover:bg-brand-50/40 ${sel.has(l.id) ? 'bg-ocean-50/50' : ''}`} onClick={() => setOpen(l)}>
                    <td class="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <Tick on={sel.has(l.id)} onChange={(v) => toggleOne(l.id, v)} label={t('Select {name}', { name: leadName(l) })} />
                    </td>
                    <td class="px-4 py-3">
                      <p class="font-semibold">{leadName(l)}</p>
                      <p class="text-xs text-muted">{leadEmail(l) || '—'}</p>
                    </td>
                    <td class="px-4 py-3">
                      <p>{leadCompany(l) || '—'}</p>
                      <TagChips ids={l.tag_ids} tags={tags} class="mt-0.5" />
                      {filters.event_ids.length !== 1 && <p class="text-xs text-muted">{eventName(l.event_id)}</p>}
                    </td>
                    <td class="px-4 py-3 text-muted">{l.captured_by_name}</td>
                    <td class="px-4 py-3"><InterestPill interest={l.interest} /></td>
                    <td class="px-4 py-3"><StatusPill status={l.status} /></td>
                    <td class="px-4 py-3 text-right text-xs whitespace-nowrap text-muted tabular-nums">{timeAgo(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Phone list */}
            <div class="flex items-center justify-between gap-2 border-b border-line px-4 py-2 md:hidden">
              <span class="flex items-center gap-2 text-xs font-medium text-muted">
                <Tick on={allOn} indeterminate={chosen.length > 0 && !allOn} onChange={toggleAll} label={t('Select all leads')} />
                {t('Select all')}
              </span>
              <SortMenu sort={sort} onSort={setSort} options={SORT_OPTIONS()} />
            </div>
            <ul class="divide-y divide-line md:hidden">
              {list.map((l) => (
                <li key={l.id} class={`flex items-center gap-2 ${sel.has(l.id) ? 'bg-ocean-50/50' : ''}`}>
                  <span class="flex min-h-11 items-center pl-4">
                    <Tick on={sel.has(l.id)} onChange={(v) => toggleOne(l.id, v)} label={t('Select {name}', { name: leadName(l) })} />
                  </span>
                  <button class="flex min-h-11 w-full flex-1 items-center gap-3 py-3 pr-4 pl-1 text-left" onClick={() => setOpen(l)}>
                    <Avatar name={leadName(l)} />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-semibold">{leadName(l)}</span>
                      <span class="block truncate text-xs text-muted">{[leadCompany(l), l.captured_by_name].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span class="flex flex-col items-end gap-1"><StatusPill status={l.status} /><span class="text-xs text-muted">{timeAgo(l.created_at)}</span></span>
                    <ChevronRight class="size-4 shrink-0 text-muted" />
                  </button>
                </li>
              ))}
            </ul>
            <p class="border-t border-line px-4 py-2 text-xs text-muted">{tn(list.length, '{n} lead', '{n} leads')}</p>
          </>
        )}
      </div>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t('Delete leads?')}
        footer={<>
          <button class="btn-ghost" onClick={() => setConfirmDelete(false)}>{t('Cancel')}</button>
          <button class="btn-danger" disabled={busy} onClick={() => { setConfirmDelete(false); void run((b) => b.bulkDeleteLeads(selected), tn(selected.length, '{n} lead deleted', '{n} leads deleted'), true); }}>
            {busy ? <Spinner /> : <Trash class="size-4" />}{t('Delete')}
          </button>
        </>}>
        <p class="text-sm">{tn(chosen.length, '{n} lead will be deleted.', '{n} leads will be deleted.')}</p>
        <p class="mt-2 text-sm text-muted">{t('They leave the list now and can be restored for 30 days; after that they are gone for good. Anything already sent to your CRM stays there.')}</p>
      </Dialog>

      <LeadDetail lead={open} tags={tags} mode="admin" onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} />
      <ImportLeads open={importing} onClose={() => setImporting(false)} tags={tags} onImported={reload} />
      <ImportHistory open={history} tags={tags} onClose={() => setHistory(false)}
        onView={(b) => { setHistory(false); setImportName(b.file_name); setFilters({ ...emptyFilters(), import_batch_id: b.id }); }} />
    </div>
  );
}

const SORT_OPTIONS = () => [
  { id: 'time', label: t('Time') },
  { id: 'name', label: t('Name') },
  { id: 'company', label: t('Company') },
  { id: 'by', label: t('Captured by') },
  { id: 'interest', label: t('Interest') },
  { id: 'status', label: t('CRM status') },
];

/** Excel / CSV / PDF picker — used in the actions row and again in the bulk bar. */
function ExportMenu({ label, note, busy, disabled, small, onPick }: {
  label: string; note: string; busy: boolean; disabled?: boolean; small?: boolean; onPick: (k: ExportKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (k: ExportKind) => { setOpen(false); onPick(k); };
  return (
    <div class="relative">
      <button class={small ? BULK : 'btn-secondary px-3'} disabled={disabled} onClick={() => setOpen((o) => !o)} aria-expanded={open} title={t('Export Excel / CSV / PDF')}>
        {busy ? <Spinner class={small ? 'size-3.5' : 'size-4'} /> : <Download class={small ? 'size-3.5' : 'size-4'} />}
        <span class={small ? '' : 'hidden lg:inline'}>{label}</span>
        <ChevronDown class="size-3 opacity-60" />
      </button>
      {open && (
        <>
          <div class="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div class="absolute top-full right-0 z-40 mt-2 w-64 overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
            <p class="border-b border-line bg-subtle px-4 py-2 text-xs font-semibold text-muted">{note}</p>
            <button class="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-subtle" onClick={() => pick('xlsx')}>
              <FileSpreadsheet class="size-4 text-brand-700" />
              <span><span class="block font-semibold">{t('Excel (.xlsx)')}</span><span class="text-xs text-muted">{t('Formatted table with filters')}</span></span>
            </button>
            <button class="flex min-h-11 w-full items-center gap-3 border-t border-line px-4 py-3 text-left text-sm hover:bg-subtle" onClick={() => pick('pdf')}>
              <FileDown class="size-4 text-brand-700" />
              <span><span class="block font-semibold">{t('PDF')}</span><span class="text-xs text-muted">{t('Printable sheet to share')}</span></span>
            </button>
            <button class="flex min-h-11 w-full items-center gap-3 border-t border-line px-4 py-3 text-left text-sm hover:bg-subtle" onClick={() => pick('csv')}>
              <FileText class="size-4 text-ocean-700" />
              <span><span class="block font-semibold">{t('CSV')}</span><span class="text-xs text-muted">{t('Plain list for any system')}</span></span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Small popover of the company's tags, for adding one to or removing one from the ticked leads. */
function TagMenu({ label, icon, tags, disabled, onPick }: {
  label: string; icon: ComponentChildren; tags: Tag[]; disabled?: boolean; onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div class="relative">
      <button class={BULK} disabled={disabled} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {icon}{label}<ChevronDown class="size-3 opacity-60" />
      </button>
      {open && (
        <>
          <div class="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div class="absolute top-full left-0 z-40 mt-2 max-h-64 w-56 overflow-y-auto rounded-2xl border border-line bg-surface p-1 shadow-xl">
            {tags.length === 0 && <p class="px-3 py-3 text-xs text-muted">{t('No tags yet — an admin can add them in Settings.')}</p>}
            {tags.map((g) => (
              <button key={g.id} class="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-subtle"
                onClick={() => { setOpen(false); onPick(g.id); }}>
                <span class={`size-2 shrink-0 rounded-full ${TAG_META[g.colour].dot}`} />
                <span class="min-w-0 flex-1 truncate">{g.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
