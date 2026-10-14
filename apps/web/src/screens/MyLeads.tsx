import { useEffect, useMemo, useState } from 'preact/hooks';
import { Inbox, SearchX, Camera } from 'lucide-preact';
import { SearchFilterBar } from '../components/SearchFilterBar';
import { LeadDetail } from '../components/LeadDetail';
import { TagChips } from '../components/TagPicker';
import { Avatar, Empty, InterestPill, StatusPill } from '../components/ui';
import { db, type LocalLead } from '../lib/db';
import { useLive } from '../lib/useLive';
import { useStore } from '../lib/store';
import { config, session } from '../lib/session';
import { backend } from '../lib/backend';
import { isOnline } from '../lib/net';
import { activeFilterCount, applyFilters, leadCompany, leadName } from '../lib/leads';
import { emptyFilters, type LeadFilters, type Tag } from '../lib/types';
import { timeAgo } from '../lib/id';
import { t, tn } from '../lib/i18n';

/** S4 · My leads — staff see only their own leads (LEAD-03) with a status pill (SYNC-02). */
export default function MyLeads() {
  const s = useStore(session)!;
  const cfg = useStore(config);
  const [filters, setFilters] = useState<LeadFilters>(emptyFilters);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const all = useLive<LocalLead[]>(() => db.leads.where('captured_by').equals(s.person.id).toArray(), [s.person.id], []);

  // Bring down own leads captured on other devices so they can be found and fixed here too.
  useEffect(() => {
    if (!isOnline()) return;
    void (async () => {
      try {
        const server = await (await backend()).listLeads({ ...emptyFilters(), captured_by: [s.person.id] });
        const local = new Set((await db.leads.toCollection().primaryKeys()) as string[]);
        const missing = server.filter((l) => !local.has(l.id));
        if (missing.length) await db.leads.bulkPut(missing.map((l) => ({ ...l, dirty: 0, photo_pending: 0, photo_uploaded_at: null })));
      } catch { /* offline or not allowed */ }
    })();
    void backend().then((b) => b.tags()).then(setTags).catch(() => {});
  }, []);

  const rows = useMemo(() => applyFilters(all, filters), [all, filters]);
  const groups = useMemo(() => {
    const m = new Map<string, LocalLead[]>();
    for (const l of rows) {
      const d = new Date(l.created_at);
      const key = d.toDateString() === new Date().toDateString() ? t('Today')
        : d.toDateString() === new Date(Date.now() - 86_400_000).toDateString() ? t('Yesterday')
        : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      m.set(key, [...(m.get(key) ?? []), l]);
    }
    return [...m.entries()];
  }, [rows]);
  const eventName = (id: string) => cfg.events.find((e) => e.id === id)?.name ?? '';
  const needFix = all.filter((l) => l.status === 'check' && !l.deleted_at).length;

  return (
    <div class="mx-auto w-full max-w-7xl">
      <div class="mb-4 flex items-end justify-between gap-3">
        <div>
          <h1 class="text-xl font-bold">{t('My leads')}</h1>
          <p class="text-sm text-muted">{tn(all.filter((l) => !l.deleted_at).length, '{n} lead', '{n} leads')}{needFix ? ` · ` : ''}{needFix ? <button class="tap font-semibold text-red-700 hover:underline" onClick={() => setFilters({ ...filters, status: 'check' })}>{t('{n} need a fix', { n: needFix })}</button> : null}</p>
        </div>
      </div>

      <SearchFilterBar value={filters} onChange={setFilters} events={cfg.events} tags={tags} />

      <div class="mt-4">
        {all.length === 0 ? (
          <Empty icon={<Camera class="size-6" />} title={t('No leads yet')} text={t('Scanned cards appear here, even without internet.')} />
        ) : rows.length === 0 ? (
          <Empty icon={<SearchX class="size-6" />} title={t('No leads match')} text={activeFilterCount(filters) ? t('Try removing a filter.') : t('Try a different search.')} />
        ) : (
          groups.map(([day, list]) => (
            <section key={day} class="mb-5">
              <h2 class="mb-2 px-1 text-xs font-bold tracking-wide text-muted uppercase">{day} · {list.length}</h2>
              <ul class="card divide-y divide-line overflow-hidden">
                {list.map((l) => (
                  <li key={l.id}>
                    <button class="grid w-full grid-cols-[auto_1fr] items-start gap-x-3 gap-y-0.5 px-4 py-3 text-left transition hover:bg-subtle md:grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto] md:items-center md:gap-y-0" onClick={() => setEditingId(l.id)}>
                      <span class="row-span-4 self-start md:row-span-1 md:self-center"><Avatar name={leadName(l)} /></span>
                      <span class="min-w-0 truncate text-sm font-semibold">{leadName(l)}</span>
                      <span class="min-w-0">
                        <span class="block truncate text-xs md:text-sm">{leadCompany(l)}</span>
                        <span class="block truncate text-xs text-muted">{eventName(l.event_id)}</span>
                      </span>
                      <span class="min-w-0">
                        <TagChips ids={l.tag_ids} tags={tags} />
                        {l.status === 'check' && l.crm_error && <span class="block truncate text-xs font-medium text-red-700">{l.crm_error}</span>}
                      </span>
                      <span class="col-span-2 mt-1 flex flex-wrap items-center gap-2 md:col-span-1 md:mt-0 md:justify-end">
                        <InterestPill interest={l.interest} />
                        <StatusPill status={l.status} />
                        <span class="text-xs whitespace-nowrap text-muted tabular-nums md:w-28 md:text-right">{timeAgo(l.created_at)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        {all.length > 0 && <p class="flex items-center justify-center gap-1.5 py-2 text-xs text-muted"><Inbox class="size-3.5" />{t('Waiting = on this device · Synced = on the server · In CRM = delivered')}</p>}
      </div>

      <LeadDetail lead={all.find((l) => l.id === editingId && !l.deleted_at) ?? null} tags={tags} mode="staff" onClose={() => setEditingId(null)} />
    </div>
  );
}
