import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  AlertCircle, ArrowRight, Check, CheckCircle2, Clock, Download,
  FileDown, FileSpreadsheet, FileText, Mail,
  Phone, RefreshCw, Search, SearchX, SlidersHorizontal,
  Trash, Upload, Users, User, X, Zap, ChevronDown,
} from 'lucide-preact';
import { SearchFilterBar } from '../components/SearchFilterBar';
import { LeadDetail } from '../components/LeadDetail';
import { ImportLeads } from '../components/ImportLeads';
import { ImportHistory } from '../components/ImportHistory';
import { Avatar, BulkBar, Dialog, Empty, InterestPill, SortHeader, Spinner, StatusPill, Tick } from '../components/ui';
import { backend, type Counters, type PersonRow } from '../lib/backend';
import { leadsToXlsx } from '../lib/xlsx';
import { leadsToPdf } from '../lib/pdf';
import { useStore, toast } from '../lib/store';
import { config, session } from '../lib/session';
import { net } from '../lib/net';
import { db } from '../lib/db';
import { leadCompany, leadEmail, leadName, leadsToCsv } from '../lib/leads';
import { emptyFilters, type Lead, type LeadFilters, type Sort, type Tag } from '../lib/types';
import { timeAgo } from '../lib/id';
import { t, tn } from '../lib/i18n';

type ExportKind = 'xlsx' | 'csv' | 'pdf';

const INTEREST_RANK: Record<string, number> = { wetaloop: 5, wetanalytics: 4, hot: 3, warm: 2, other: 2, cold: 1 };
const STATUS_RANK: Record<Lead['status'], number> = { waiting: 0, synced: 1, in_crm: 2, check: 3 };

export default function Leads() {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const n = useStore(net);
  const { query } = useLocation();

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
  const [open, setOpen] = useState<Lead | null>(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>({ key: 'time', dir: 'desc' });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showFiltersModal, setShowFiltersModal] = useState(false);
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const longPressTimer = useRef<number | null>(null);
  const isLongPress = useRef(false);

  const startLongPress = (id: string) => {
    isLongPress.current = false;
    longPressTimer.current = window.setTimeout(() => {
      isLongPress.current = true;
      toggleOne(id, !sel.has(id));
      if (navigator.vibrate) navigator.vibrate(50);
    }, 500);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const reload = () => setTick((x) => x + 1);

  useEffect(() => {
    const asked = (query.status ?? '') as LeadFilters['status'];
    setFilters((f) => (f.status === asked ? f : { ...f, status: asked }));
  }, [query.status]);

  const headerEvent = useRef(s.event_id);
  useEffect(() => {
    if (s.person.role === 'individual') return;
    if (s.event_id === headerEvent.current) return;
    headerEvent.current = s.event_id;
    setFilters((f) => ({ ...f, event_ids: s.event_id ? [s.event_id] : [] }));
    setSelected([]);
  }, [s.event_id, s.person.role]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const b = await backend();
        const [r, c] = await Promise.all([b.listLeads(filters), b.counters(filters.event_ids[0] || s.event_id || '')]);
        if (!live) return;

        // If local unsynced leads exist on this device, merge them so newly scanned cards appear immediately
        if (s.person.role === 'individual') {
          const localLeads = await db.leads
            .filter((l) => !l.deleted_at && l.captured_by === s.person.id)
            .toArray();
          const serverMap = new Map((r ?? []).map((x) => [x.id, x]));
          for (const loc of localLeads) {
            if (!serverMap.has(loc.id)) {
              serverMap.set(loc.id, loc);
            }
          }
          const combined = Array.from(serverMap.values());
          setRows(combined);
        } else {
          setRows(r);
        }
        setCounters(c);
        setError('');
      } catch (e) {
        // In offline mode or network error, fallback to local database leads
        try {
          const localLeads = await db.leads
            .filter((l) => !l.deleted_at && (s.person.role === 'individual' ? l.captured_by === s.person.id : true))
            .toArray();
          if (live && localLeads.length > 0) {
            setRows(localLeads);
            setError('');
            return;
          }
        } catch {}
        if (live) setError((e as Error).message === 'offline' ? t('You are offline. Leads will load when the connection returns.') : (e as Error).message);
      }
    })();
    return () => { live = false; };
  }, [filters, tick, n.online, n.simulatedOffline]);

  useEffect(() => {
    void backend().then((b) => b.people()).then(setPeople).catch(() => {});
    void backend().then((b) => b.tags()).then(setTags).catch(() => {});
  }, []);

  useEffect(() => { const h = setInterval(reload, 15_000); return () => clearInterval(h); }, []);
  useEffect(() => { setSelected([]); }, [filters]);

  useEffect(() => {
    if (!rows) return;
    const ids = new Set(rows.map((r) => r.id));
    setSelected((prev) => (prev.every((id) => ids.has(id)) ? prev : prev.filter((id) => ids.has(id))));
  }, [rows]);

  const orgPeople = useMemo(() => {
    if (s.person.role === 'individual') return [];
    if (s.person.role === 'client_admin') {
      return people.filter((p) => p.company_id === s.person.company_id);
    }
    if (s.person.role === 'organizer') {
      return people.filter((p) => p.organizer_id === s.person.id || p.id === s.person.id);
    }
    return people;
  }, [people, s.person.role, s.person.company_id, s.person.id]);

  const staff = useMemo(() => orgPeople.map((p) => ({ id: p.id, name: p.name })), [orgPeople]);
  const [userTotals, setUserTotals] = useState<Map<string, { id: string; name: string; count: number }>>(new Map());

  // Capture and lock in true full counts when viewing all reps (captured_by is empty)
  useEffect(() => {
    if (!rows) return;
    if (filters.captured_by.length === 0) {
      const validOrgUserIds = new Set(orgPeople.map((p) => p.id));
      const map = new Map<string, { id: string; name: string; count: number }>();
      for (const l of rows) {
        const id = l.captured_by || 'unknown';
        // Only include if belonging to this organization/team
        if (validOrgUserIds.size > 0 && !validOrgUserIds.has(id)) continue;
        const name = l.captured_by_name || 'Staff';
        const cur = map.get(id) ?? { id, name, count: 0 };
        cur.count++;
        map.set(id, cur);
      }
      for (const p of orgPeople) {
        if (!map.has(p.id)) {
          map.set(p.id, { id: p.id, name: p.name, count: p.lead_count ?? 0 });
        }
      }
      setUserTotals(map);
    }
  }, [rows, orgPeople, filters.captured_by.length]);

  const usersWithCounts = useMemo(() => {
    // If we have preserved master counts, keep them visible so clicking one rep never zeroes out others
    if (userTotals.size > 0) {
      return Array.from(userTotals.values()).sort((a, b) => b.count - a.count);
    }
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const p of orgPeople) {
      map.set(p.id, { id: p.id, name: p.name, count: p.lead_count ?? 0 });
    }
    const validOrgUserIds = new Set(orgPeople.map((p) => p.id));
    for (const l of rows ?? []) {
      const id = l.captured_by || 'unknown';
      if (validOrgUserIds.size > 0 && !validOrgUserIds.has(id)) continue;
      const name = l.captured_by_name || 'Staff';
      const cur = map.get(id) ?? { id, name, count: 0 };
      if (!map.has(id)) cur.count++;
      map.set(id, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [userTotals, rows, orgPeople]);

  const totalAllUsersCount = useMemo(() => {
    if (userTotals.size > 0) {
      return Array.from(userTotals.values()).reduce((sum, u) => sum + u.count, 0);
    }
    return rows?.length ?? 0;
  }, [userTotals, rows]);

  const activeEvent = cfg.events.find((e) => e.id === s.event_id);
  const eventName = (id: string) => cfg.events.find((e) => e.id === id)?.name ?? '—';

  const list = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const key = (l: Lead): string | number => {
      switch (sort.key) {
        case 'name': return leadName(l).toLowerCase();
        case 'company': return leadCompany(l).toLowerCase();
        case 'by': return (l.captured_by_name ?? '').toLowerCase();
        case 'interest': return l.interest ? (INTEREST_RANK[l.interest] ?? 0) : 0;
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

  async function exportLeads(kind: ExportKind) {
    setExporting(true);
    try {
      const date = new Date().toISOString().slice(0, 10);
      const only = chosen.length ? chosen : list;
      const ctx = {
        fields: cfg.fields, tags, eventName, filters,
        filterSummary: chosen.length ? [t('{n} selected rows only', { n: chosen.length })] : [],
        companyName: s.company?.name ?? '', photoLink: (l: Lead) => `${location.origin}/p/${l.id}`,
      };
      let blob: Blob;
      if (kind === 'xlsx') blob = await leadsToXlsx(only, ctx);
      else if (kind === 'pdf') blob = await leadsToPdf(only, ctx);
      else if (chosen.length) {
        const csv = leadsToCsv(only, cfg.fields.map((f) => ({ key: f.key, label: f.label })), ctx.photoLink, (id) => tags.find((g) => g.id === id)?.name ?? id);
        blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      } else blob = await (await backend()).exportCsv(filters);

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `wetasnap-leads-${date}.${kind}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(tn(only.length, 'Export ready — {n} lead', 'Export ready — {n} leads'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setExporting(false);
    }
  }

  async function run(fn: (b: Awaited<ReturnType<typeof backend>>) => Promise<unknown>, msg: string, deletes = false) {
    setBusy(true);
    try {
      await fn(await backend());
      if (deletes && selected.length > 0) {
        const now = new Date().toISOString();
        await Promise.all(selected.map((id) => db.leads.update(id, { deleted_at: now }).catch(() => 0)));
      }
      toast(msg, 'success');
      if (deletes) setSelected([]);
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mx-auto w-full max-w-5xl pb-12">
      {/* ── Context Banner / Event Anchor ── */}
      {activeEvent && (
        <div class="mb-3.5 flex items-center justify-between rounded-xl border border-line bg-subtle px-3.5 py-2 text-xs">
          <div class="flex items-center gap-2 min-w-0">
            <span class="size-2 rounded-full bg-brand-500 animate-pulse shrink-0"></span>
            <span class="font-semibold text-ink truncate">{t('Active:')} {activeEvent.name}</span>
          </div>
          <span class="text-muted shrink-0 ml-2">{activeEvent.booth ? `Booth ${activeEvent.booth}` : activeEvent.venue || t('Live Event')}</span>
        </div>
      )}

      {/* ── Page Header ── */}
      <div class="mb-3.5 flex items-center justify-between gap-3">
        <div>
          <div class="flex items-center gap-2 mb-0.5">
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold bg-ocean-50 border border-ocean-200 text-ocean-700">
              <Users class="size-3.5" />
              {s.person.role === 'individual' ? t('My Scans') : t('Company Directory')}
            </span>
            {s.company?.name && <span class="text-xs text-muted">· {s.company.name}</span>}
          </div>
          <h1 class="text-2xl font-bold tracking-tight text-ink">{s.person.role === 'individual' ? t('My Captured Cards') : t('All Leads')}</h1>
        </div>

        <div class="flex items-center gap-1.5 text-xs text-muted">
          <span class="font-bold text-ink">{list.length}</span>
          <span>{tn(list.length, 'lead', 'leads')}</span>
        </div>
      </div>

      {/* ── Search & Filter Controls (with Download beside Search) ── */}
      <div class="mb-3 flex items-center gap-2">
        <div class="relative flex-1 min-w-0">
          <Search class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted" />
          <input
            type="search"
            value={filters.q}
            onInput={(e) => setFilters({ ...filters, q: e.currentTarget.value })}
            placeholder={t('Search lead, company, role, or rep...')}
            class="input pl-9 pr-8 text-sm"
          />
          {filters.q && (
            <button
              onClick={() => setFilters({ ...filters, q: '' })}
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink p-1"
            >
              <X class="size-3.5" />
            </button>
          )}
        </div>

        {/* Download / Export Dropdown */}
        <div class="relative shrink-0">
          <button
            onClick={() => setShowExportMenu((v) => !v)}
            disabled={exporting || !list.length}
            class="btn-secondary min-h-11 px-3 text-xs font-semibold gap-1.5"
            title={t('Download / Export leads')}
          >
            {exporting ? <Spinner class="size-4" /> : <Download class="size-4 text-brand-600" />}
            <span class="hidden sm:inline">{t('Download')}</span>
            <ChevronDown class="size-3 opacity-60" />
          </button>

          {showExportMenu && (
            <>
              <div class="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
              <div class="absolute right-0 top-full mt-1.5 z-50 w-56 rounded-2xl border border-line bg-surface shadow-xl overflow-hidden py-1">
                <div class="px-3.5 py-2 border-b border-line bg-subtle/50 text-[11px] font-semibold text-muted">
                  {chosen.length ? t('{n} selected leads', { n: chosen.length }) : t('All {n} leads', { n: list.length })}
                </div>
                <button
                  class="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-xs font-semibold text-ink hover:bg-subtle transition-colors"
                  onClick={() => { setShowExportMenu(false); void exportLeads('xlsx'); }}
                >
                  <FileSpreadsheet class="size-4 text-brand-600 shrink-0" />
                  <div>
                    <span class="block">{t('Excel (.xlsx)')}</span>
                    <span class="block text-[10px] text-muted font-normal">{t('Formatted spreadsheet')}</span>
                  </div>
                </button>
                <button
                  class="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-xs font-semibold text-ink hover:bg-subtle transition-colors border-t border-line"
                  onClick={() => { setShowExportMenu(false); void exportLeads('csv'); }}
                >
                  <FileText class="size-4 text-ocean-600 shrink-0" />
                  <div>
                    <span class="block">{t('CSV (.csv)')}</span>
                    <span class="block text-[10px] text-muted font-normal">{t('Standard spreadsheet list')}</span>
                  </div>
                </button>
                <button
                  class="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-xs font-semibold text-ink hover:bg-subtle transition-colors border-t border-line"
                  onClick={() => { setShowExportMenu(false); void exportLeads('pdf'); }}
                >
                  <FileDown class="size-4 text-red-600 shrink-0" />
                  <div>
                    <span class="block">{t('PDF (.pdf)')}</span>
                    <span class="block text-[10px] text-muted font-normal">{t('Printable document')}</span>
                  </div>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Filter Toggle (Hidden for individuals / solo users) */}
        {s.person.role !== 'individual' && (
          <button
            onClick={() => setShowFiltersModal((v) => !v)}
            class={`btn-secondary min-h-11 px-3 text-xs font-semibold gap-1.5 shrink-0 ${
              showFiltersModal ? 'border-brand-500 bg-brand-50 text-brand-700' : ''
            }`}
            title={t('Filters')}
          >
            <SlidersHorizontal class="size-4" />
            <span class="hidden sm:inline">{t('Filters')}</span>
          </button>
        )}

        {/* Import Action (Admin) */}
        {s.person.role === 'client_admin' && (
          <button
            onClick={() => setImporting(true)}
            class="btn-secondary min-h-11 px-3 text-xs font-semibold gap-1.5 shrink-0"
            title={t('Import Excel or CSV')}
          >
            <Upload class="size-4 text-muted" />
            <span class="hidden md:inline">{t('Import')}</span>
          </button>
        )}
      </div>

      {/* Expanded Filter Panel */}
      {showFiltersModal && (
        <div class="mb-3.5 p-4 rounded-xl border border-line bg-subtle">
          <SearchFilterBar
            value={filters}
            onChange={setFilters}
            events={cfg.events}
            staff={staff}
            tags={tags}
            actions={
              <button
                onClick={() => setFilters(emptyFilters())}
                class="btn-ghost text-xs"
              >
                {t('Reset')}
              </button>
            }
          />
        </div>
      )}

      {/* ── User / Representative Filter Strip (Only for organizations with multiple team members) ── */}
      {s.person.role !== 'individual' && usersWithCounts.length > 0 && (
        <div class="mb-3 flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 text-xs">
          <span class="text-[11px] font-bold uppercase tracking-wider text-muted shrink-0 mr-1 flex items-center gap-1">
            <User class="size-3 text-brand-600" />
            <span>{t('By User:')}</span>
          </span>
          <button
            onClick={() => setFilters((f) => ({ ...f, captured_by: [] }))}
            class={`shrink-0 rounded-full px-3 py-1 font-semibold flex items-center gap-1.5 transition ${
              !filters.captured_by.length
                ? 'bg-ink text-surface font-bold shadow-sm'
                : 'card hover:bg-subtle text-muted hover:text-ink'
            }`}
          >
            <span>{t('All Users')}</span>
            <span class="opacity-75 font-mono text-[10px]">({totalAllUsersCount})</span>
          </button>
          {usersWithCounts.map((u) => {
            const isSelected = filters.captured_by.includes(u.id);
            return (
              <button
                key={u.id}
                onClick={() => setFilters((f) => ({
                  ...f,
                  captured_by: isSelected ? [] : [u.id],
                }))}
                class={`shrink-0 rounded-full px-2.5 py-1 font-semibold flex items-center gap-1.5 transition ${
                  isSelected
                    ? 'bg-brand-500 text-white font-bold shadow-sm ring-2 ring-brand-300'
                    : 'card hover:bg-subtle text-muted hover:text-ink'
                }`}
                title={t('Show leads scanned by {name}', { name: u.name })}
              >
                <Avatar name={u.name} size="size-4 text-[9px]" />
                <span class="truncate max-w-[120px]">{u.name}</span>
                <span class={`font-mono text-[10px] ${isSelected ? 'text-white' : 'text-brand-700 font-bold'}`}>
                  ({u.count})
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Filters Dropdowns & View Toggle Row ── */}
      <div class="mb-3.5 flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          {/* All Events Dropdown (hidden for individual accounts who have no events) */}
          {s.person.role !== 'individual' && cfg.events.length > 0 && (
            <div class="relative">
              <select
                class="input text-xs font-semibold py-1.5 pl-3 pr-8 h-9 border-line bg-surface rounded-xl"
                value={filters.event_ids[0] ?? ''}
                onChange={(e) => {
                  const val = e.currentTarget.value;
                  setFilters((f) => ({ ...f, event_ids: val ? [val] : [] }));
                }}
              >
                <option value="">{t('All Events')}</option>
                {cfg.events.map((ev) => (
                  <option key={ev.id} value={ev.id}>{ev.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Product Interest Dropdown */}
          <div class="relative">
            <select
              class="input text-xs font-semibold py-1.5 pl-3 pr-8 h-9 border-line bg-surface rounded-xl"
              value={filters.interest || ''}
              onChange={(e) => {
                const val = e.currentTarget.value as LeadFilters['interest'];
                setFilters((f) => ({ ...f, interest: val }));
              }}
            >
              <option value="">{t('All Interests')}</option>
              <option value="wetaloop">WeTaLoop</option>
              <option value="wetanalytics">WeTaAnalytics</option>
              <option value="other">{t('Other')}</option>
            </select>
          </div>

          {/* Status Dropdown */}
          <div class="relative">
            <select
              class="input text-xs font-semibold py-1.5 pl-3 pr-8 h-9 border-line bg-surface rounded-xl"
              value={filters.status || ''}
              onChange={(e) => {
                const val = e.currentTarget.value as LeadFilters['status'];
                setFilters((f) => ({ ...f, status: val }));
              }}
            >
              <option value="">{t('All Statuses')}</option>
              <option value="check">{t('Needs Check')}</option>
              <option value="in_crm">{t('CRM Synced')}</option>
              <option value="synced">{t('Synced')}</option>
            </select>
          </div>
        </div>

        {/* View Mode Toggle: Beside the dropdowns */}
        <div class="flex items-center gap-1 shrink-0 bg-subtle p-0.5 rounded-xl border border-line h-9">
          <button
            onClick={() => setViewMode('cards')}
            class={`px-3 py-1 rounded-lg text-xs font-semibold transition ${viewMode === 'cards' ? 'bg-surface font-bold text-ink border border-line shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            {t('Cards')}
          </button>
          <button
            onClick={() => setViewMode('table')}
            class={`px-3 py-1 rounded-lg text-xs font-semibold transition ${viewMode === 'table' ? 'bg-surface font-bold text-ink border border-line shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            {t('Table')}
          </button>
        </div>
      </div>

      {/* ── Telemetry Counter Strip ── */}
      {s.person.role === 'individual' ? (
        /* Solo Operator: Personal Scans Only */
        <div class="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <div class="card p-3.5 flex flex-col justify-between border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent">
            <div class="flex items-center justify-between text-muted mb-1">
              <span class="text-[10px] font-bold uppercase tracking-wider">{t('My Captured Cards')}</span>
              <span class="w-6 h-6 rounded-md bg-emerald-500/15 flex items-center justify-center">
                <Users class="size-3.5 text-emerald-600 dark:text-emerald-400" />
              </span>
            </div>
            <div class="flex items-baseline gap-1.5">
              <span class="text-xl font-bold text-emerald-600 dark:text-emerald-400">{list.length}</span>
              <span class="text-[10px] font-semibold text-emerald-600/80 dark:text-emerald-400/80">{t('Total')}</span>
            </div>
          </div>

          <div class="card p-3.5 flex flex-col justify-between border-sky-500/25 bg-gradient-to-br from-sky-500/10 via-sky-500/5 to-transparent">
            <div class="flex items-center justify-between text-muted mb-1">
              <span class="text-[10px] font-bold uppercase tracking-wider">{t('Scanned Today')}</span>
              <span class="w-6 h-6 rounded-md bg-sky-500/15 flex items-center justify-center">
                <Zap class="size-3.5 text-sky-600 dark:text-sky-400" />
              </span>
            </div>
            <div class="flex items-baseline gap-1.5">
              <span class="text-xl font-bold text-sky-600 dark:text-sky-400">
                {list.filter((l) => new Date(l.created_at).toDateString() === new Date().toDateString()).length}
              </span>
              <span class="text-[10px] text-muted">{t('today')}</span>
            </div>
          </div>

          <div class="card p-3.5 flex flex-col justify-between border-amber-500/25 bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent">
            <div class="flex items-center justify-between text-muted mb-1">
              <span class="text-[10px] font-bold uppercase tracking-wider">{t('Needs Review')}</span>
              <span class="w-6 h-6 rounded-md bg-amber-500/15 flex items-center justify-center">
                <AlertCircle class="size-3.5 text-amber-600 dark:text-amber-400" />
              </span>
            </div>
            <div class="flex items-baseline gap-1.5">
              <span class="text-xl font-bold text-amber-600 dark:text-amber-400">
                {list.filter((l) => l.status === 'check').length}
              </span>
              <span class="text-[10px] text-amber-600/80 dark:text-amber-400/80 font-medium">{t('review')}</span>
            </div>
          </div>
        </div>
      ) : (
        /* Team / Organization Accounts */
        <div class="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div class="card p-3.5 flex flex-col justify-between border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent">
            <div class="flex items-center justify-between text-muted mb-1">
              <span class="text-[10px] font-bold uppercase tracking-wider">{t('Total Event Leads')}</span>
              <span class="w-6 h-6 rounded-md bg-emerald-500/15 flex items-center justify-center">
                <Users class="size-3.5 text-emerald-600 dark:text-emerald-400" />
              </span>
            </div>
            <div class="flex items-baseline gap-1.5">
              <span class="text-xl font-bold text-emerald-600 dark:text-emerald-400">{counters?.in_event ?? list.length}</span>
              <span class="text-[10px] font-semibold text-emerald-600/80 dark:text-emerald-400/80">Live</span>
            </div>
          </div>

          <div class="card p-3.5 flex flex-col justify-between border-sky-500/25 bg-gradient-to-br from-sky-500/10 via-sky-500/5 to-transparent">
            <div class="flex items-center justify-between text-muted mb-1">
              <span class="text-[10px] font-bold uppercase tracking-wider">{t('Team Scans Today')}</span>
              <span class="w-6 h-6 rounded-md bg-sky-500/15 flex items-center justify-center">
                <Zap class="size-3.5 text-sky-600 dark:text-sky-400" />
              </span>
            </div>
            <div class="flex items-baseline gap-1.5">
              <span class="text-xl font-bold text-sky-600 dark:text-sky-400">{counters?.today ?? '–'}</span>
              <span class="text-[10px] text-muted">{t('today')}</span>
            </div>
          </div>

          <div class="card p-3.5 flex flex-col justify-between border-amber-500/25 bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent">
            <div class="flex items-center justify-between text-muted mb-1">
              <span class="text-[10px] font-bold uppercase tracking-wider">{t('Waiting on Devices')}</span>
              <span class="w-6 h-6 rounded-md bg-amber-500/15 flex items-center justify-center">
                <Clock class="size-3.5 text-amber-600 dark:text-amber-400" />
              </span>
            </div>
            <div class="flex items-baseline gap-1.5">
              <span class="text-xl font-bold text-amber-600 dark:text-amber-400">{counters?.waiting ?? '–'}</span>
              <span class="text-[10px] text-muted">{t('pending')}</span>
            </div>
          </div>

          <div class="card p-3.5 flex flex-col justify-between border-rose-500/25 bg-gradient-to-br from-rose-500/10 via-rose-500/5 to-transparent">
            <div class="flex items-center justify-between text-muted mb-1">
              <span class="text-[10px] font-bold uppercase tracking-wider">{t('Failed / Attention')}</span>
              <span class="w-6 h-6 rounded-md bg-rose-500/15 flex items-center justify-center">
                <AlertCircle class="size-3.5 text-rose-600 dark:text-rose-400" />
              </span>
            </div>
            <div class="flex items-baseline gap-1.5">
              <span class="text-xl font-bold text-rose-600 dark:text-rose-400">{counters?.failed ?? '–'}</span>
              <span class="text-[10px] text-rose-600/80 dark:text-rose-400/80 font-medium">{t('review')}</span>
            </div>
          </div>
        </div>
      )}

      {error && <p class="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">{error}</p>}

      {/* ── Selection Bulk Action Bar ── */}
      {chosen.length > 0 && (
        <div class="mb-3.5">
          <BulkBar count={chosen.length} onClear={() => setSelected([])}>
            <button
              class="btn-secondary h-8 px-2.5 text-xs font-semibold gap-1"
              disabled={busy}
              onClick={() => void run((b) => b.bulkResendLeads(selected), tn(selected.length, '{n} lead queued for the CRM', '{n} leads queued for the CRM'))}
            >
              <RefreshCw class="size-3.5" />
              <span>{t('Resend to CRM')}</span>
            </button>
            <button
              class="btn-secondary h-8 px-2.5 text-xs font-semibold gap-1"
              onClick={() => void exportLeads('xlsx')}
            >
              <Download class="size-3.5" />
              <span>{t('Export XLSX')}</span>
            </button>
            <button
              class="btn-danger h-8 px-2.5 text-xs font-semibold gap-1"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash class="size-3.5" />
              <span>{t('Recycle bin')}</span>
            </button>
          </BulkBar>
        </div>
      )}

      {/* ── Leads Feed: Cards or Table ── */}
      {rows === null ? (
        <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>
      ) : list.length === 0 ? (
        <Empty
          icon={<SearchX class="size-6" />}
          title={t('No leads match')}
          text={t('Try removing a filter or changing the search.')}
        />
      ) : viewMode === 'table' ? (
        /* Table View */
        <div class="card overflow-hidden overflow-x-auto">
          <table class="w-full text-sm min-w-[640px]">
            <thead class="bg-subtle text-left text-xs font-semibold text-muted border-b border-line">
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
                <tr key={l.id} class={`cursor-pointer transition hover:bg-subtle ${sel.has(l.id) ? 'bg-ocean-50/50' : ''}`} onClick={() => setOpen(l)}>
                  <td class="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <Tick on={sel.has(l.id)} onChange={(v) => toggleOne(l.id, v)} label={t('Select {name}', { name: leadName(l) })} />
                  </td>
                  <td class="px-4 py-3 font-semibold text-ink">{leadName(l)}</td>
                  <td class="px-4 py-3">{leadCompany(l) || '—'}</td>
                  <td class="px-4 py-3 text-muted" onClick={(e) => {
                    if (l.captured_by) {
                      e.stopPropagation();
                      setFilters((f) => ({ ...f, captured_by: [l.captured_by] }));
                    }
                  }}>
                    <button class="hover:text-brand-600 hover:underline font-medium text-left" title={t('Filter leads scanned by {name}', { name: l.captured_by_name || 'this rep' })}>
                      {l.captured_by_name || '—'}
                    </button>
                  </td>
                  <td class="px-4 py-3"><InterestPill interest={l.interest} /></td>
                  <td class="px-4 py-3"><StatusPill status={l.status} /></td>
                  <td class="px-4 py-3 text-right text-xs text-muted tabular-nums">{timeAgo(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        /* Structured Precision Cards Feed (Long-press card to select) */
        <div class="flex flex-col gap-2.5">
          {list.map((l) => {
            const isHot = l.interest === 'hot';
            const isWarm = l.interest === 'warm';
            const phone = l.fields.phone?.value?.trim() || '';
            const email = leadEmail(l) || '';
            const isSelected = sel.has(l.id);

            return (
              <article
                key={l.id}
                onMouseDown={() => startLongPress(l.id)}
                onMouseUp={cancelLongPress}
                onMouseLeave={cancelLongPress}
                onTouchStart={() => startLongPress(l.id)}
                onTouchEnd={cancelLongPress}
                onClick={() => {
                  if (isLongPress.current) {
                    isLongPress.current = false;
                    return;
                  }
                  if (chosen.length > 0) {
                    toggleOne(l.id, !isSelected);
                  } else {
                    setOpen(l);
                  }
                }}
                class={`card p-3.5 flex flex-col gap-2.5 transition select-none cursor-pointer hover:border-brand-300 ${
                  isSelected ? 'border-brand-500 bg-brand-50/30 ring-2 ring-brand-300' : ''
                }`}
              >
                {/* Header row: Selection indicator (active in selection mode) + Name + Rating Badge */}
                <div class="flex items-start justify-between gap-2">
                  <div class="flex items-start gap-2.5 min-w-0 flex-1">
                    {chosen.length > 0 && (
                      <span class={`size-5 rounded-full border flex items-center justify-center shrink-0 mt-0.5 transition ${
                        isSelected ? 'bg-brand-600 border-brand-600 text-white' : 'border-line bg-surface'
                      }`}>
                        {isSelected && <Check class="size-3 stroke-[3]" />}
                      </span>
                    )}
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2 flex-wrap">
                        <h2 class="text-base font-bold text-ink leading-tight truncate">{leadName(l)}</h2>
                        {isHot && (
                          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-red-500/10 text-red-600 border border-red-500/30">
                            <span class="size-1 rounded-full bg-red-500"></span>
                            {t('Hot Lead')}
                          </span>
                        )}
                        {isWarm && (
                          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-ocean-500/10 text-ocean-700 border border-ocean-500/30">
                            {t('Warm Lead')}
                          </span>
                        )}
                        {l.status === 'check' && (
                          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/10 text-amber-800 border border-amber-500/30">
                            {t('Review')}
                          </span>
                        )}
                      </div>
                      <p class="text-xs text-muted truncate mt-0.5">
                        {l.fields.job_title?.value ? `${l.fields.job_title.value} • ` : ''}
                        <span class="text-ink font-medium">{leadCompany(l) || '—'}</span>
                      </p>
                    </div>
                  </div>
                </div>

                {/* Metadata subline: Scanner Rep (for org/organizer), Time, Event, CRM sync */}
                <div class="flex flex-wrap items-center justify-between text-xs text-muted pt-2 border-t border-line gap-2">
                  <div class="flex items-center gap-2 flex-wrap">
                    {/* Show scanner rep for client_admin and organizer */}
                    {(s.person.role === 'client_admin' || s.person.role === 'organizer') && l.captured_by_name && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (l.captured_by) {
                            setFilters((f) => ({ ...f, captured_by: [l.captured_by] }));
                          }
                        }}
                        class="text-ink font-semibold hover:text-brand-600 hover:underline flex items-center gap-1 cursor-pointer transition-colors"
                        title={t('Filter leads scanned by {name}', { name: l.captured_by_name })}
                      >
                        <User class="size-3 text-brand-600" />
                        <span>{t('Rep: {name}', { name: l.captured_by_name })}</span>
                      </button>
                    )}
                    {(s.person.role === 'client_admin' || s.person.role === 'organizer') && l.captured_by_name && <span>•</span>}
                    <span class="tabular-nums flex items-center gap-1 font-medium text-ink">
                      <Clock class="size-3 text-muted" />
                      {s.person.role === 'individual' ? (
                        <span>{new Date(l.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} · {new Date(l.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      ) : (
                        <span>{new Date(l.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })} · {new Date(l.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ({timeAgo(l.created_at)})</span>
                      )}
                    </span>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    {s.person.role !== 'individual' && eventName(l.event_id) && (
                      <span class="px-1.5 py-0.5 rounded bg-subtle border border-line text-[11px]">
                        {eventName(l.event_id)}
                      </span>
                    )}
                    {s.person.role !== 'individual' && l.status === 'in_crm' && (
                      <span class="inline-flex items-center gap-0.5 text-[11px] font-medium text-brand-700">
                        <CheckCircle2 class="size-3" />
                        <span>CRM</span>
                      </span>
                    )}
                    {s.person.role !== 'individual' && l.status === 'check' && (
                      <span class="inline-flex items-center gap-0.5 text-[11px] font-medium text-red-600">
                        <AlertCircle class="size-3" />
                        <span>{t('Failed')}</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Action buttons row */}
                <div class="flex items-center justify-between pt-2 border-t border-line gap-2 flex-wrap sm:flex-nowrap">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    {phone && (
                      <a
                        href={`tel:${phone}`}
                        class="btn-secondary h-8 px-2.5 text-xs gap-1"
                        title={t('Call')}
                      >
                        <Phone class="size-3 text-brand-600" />
                        <span>{t('Call')}</span>
                      </a>
                    )}
                    {email && (
                      <a
                        href={`mailto:${email}`}
                        class="btn-secondary h-8 px-2.5 text-xs gap-1"
                        title={t('Email')}
                      >
                        <Mail class="size-3 text-ocean-600" />
                        <span>{t('Email')}</span>
                      </a>
                    )}
                  </div>

                  <button
                    onClick={() => setOpen(l)}
                    class="btn-primary h-8 px-3 text-xs gap-1 font-semibold shrink-0 ml-auto"
                  >
                    <span>{t('View')}</span>
                    <ArrowRight class="size-3" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Move to Recycle Bin Dialog */}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('Move to Recycle Bin?')}
        footer={<>
          <button class="btn-ghost" onClick={() => setConfirmDelete(false)}>{t('Cancel')}</button>
          <button
            class="btn-danger"
            disabled={busy}
            onClick={() => {
              setConfirmDelete(false);
              void run(
                (b) => b.bulkDeleteLeads(selected),
                tn(selected.length, '{n} card moved to Recycle Bin (auto-purged after 30 days)', '{n} cards moved to Recycle Bin (auto-purged after 30 days)'),
                true,
              );
            }}
          >
            {busy ? <Spinner /> : <Trash class="size-4" />}
            {t('Move to Recycle Bin')}
          </button>
        </>}
      >
        <div class="space-y-2 text-sm text-muted">
          <p>
            {t('Selected cards will be moved to the Recycle Bin.')}
          </p>
          <p class="text-xs bg-subtle p-2.5 rounded-xl border border-line text-ink">
            🕒 {t('Cards in the Recycle Bin are kept safely and will be permanently deleted after 30 days.')}
          </p>
        </div>
      </Dialog>

      <LeadDetail
        lead={open}
        tags={tags}
        mode="admin"
        onClose={() => setOpen(null)}
        onChanged={() => { setOpen(null); reload(); }}
      />

      <ImportLeads
        open={importing}
        onClose={() => setImporting(false)}
        tags={tags}
        onImported={reload}
      />

      <ImportHistory
        open={history}
        tags={tags}
        onClose={() => setHistory(false)}
        onView={(b) => {
          setHistory(false);
          setFilters({ ...emptyFilters(), import_batch_id: b.id });
        }}
      />
    </div>
  );
}
