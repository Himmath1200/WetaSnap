import { useEffect, useMemo, useState } from 'preact/hooks';
import { Plus, Activity, BellRing, Pencil, Trash2 } from 'lucide-preact';
import { Counter, Dialog, Empty, Field, FilterChip, FilterPopover, SearchInput, Select, Sheet, SortHeader, SortMenu, Spinner, Switch, Tabs } from '../components/ui';
import { backend } from '../lib/backend';
import { toast } from '../lib/store';
import { t, tn } from '../lib/i18n';
import type { CompanySummary, ScanLimitAction, Sort, UsageAlert, UsageRow } from '../lib/types';

/** S12 · Usage — WeTano Super Admin: what every company used this month, and the alerts we watch. */

type Tab = 'usage' | 'alerts';
type Metric = UsageAlert['metric'];

const thisMonth = () => new Date().toISOString().slice(0, 7);
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const storage = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
const pctOf = (used: number, limit: number) => (limit > 0 ? Math.round((used / limit) * 100) : 0);

const ACTION_META: Record<ScanLimitAction, { label: string; cls: string }> = {
  block: { label: 'Blocks at the limit', cls: 'bg-red-100 text-red-700' },
  overage: { label: 'Overage billed', cls: 'bg-amber-100 text-amber-800' },
  notify: { label: 'Notify only', cls: 'bg-subtle text-muted' },
};

const METRIC_META: Record<Metric, { label: string; of: string }> = {
  scans: { label: 'Scans', of: 'its monthly scan allowance' },
  seats: { label: 'Seats', of: 'its licensed seats' },
  storage: { label: 'Storage', of: 'its storage' },
};

/** Toolbar status filter. “Suspended” is the company flag (W6); the others read the scan allowance. */
type StatusFilter = '' | 'active' | 'suspended' | 'near' | 'over';
const matchesStatus = (r: UsageRow, s: StatusFilter) => {
  const pct = pctOf(r.scans, r.scan_limit);
  switch (s) {
    case 'active': return !r.suspended;
    case 'suspended': return r.suspended;
    case 'near': return r.scan_limit > 0 && pct >= 80 && pct < 100;
    case 'over': return r.scan_limit > 0 && pct >= 100;
    default: return true;
  }
};

const SORT_KEYS: Record<string, (r: UsageRow) => string | number> = {
  company: (r) => r.company_name.toLowerCase(),
  scans: (r) => r.scans,
  used: (r) => pctOf(r.scans, r.scan_limit),
  seats: (r) => r.seats_used,
  ai: (r) => r.ai_reads,
  crm: (r) => r.crm_pushes,
  syncs: (r) => r.syncs,
  storage: (r) => r.storage_mb,
};

export default function Usage() {
  const [tab, setTab] = useState<Tab>('usage');
  const [month, setMonth] = useState(thisMonth);
  const [newAlert, setNewAlert] = useState(false);

  return (
    <div class="mx-auto max-w-7xl">
      <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-xl font-bold">{t('Usage')}</h1>
          <p class="text-sm text-muted">{t('What every company used, and when to be told about it.')}</p>
        </div>
        {tab === 'alerts' && <button class="btn-primary" onClick={() => setNewAlert(true)}><Plus class="size-4" />{t('New alert')}</button>}
      </div>

      <Tabs<Tab> value={tab} onChange={setTab} items={[{ id: 'usage', label: t('Usage') }, { id: 'alerts', label: t('Usage alerts') }]} />

      <div class="mt-5">
        {tab === 'usage' && <UsageTab month={month} setMonth={setMonth} />}
        {tab === 'alerts' && <AlertsTab newOpen={newAlert} closeNew={() => setNewAlert(false)} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- usage per company
function UsageTab({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [sort, setSort] = useState<Sort>({ key: 'scans', dir: 'desc' });

  useEffect(() => {
    let live = true;
    setRows(null);
    void (async () => {
      try {
        const list = await (await backend()).usage(month);
        if (live) setRows(list);
      } catch (e) {
        if (!live) return;
        setRows([]);
        toast((e as Error).message, 'error');
      }
    })();
    return () => { live = false; };
  }, [month]);

  const all = rows ?? [];
  const list = useMemo(() => {
    const found = all.filter((r) => (!q || r.company_name.toLowerCase().includes(q.toLowerCase())) && matchesStatus(r, status));
    const read = SORT_KEYS[sort.key] ?? SORT_KEYS.company!;
    return [...found].sort((a, b) => {
      const va = read(a); const vb = read(b);
      const n = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.dir === 'asc' ? n : -n;
    });
  }, [rows, q, status, sort]);

  const sum = (pick: (r: UsageRow) => number) => all.reduce((a, r) => a + pick(r), 0);

  return (
    <>
      <p class="mb-2 text-sm font-semibold text-muted">{monthLabel(month)}</p>
      <div class="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Counter label={t('Scans')} value={sum((r) => r.scans).toLocaleString()} />
        <Counter label={t('AI reads')} value={sum((r) => r.ai_reads).toLocaleString()} tone="ocean" />
        <Counter label={t('CRM pushes')} value={sum((r) => r.crm_pushes).toLocaleString()} tone="brand" />
        <Counter label={t('Storage')} value={storage(sum((r) => r.storage_mb))} tone="amber" />
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <div class="flex min-w-0 basis-full sm:max-w-xs sm:flex-1 sm:basis-auto">
          <SearchInput value={q} onChange={setQ} placeholder={t('Search companies')} label={t('Search companies')} />
        </div>
        {/* Month and status live behind the filter button, as on every other list screen. */}
        <FilterPopover label={t('Filter usage')} count={(month === thisMonth() ? 0 : 1) + (status ? 1 : 0)}
          onClear={() => { setMonth(thisMonth()); setStatus(''); }}>
          <div>
            <span class="label">{t('Month')}</span>
            <input type="month" class="input w-full" value={month} max={thisMonth()}
              onChange={(e) => setMonth(e.currentTarget.value || thisMonth())} aria-label={t('Month')} />
          </div>
          <div>
            <span class="label">{t('Status')}</span>
            <div class="flex flex-wrap gap-2">
              {([['active', t('Not suspended')], ['suspended', t('Suspended')], ['near', t('Near the scan limit (80%+)')], ['over', t('At or over the scan limit')]] as [StatusFilter, string][]).map(([v, label]) => (
                <FilterChip key={v} on={status === v} onClick={() => setStatus(status === v ? '' : v)}>{label}</FilterChip>
              ))}
            </div>
          </div>
        </FilterPopover>
        <div class="shrink-0 md:hidden">
          <SortMenu sort={sort} onSort={setSort} options={[
            { id: 'company', label: t('Company') }, { id: 'scans', label: t('Scans') }, { id: 'used', label: t('Allowance used') },
            { id: 'seats', label: t('Seats') }, { id: 'ai', label: t('AI reads') }, { id: 'crm', label: t('CRM pushes') },
            { id: 'syncs', label: t('Syncs') }, { id: 'storage', label: t('Storage') },
          ]} />
        </div>
      </div>

      <div class="card overflow-hidden">
        {!rows ? <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>
          : list.length === 0 ? <Empty icon={<Activity class="size-6" />} title={all.length ? t('No companies match') : t('Nothing used in {month}', { month: monthLabel(month) })} text={all.length ? t('Clear the search or pick another status.') : t('Pick another month, or clear the search.')} />
          : (
            <>
              <table class="hidden w-full text-sm md:table">
                <thead class="bg-subtle text-left text-xs font-semibold text-muted">
                  <tr>
                    <SortHeader id="company" sort={sort} onSort={setSort}>{t('Company')}</SortHeader>
                    <SortHeader id="used" sort={sort} onSort={setSort}>{t('Scans against allowance')}</SortHeader>
                    <SortHeader id="seats" sort={sort} onSort={setSort}>{t('Seats')}</SortHeader>
                    <SortHeader id="ai" sort={sort} onSort={setSort} align="right">{t('AI reads')}</SortHeader>
                    <SortHeader id="crm" sort={sort} onSort={setSort} align="right">{t('CRM pushes')}</SortHeader>
                    <SortHeader id="syncs" sort={sort} onSort={setSort} align="right">{t('Syncs')}</SortHeader>
                    <SortHeader id="storage" sort={sort} onSort={setSort} align="right">{t('Storage')}</SortHeader>
                  </tr>
                </thead>
                <tbody class="divide-y divide-line">
                  {list.map((r) => (
                    <tr key={r.company_id} class="hover:bg-brand-50/40">
                      <td class="px-4 py-3">
                        <p class="font-semibold">{r.company_name}</p>
                        <span class="mt-1 flex flex-wrap items-center gap-1">
                          {r.suspended && <span class="pill bg-red-100 text-red-700">{t('Suspended')}</span>}
                          <span class={`pill ${ACTION_META[r.scan_limit_action].cls}`}>{t(ACTION_META[r.scan_limit_action].label)}</span>
                        </span>
                      </td>
                      <td class="px-4 py-3"><ScanBar used={r.scans} limit={r.scan_limit} /></td>
                      <td class="px-4 py-3 tabular-nums">{r.seats_used} / {r.seats}</td>
                      <td class="px-4 py-3 text-right tabular-nums">{r.ai_reads.toLocaleString()}</td>
                      <td class="px-4 py-3 text-right tabular-nums">{r.crm_pushes.toLocaleString()}</td>
                      <td class="px-4 py-3 text-right tabular-nums">{r.syncs.toLocaleString()}</td>
                      <td class="px-4 py-3 text-right tabular-nums">{storage(r.storage_mb)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <ul class="divide-y divide-line md:hidden">
                {list.map((r) => (
                  <li key={r.company_id} class="px-4 py-3">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="min-w-0 flex-1 truncate font-semibold">{r.company_name}</span>
                      {r.suspended && <span class="pill bg-red-100 text-red-700">{t('Suspended')}</span>}
                      <span class={`pill ${ACTION_META[r.scan_limit_action].cls}`}>{t(ACTION_META[r.scan_limit_action].label)}</span>
                    </div>
                    <div class="mt-2"><ScanBar used={r.scans} limit={r.scan_limit} /></div>
                    <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <dt class="text-muted">{t('Seats')}</dt><dd class="text-right font-semibold tabular-nums">{r.seats_used} / {r.seats}</dd>
                      <dt class="text-muted">{t('AI reads')}</dt><dd class="text-right font-semibold tabular-nums">{r.ai_reads.toLocaleString()}</dd>
                      <dt class="text-muted">{t('CRM pushes')}</dt><dd class="text-right font-semibold tabular-nums">{r.crm_pushes.toLocaleString()}</dd>
                      <dt class="text-muted">{t('Syncs')}</dt><dd class="text-right font-semibold tabular-nums">{r.syncs.toLocaleString()}</dd>
                      <dt class="text-muted">{t('Storage')}</dt><dd class="text-right font-semibold tabular-nums">{storage(r.storage_mb)}</dd>
                    </dl>
                  </li>
                ))}
              </ul>
              <p class="border-t border-line px-4 py-2 text-xs text-muted">{tn(list.length, '{n} company in {month}', '{n} companies in {month}', { month: monthLabel(month) })}</p>
            </>
          )}
      </div>
    </>
  );
}

/** Scans against the allowance — amber from 80%, red once the allowance is used up. */
function ScanBar({ used, limit }: { used: number; limit: number }) {
  if (!limit) {
    return <p class="text-xs tabular-nums"><span class="font-semibold">{used.toLocaleString()}</span> <span class="text-muted">{t('of unlimited')}</span></p>;
  }
  const pct = pctOf(used, limit);
  const bar = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-400' : 'bg-brand-500';
  const text = pct >= 100 ? 'font-semibold text-red-700' : pct >= 80 ? 'font-semibold text-amber-800' : 'text-muted';
  return (
    <div class="min-w-36">
      <div class="flex items-baseline justify-between gap-2 text-xs tabular-nums">
        <span class="font-semibold">{used.toLocaleString()} / {limit.toLocaleString()}</span>
        <span class={text}>{pct}%</span>
      </div>
      <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('Scan allowance used')}>
        <span class={`block h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- usage alerts
type AlertInput = Omit<UsageAlert, 'id' | 'last_fired_at'> & { id?: string };
const emptyAlert = (): AlertInput => ({ company_id: null, metric: 'scans', threshold_pct: 80, active: true });

function AlertsTab({ newOpen, closeNew }: { newOpen: boolean; closeNew: () => void }) {
  const [rows, setRows] = useState<UsageAlert[] | null>(null);
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [edit, setEdit] = useState<UsageAlert | null>(null);
  const [remove, setRemove] = useState<UsageAlert | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => backend().then((b) => b.usageAlerts()).then(setRows).catch((e) => { setRows([]); toast((e as Error).message, 'error'); });
  useEffect(() => { void load(); }, []);
  useEffect(() => { backend().then((b) => b.companies()).then(setCompanies).catch(() => {}); }, []);

  const nameOf = (id: string | null) => (id ? companies.find((c) => c.id === id)?.name ?? t('One company') : t('Every company'));

  async function del() {
    if (!remove) return;
    setBusy(true);
    try {
      await (await backend()).deleteUsageAlert(remove.id);
      toast(t('Alert removed'), 'success');
      setRemove(null);
      void load();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  return (
    <>
      <p class="mb-3 rounded-2xl bg-ocean-50 px-4 py-3 text-sm text-ocean-800">
        {t('When a company crosses one of these thresholds we send a notification to WeTano and to that company’s admin. Nothing is blocked — it is only a warning.')}
      </p>

      <div class="card overflow-hidden">
        {!rows ? <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>
          : rows.length === 0 ? <Empty icon={<BellRing class="size-6" />} title={t('No usage alerts yet')} text={t('Add one to be told before a company runs out of scans, seats or storage.')} />
          : (
            <ul class="divide-y divide-line">
              {rows.map((a) => (
                <li key={a.id} class="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold">{t('{company} at {pct}% of {metric}', { company: nameOf(a.company_id), pct: a.threshold_pct, metric: t(METRIC_META[a.metric].of) })}</p>
                    <p class="text-xs text-muted">
                      {a.active ? t('We send a notification when this is crossed.') : t('Switched off — no notification is sent.')}
                      {a.last_fired_at ? ` · ${t('last sent {date}', { date: new Date(a.last_fired_at).toLocaleDateString() })}` : ''}
                    </p>
                  </div>
                  <span class={`pill ${a.active ? 'bg-brand-100 text-brand-800' : 'bg-subtle text-muted'}`}>{a.active ? t('On') : t('Off')}</span>
                  <button class="btn-secondary min-h-11 px-3" onClick={() => setEdit(a)}><Pencil class="size-4" />{t('Edit')}</button>
                  <button class="btn-danger min-h-11 px-3" onClick={() => setRemove(a)} aria-label={t('Remove alert')}><Trash2 class="size-4" /></button>
                </li>
              ))}
            </ul>
          )}
      </div>

      {(newOpen || edit) && (
        <AlertSheet alert={edit} companies={companies} onClose={() => { setEdit(null); closeNew(); }} onDone={() => { setEdit(null); closeNew(); void load(); }} />
      )}

      <Dialog open={Boolean(remove)} onClose={() => setRemove(null)} title={t('Remove alert')}
        footer={<>
          <button class="btn-ghost" onClick={() => setRemove(null)}>{t('Cancel')}</button>
          <button class="btn-danger" disabled={busy} onClick={() => void del()}>{busy ? <Spinner /> : t('Remove alert')}</button>
        </>}>
        <p class="text-sm">{t('We will stop watching this threshold. Nothing else changes.')}</p>
      </Dialog>
    </>
  );
}

function AlertSheet({ alert, companies, onClose, onDone }: { alert: UsageAlert | null; companies: CompanySummary[]; onClose: () => void; onDone: () => void }) {
  const [a, setA] = useState<AlertInput>(() => (alert ? { id: alert.id, company_id: alert.company_id, metric: alert.metric, threshold_pct: alert.threshold_pct, active: alert.active } : emptyAlert()));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (patch: Partial<AlertInput>) => setA((prev) => ({ ...prev, ...patch }));

  async function save() {
    setErr('');
    if (a.threshold_pct < 1 || a.threshold_pct > 200) { setErr(t('Use a threshold between 1 and 200 per cent.')); return; }
    setBusy(true);
    try {
      await (await backend()).saveUsageAlert(a);
      toast(alert ? t('Alert saved') : t('Alert added'), 'success');
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Sheet open onClose={onClose} title={alert ? t('Edit alert') : t('New alert')}
      footer={<button class="btn-primary ml-auto min-w-32" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : t('Save alert')}</button>}>
      <div class="space-y-4">
        <Field label={t('Company')} hint={t('Leave on “Every company” to watch them all.')}>
          <Select class="w-full" label={t('Company')} value={a.company_id ?? ''} onChange={(v) => set({ company_id: v || null })}
            options={[{ value: '', label: t('Every company') }, ...companies.map((c) => ({ value: c.id, label: c.suspended ? `${c.name} (${t('Suspended')})` : c.name }))]} />
        </Field>

        <div>
          <span class="label">{t('What to watch')}</span>
          <div class="grid grid-cols-3 gap-2">
            {(Object.keys(METRIC_META) as Metric[]).map((m) => (
              <button key={m} type="button" aria-pressed={a.metric === m} onClick={() => set({ metric: m })}
                class={`chip min-h-11 justify-center ${a.metric === m ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface'}`}>{t(METRIC_META[m].label)}</button>
            ))}
          </div>
        </div>

        <Field label={t('Threshold (%)')} for="ua-pct" hint={t('80 means: tell us once four fifths of the allowance is gone.')}>
          <input id="ua-pct" type="number" min={1} max={200} class="input" value={a.threshold_pct} onInput={(e) => set({ threshold_pct: Number(e.currentTarget.value) })} />
        </Field>

        <Switch on={a.active} onChange={(active) => set({ active })} label={t('Alert is on')} hint={t('Off keeps the rule but sends nothing.')} />

        <p class="rounded-xl bg-subtle px-3 py-2 text-xs text-muted">
          {t('A notification goes out when {company} passes {pct}% of {metric}.', { company: a.company_id ? companies.find((c) => c.id === a.company_id)?.name ?? t('this company') : t('any company'), pct: a.threshold_pct, metric: t(METRIC_META[a.metric].of) })}
        </p>
        {err && <p class="text-sm font-medium text-red-700">{err}</p>}
      </div>
    </Sheet>
  );
}
