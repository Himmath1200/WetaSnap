import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ArrowRight, Badge, Camera, Check, CheckCircle2, Download, Flame,
  Phone, QrCode, RefreshCw, Search, SearchX, StickyNote, Trash,
  Users, X, Zap,
} from 'lucide-preact';
import { LeadDetail } from '../components/LeadDetail';
import { TagChips } from '../components/TagPicker';
import { BulkBar, Dialog, Empty, Spinner } from '../components/ui';
import { db, type LocalLead } from '../lib/db';
import { useLive } from '../lib/useLive';
import { useStore, toast } from '../lib/store';
import { config, session } from '../lib/session';
import { backend } from '../lib/backend';
import { isOnline } from '../lib/net';
import { syncNow } from '../lib/sync';
import { applyFilters, leadCompany, leadEmail, leadName, leadsToCsv } from '../lib/leads';
import { emptyFilters, type LeadFilters, type Tag } from '../lib/types';
import { linkFor } from '../lib/portal';
import { timeAgo } from '../lib/id';
import { t } from '../lib/i18n';

type QuickTab = 'all' | 'hot' | 'followup' | 'waiting';

export default function MyLeads() {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const online = isOnline();
  const [filters] = useState<LeadFilters>(emptyFilters);
  const [activeTab, setActiveTab] = useState<QuickTab>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  const isLongPress = useRef(false);

  const startLongPress = (id: string) => {
    isLongPress.current = false;
    longPressTimer.current = window.setTimeout(() => {
      isLongPress.current = true;
      setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
      if (navigator.vibrate) navigator.vibrate(50);
    }, 500);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const all = useLive<LocalLead[]>(
    () => db.leads.where('captured_by').equals(s.person.id).reverse().sortBy('created_at'),
    [s.person.id],
    [],
  );

  // Sync leads from other devices so personal list stays complete
  useEffect(() => {
    if (!online) return;
    void (async () => {
      try {
        const server = await (await backend()).listLeads({ ...emptyFilters(), captured_by: [s.person.id] });
        const local = new Set((await db.leads.toCollection().primaryKeys()) as string[]);
        const missing = server.filter((l) => !local.has(l.id));
        if (missing.length) {
          await db.leads.bulkPut(missing.map((l) => ({ ...l, dirty: 0, photo_pending: 0, photo_uploaded_at: null })));
        }
      } catch { /* offline */ }
    })();
    void backend().then((b) => b.tags()).then(setTags).catch(() => {});
  }, [online, s.person.id]);

  const nonDeleted = useMemo(() => all.filter((l) => !l.deleted_at), [all]);

  const tabFiltered = useMemo(() => {
    switch (activeTab) {
      case 'hot':
        return nonDeleted.filter((l) => l.interest === 'hot');
      case 'followup':
        return nonDeleted.filter((l) => l.interest === 'warm' || l.status === 'check');
      case 'waiting':
        return nonDeleted.filter((l) => l.dirty || l.photo_pending || l.status === 'waiting');
      default:
        return nonDeleted;
    }
  }, [nonDeleted, activeTab]);

  const rows = useMemo(() => {
    const base = applyFilters(tabFiltered, filters);
    if (!searchQuery.trim()) return base;
    const q = searchQuery.trim().toLowerCase();
    return base.filter((l) => {
      const hay = [leadName(l), leadCompany(l), leadEmail(l), l.notes].join(' ').toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
  }, [tabFiltered, filters, searchQuery]);

  const todayCount = useMemo(() => {
    const todayStr = new Date().toDateString();
    return nonDeleted.filter((l) => new Date(l.created_at).toDateString() === todayStr).length;
  }, [nonDeleted]);

  const hotCount = useMemo(() => nonDeleted.filter((l) => l.interest === 'hot').length, [nonDeleted]);
  const followupCount = useMemo(() => nonDeleted.filter((l) => l.interest === 'warm' || l.status === 'check').length, [nonDeleted]);
  const waitingCount = useMemo(() => nonDeleted.filter((l) => l.dirty || l.photo_pending || l.status === 'waiting').length, [nonDeleted]);

  const eventName = (id: string) => cfg.events.find((e) => e.id === id)?.name ?? '';

  async function handleSync() {
    setSyncing(true);
    try {
      await syncNow();
      toast(t('Sync complete'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSyncing(false);
    }
  }

  function exportCsvFile() {
    const csv = leadsToCsv(
      rows,
      cfg.fields.map((f) => ({ key: f.key, label: f.label })),
      (l) => `${location.origin}/p/${l.id}`,
      (id) => tags.find((t) => t.id === id)?.name ?? id,
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `my-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(t('Exported {n} leads', { n: rows.length }), 'success');
  }

  async function bulkRecycle() {
    if (!selected.length) return;
    setDeleting(true);
    try {
      const b = await backend();
      await b.bulkDeleteLeads(selected).catch(() => {});
      const now = new Date().toISOString();
      await Promise.all(selected.map((id) => db.leads.update(id, { deleted_at: now }).catch(() => 0)));
      toast(t('{n} cards moved to Recycle Bin (auto-purged after 30 days)', { n: selected.length }), 'success');
      setSelected([]);
      setConfirmDelete(false);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setDeleting(false);
    }
  }

  const scanHref = linkFor(s.person.role, '/scan-v2');

  return (
    <div class="mx-auto w-full max-w-4xl pb-12">
      {/* ── Sub-Header & Agent Profile ── */}
      <div class="flex items-center justify-between pb-3">
        <div>
          <div class="flex items-center gap-1.5 text-xs text-muted">
            <span class="font-semibold uppercase tracking-wider">{s.person.role === 'client_admin' ? t('Admin') : t('Field Operator')}</span>
            <span>/</span>
            <span class="font-bold text-ink">{s.person.name}</span>
          </div>
          <h1 class="text-2xl font-bold tracking-tight text-ink mt-0.5">{t('My Leads')}</h1>
        </div>
        <div class="flex items-center gap-1.5 rounded-lg border border-line bg-subtle px-2.5 py-1 text-xs font-semibold text-brand-700">
          <Zap class="size-3.5 text-brand-600" />
          <span>{t('{n} Captured', { n: nonDeleted.length })}</span>
        </div>
      </div>

      {/* ── Performance Dashboard 4-Card Grid ── */}
      <section class="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div class="card p-3.5 flex flex-col justify-between border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent">
          <div class="flex items-center justify-between text-muted">
            <span class="text-[11px] font-bold uppercase tracking-wider">{t('My Total Leads')}</span>
            <span class="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center">
              <Users class="size-3.5 text-emerald-600 dark:text-emerald-400" />
            </span>
          </div>
          <div class="mt-2 flex items-baseline gap-1.5">
            <span class="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{nonDeleted.length}</span>
            <span class="text-[11px] font-semibold text-emerald-600/80 dark:text-emerald-400/80">Live</span>
          </div>
        </div>

        <div class="card p-3.5 flex flex-col justify-between border-sky-500/25 bg-gradient-to-br from-sky-500/10 via-sky-500/5 to-transparent">
          <div class="flex items-center justify-between text-muted">
            <span class="text-[11px] font-bold uppercase tracking-wider">{t('Scanned Today')}</span>
            <span class="w-7 h-7 rounded-lg bg-sky-500/15 flex items-center justify-center">
              <QrCode class="size-3.5 text-sky-600 dark:text-sky-400" />
            </span>
          </div>
          <div class="mt-2 flex items-baseline gap-1.5">
            <span class="text-2xl font-bold text-sky-600 dark:text-sky-400">{todayCount}</span>
            <span class="text-[11px] text-muted">{t('scans')}</span>
          </div>
        </div>

        <div class="card p-3.5 flex flex-col justify-between border-rose-500/25 bg-gradient-to-br from-rose-500/10 via-rose-500/5 to-transparent">
          <div class="flex items-center justify-between text-muted">
            <span class="text-[11px] font-bold uppercase tracking-wider">{t('Hot Leads')}</span>
            <span class="w-7 h-7 rounded-lg bg-rose-500/15 flex items-center justify-center">
              <Flame class="size-3.5 text-rose-600 dark:text-rose-400" />
            </span>
          </div>
          <div class="mt-2 flex items-baseline gap-1.5">
            <span class="text-2xl font-bold text-rose-600 dark:text-rose-400">{hotCount}</span>
            <span class="text-[11px] text-muted">
              {nonDeleted.length ? `${Math.round((hotCount / nonDeleted.length) * 100)}%` : '0%'}
            </span>
          </div>
        </div>

        <div class="card p-3.5 flex flex-col justify-between border-amber-500/25 bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent">
          <div class="flex items-center justify-between text-muted">
            <span class="text-[11px] font-bold uppercase tracking-wider">{t('Device Outbox')}</span>
            <span class="w-7 h-7 rounded-lg bg-amber-500/15 flex items-center justify-center">
              <RefreshCw class={`size-3.5 text-amber-600 dark:text-amber-400 ${syncing ? 'animate-spin' : ''}`} />
            </span>
          </div>
          <div class="mt-2 flex items-baseline gap-1.5">
            <span class="text-2xl font-bold text-amber-600 dark:text-amber-400">{waitingCount}</span>
            <span class={`text-[11px] font-semibold ${waitingCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
              {waitingCount > 0 ? t('pending') : t('all synced')}
            </span>
          </div>
        </div>
      </section>

      {/* ── Search Bar & Export Action ── */}
      <div class="mb-3 flex items-center gap-2">
        <div class="relative flex-1">
          <Search class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted" />
          <input
            type="search"
            value={searchQuery}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            placeholder={t('Search name, company, notes...')}
            class="input pl-9 pr-8"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
            >
              <X class="size-4" />
            </button>
          )}
        </div>
        <button
          onClick={exportCsvFile}
          disabled={!rows.length}
          class="btn-secondary min-h-11 px-3 text-xs font-semibold gap-1.5 shrink-0"
          title={t('Export CSV')}
        >
          <Download class="size-4 text-brand-600" />
          <span class="hidden sm:inline">{t('Export')}</span>
        </button>
      </div>

      {/* ── Filter Pills Row ── */}
      <div class="mb-4 flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 text-xs font-semibold">
        <button
          onClick={() => setActiveTab('all')}
          class={`shrink-0 rounded-full px-3 py-1 flex items-center gap-1.5 transition ${
            activeTab === 'all'
              ? 'bg-brand-500 text-white font-bold'
              : 'card hover:bg-subtle text-muted hover:text-ink'
          }`}
        >
          <span>{t('All')}</span>
          <span class="opacity-80">({nonDeleted.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('hot')}
          class={`shrink-0 rounded-full px-3 py-1 flex items-center gap-1.5 transition ${
            activeTab === 'hot'
              ? 'bg-red-500 text-white font-bold'
              : 'card hover:bg-subtle text-muted hover:text-ink'
          }`}
        >
          <span class="size-1.5 rounded-full bg-red-400"></span>
          <span>{t('Hot / Priority')}</span>
          <span class="opacity-80">({hotCount})</span>
        </button>

        <button
          onClick={() => setActiveTab('followup')}
          class={`shrink-0 rounded-full px-3 py-1 flex items-center gap-1.5 transition ${
            activeTab === 'followup'
              ? 'bg-amber-500 text-white font-bold'
              : 'card hover:bg-subtle text-muted hover:text-ink'
          }`}
        >
          <span>{t('Needs Follow-up')}</span>
          <span class="opacity-80">({followupCount})</span>
        </button>

        <button
          onClick={() => setActiveTab('waiting')}
          class={`shrink-0 rounded-full px-3 py-1 flex items-center gap-1.5 transition ${
            activeTab === 'waiting'
              ? 'bg-ocean-600 text-white font-bold'
              : 'card hover:bg-subtle text-muted hover:text-ink'
          }`}
        >
          <span>{t('Outbox Queue')}</span>
          <span class="opacity-80">({waitingCount})</span>
        </button>

        {waitingCount > 0 && online && (
          <button
            onClick={() => void handleSync()}
            disabled={syncing}
            class="ml-auto shrink-0 text-xs font-bold text-brand-700 hover:underline flex items-center gap-1"
          >
            <RefreshCw class={`size-3 ${syncing ? 'animate-spin' : ''}`} />
            {t('Sync outbox')}
          </button>
        )}
      </div>

      {/* ── Bulk Action Bar when cards are selected via long-press ── */}
      {selected.length > 0 && (
        <div class="mb-3.5">
          <BulkBar count={selected.length} onClear={() => setSelected([])}>
            <button
              class="btn-danger h-8 px-2.5 text-xs font-semibold gap-1"
              disabled={deleting}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash class="size-3.5" />
              <span>{t('Recycle bin')}</span>
            </button>
          </BulkBar>
        </div>
      )}

      {/* ── Lead Feed List ── */}
      <div class="flex flex-col gap-3">
        {nonDeleted.length === 0 ? (
          <div class="card p-10 text-center flex flex-col items-center gap-3">
            <div class="w-12 h-12 rounded-2xl bg-brand-50 flex items-center justify-center text-brand-700">
              <Camera class="size-6" />
            </div>
            <div>
              <p class="font-bold text-ink">{t('No leads captured yet')}</p>
              <p class="text-xs text-muted mt-0.5">{t('Every badge or business card you scan will appear here.')}</p>
            </div>
            <a href={scanHref} class="btn-primary text-xs px-4 mt-1 gap-1.5">
              <QrCode class="size-3.5" />
              {t('Start Scanning')}
            </a>
          </div>
        ) : rows.length === 0 ? (
          <Empty
            icon={<SearchX class="size-6" />}
            title={t('No leads match')}
            text={t('Try a different search or clear your filters.')}
          />
        ) : (
          rows.map((l) => {
            const synced = !l.dirty && !l.photo_pending;
            const isHot = l.interest === 'hot';
            const isWarm = l.interest === 'warm';
            const phone = l.fields.phone?.value?.trim() || '';
            const isSelected = selected.includes(l.id);

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
                  if (selected.length > 0) {
                    toggleSelect(l.id);
                  } else {
                    setEditingId(l.id);
                  }
                }}
                class={`card p-3.5 flex flex-col gap-2.5 transition select-none cursor-pointer hover:border-brand-300 ${
                  isSelected ? 'border-brand-500 bg-brand-50/30 ring-2 ring-brand-300' : ''
                }`}
              >
                {/* Header line: Selection indicator (in selection mode) + Name + Rating + Time */}
                <div class="flex items-start justify-between gap-2">
                  <div class="flex items-start gap-2.5 min-w-0 flex-1">
                    {selected.length > 0 && (
                      <span class={`size-5 rounded-full border flex items-center justify-center shrink-0 mt-0.5 transition ${
                        isSelected ? 'bg-brand-600 border-brand-600 text-white' : 'border-line bg-surface'
                      }`}>
                        {isSelected && <Check class="size-3 stroke-[3]" />}
                      </span>
                    )}
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2 flex-wrap">
                        <h2 class="font-bold text-base text-ink leading-tight truncate">{leadName(l)}</h2>
                        {isHot && (
                          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-red-500/10 border border-red-500/30 text-red-600">
                            {t('Hot Lead')}
                          </span>
                        )}
                        {isWarm && (
                          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-ocean-500/10 border border-ocean-500/30 text-ocean-700">
                            {t('Warm Lead')}
                          </span>
                        )}
                        {l.status === 'check' && (
                          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-500/10 border border-amber-500/30 text-amber-800">
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
                  <span class="text-xs text-muted tabular-nums shrink-0">{timeAgo(l.created_at)}</span>
                </div>

                {/* Badges line: Event, Source tag, Scan info */}
                <div class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <span class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-subtle border border-line text-[11px]">
                    <Badge class="size-3 text-brand-600" />
                    <span>{eventName(l.event_id) || t('Event')}</span>
                  </span>
                  {l.source && (
                    <span class="px-1.5 py-0.5 rounded bg-subtle border border-line text-[11px] uppercase">
                      {l.source}
                    </span>
                  )}
                  <TagChips ids={l.tag_ids} tags={tags} />
                </div>

                {/* Note preview if any */}
                {l.notes && (
                  <div class="bg-subtle p-2.5 rounded-xl border border-line flex items-start gap-2 text-xs">
                    <StickyNote class="size-3.5 text-brand-600 shrink-0 mt-0.5" />
                    <p class="text-ink italic line-clamp-2">{l.notes}</p>
                  </div>
                )}

                {/* Card Actions Footer */}
                <div class="flex items-center justify-between pt-2 border-t border-line text-xs">
                  <div class="flex items-center gap-1 font-medium text-brand-700">
                    <CheckCircle2 class="size-3.5 text-brand-600" />
                    <span>{synced ? t('Synchronized') : t('On Device')}</span>
                  </div>

                  <div class="flex items-center gap-1.5">
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
                    <button
                      onClick={() => setEditingId(l.id)}
                      class="btn-primary h-8 px-3 text-xs gap-1 font-semibold shrink-0"
                      title={t('View')}
                    >
                      <span>{t('View')}</span>
                      <ArrowRight class="size-3" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>

      {/* ── Sticky Fast Scan Floating CTA Trigger ── */}
      <div class="fixed bottom-20 left-0 right-0 max-w-md mx-auto px-4 z-10 pointer-events-none md:hidden">
        <a
          href={scanHref}
          class="pointer-events-auto w-full h-12 bg-btn text-btn-ink font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg active:scale-95 transition-transform"
        >
          <QrCode class="size-5" />
          <span>{t('Scan Next Lead')}</span>
        </a>
      </div>

      <LeadDetail
        lead={all.find((l) => l.id === editingId && !l.deleted_at) ?? null}
        tags={tags}
        mode="staff"
        onClose={() => setEditingId(null)}
      />

      {/* Move to Recycle Bin Dialog */}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('Move to Recycle Bin?')}
        footer={<>
          <button class="btn-ghost" onClick={() => setConfirmDelete(false)}>{t('Cancel')}</button>
          <button
            class="btn-danger"
            disabled={deleting}
            onClick={() => void bulkRecycle()}
          >
            {deleting ? <Spinner class="size-4" /> : <Trash class="size-4" />}
            {t('Move to Recycle Bin')}
          </button>
        </>}
      >
        <div class="space-y-2 text-sm text-muted">
          <p>{t('Selected cards will be moved to the Recycle Bin.')}</p>
          <p class="text-xs bg-subtle p-2.5 rounded-xl border border-line text-ink">
            🕒 {t('Cards in the Recycle Bin are kept safely and will be permanently deleted after 30 days.')}
          </p>
        </div>
      </Dialog>
    </div>
  );
}
