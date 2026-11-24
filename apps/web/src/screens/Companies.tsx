import { useEffect, useMemo, useState } from 'preact/hooks';
import { Plus, Search, History, Ban, Undo2, Users, Gauge, X, Building, Crown, RotateCcw, Sparkles, Trash2, Ticket, AlertCircle, Copy, Check, Link, Edit3, UserCheck, UserX, ChevronRight, Store, Mail } from 'lucide-preact';
import { Avatar, Counter, Dialog, Empty, Field, FilterChip, FilterPopover, SearchInput, Select, Sheet, SortHeader, SortMenu, Spinner } from '../components/ui';
import { backend, type CompanyDetail, type Invitation, type LicenceChange, type NewCompanyInput } from '../lib/backend';
import { InvitationNote } from '../components/Invitation';
import { toast } from '../lib/store';
import { LICENCE_META, daysLeft } from '../lib/licence';
import { CONNECTOR_LABEL, CONNECTOR_ORDER } from '../lib/connectors';
import { isEmail } from '../lib/validate';
import { t } from '../lib/i18n';
import type { CompanySummary, EventItem, Licence, LicenceStatus, LicenceType, OrganizerDetail, Person, Plan, ScanLimitAction, Sort, Subscription } from '../lib/types';

type LicenceInput = Omit<Licence, 'id' | 'company_id'>;
type SubRow = Subscription & { company_name: string; plan_name: string; mrr: number; currency: string };
/** A company row with the plan it is on (LIC-01, SUB-02). */
type Row = CompanySummary & { plan_name: string; billing_cycle: Subscription['billing_cycle'] };
/** Licence status, or “suspended” — a company flag (W6), not a licence status. */
type StatusFilter = LicenceStatus | 'suspended' | '';

const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const defaultLicence = (): LicenceInput => ({ type: 'trial', starts_on: addDays(0), ends_on: addDays(30), seats: 5, scans_per_month: 500, connectors_allowed: ['zoho_crm', 'zoho_bigin', 'hubspot', 'webhook', 'csv'] });

const cycleLabel = (c: Subscription['billing_cycle']) => (c === 'annual' ? t('Annual') : t('Monthly'));
const planLine = (r: { plan_name: string; plan_id?: string | null; billing_cycle: Subscription['billing_cycle'] }) =>
  r.plan_name && r.plan_name !== 'No plan' && r.plan_id !== null ? `${r.plan_name} · ${cycleLabel(r.billing_cycle)}` : t('No plan');

const SuspendedPill = () => <span class="pill bg-red-100 text-red-700">{t('Suspended')}</span>;

/** LIC-05 · what happens once the monthly scan allowance is used up. */
const SCAN_ACTIONS: { id: ScanLimitAction; label: string; hint: string }[] = [
  { id: 'block', label: 'Block new scans', hint: 'Nobody in the company can scan again until the next month starts or the allowance is raised.' },
  { id: 'overage', label: 'Allow overage — extra scans appear on the invoice', hint: 'Scanning carries on and the extra scans are added to the next invoice.' },
  { id: 'notify', label: 'Notify the company admin only', hint: 'Nothing is blocked and nothing is charged — the company admin simply gets a message.' },
];

/** What the filter button can narrow the list by, beyond the status chips. */
interface CompanyFilters {
  plans: string[];
  licence_types: LicenceType[];
  scan_actions: ScanLimitAction[];
  /** Companies that are running out of something. */
  pressure: ('seats_full' | 'scans_near' | 'scans_over')[];
  countries: string[];
}
const NO_PLAN = '(no plan)';
const noFilters = (): CompanyFilters => ({ plans: [], licence_types: [], scan_actions: [], pressure: [], countries: [] });
const filterCount = (f: CompanyFilters) => Object.values(f).reduce((n, v) => n + v.length, 0);

const LICENCE_TYPE_LABEL: Record<LicenceType, string> = { trial: 'Trial', monthly: 'Monthly', annual: 'Annual' };
const SCAN_ACTION_SHORT: Record<ScanLimitAction, string> = {
  block: 'Blocks at the limit', overage: 'Overage billed', notify: 'Notify only',
};
const PRESSURE_LABEL = {
  seats_full: 'Every seat used', scans_near: 'Scans 80% used', scans_over: 'Scan allowance used up',
} as const;

function toggle<K extends keyof CompanyFilters>(f: CompanyFilters, key: K, value: CompanyFilters[K][number]): CompanyFilters {
  const on = (f[key] as string[]).includes(value as string);
  return { ...f, [key]: on ? (f[key] as string[]).filter((x) => x !== value) : [...(f[key] as string[]), value] } as CompanyFilters;
}

/** The scan allowance a company actually has: the plan's, or the licence's when there is no plan. */
const scanUse = (c: Row) => {
  const limit = c.licence.scans_per_month;
  return { limit, pct: limit > 0 ? (c.scans_this_month / limit) * 100 : 0 };
};

function matchesFilters(c: Row, f: CompanyFilters): boolean {
  const plan = c.plan_name && c.plan_name !== 'No plan' ? c.plan_name : NO_PLAN;
  if (f.plans.length && !f.plans.includes(plan)) return false;
  if (f.licence_types.length && !f.licence_types.includes(c.licence.type)) return false;
  if (f.scan_actions.length && !f.scan_actions.includes(c.scan_limit_action)) return false;
  if (f.countries.length && !f.countries.includes(c.country)) return false;
  if (f.pressure.length) {
    const { limit, pct } = scanUse(c);
    const hit = f.pressure.some((p) => p === 'seats_full' ? c.seats_used >= c.licence.seats
      : p === 'scans_near' ? limit > 0 && pct >= 80 && pct < 100
      : limit > 0 && pct >= 100);
    if (!hit) return false;
  }
  return true;
}

/** One removable chip per active filter. */
function chipsFor(f: CompanyFilters, set: (next: CompanyFilters) => void) {
  const chip = <K extends keyof CompanyFilters>(key: K, value: CompanyFilters[K][number], label: string) =>
    ({ key: `${String(key)}:${String(value)}`, label, clear: () => set(toggle(f, key, value)) });
  return [
    ...f.plans.map((p) => chip('plans', p, p === NO_PLAN ? t('No plan') : p)),
    ...f.licence_types.map((v) => chip('licence_types', v, t(LICENCE_TYPE_LABEL[v]))),
    ...f.scan_actions.map((a) => chip('scan_actions', a, t(SCAN_ACTION_SHORT[a]))),
    ...f.pressure.map((p) => chip('pressure', p, t(PRESSURE_LABEL[p]))),
    ...f.countries.map((c) => chip('countries', c, c)),
  ];
}

const SORT_KEYS: Record<string, (c: Row) => string | number> = {
  name: (c) => c.name.toLowerCase(),
  plan: (c) => `${c.plan_name.toLowerCase()} ${c.billing_cycle}`,
  seats: (c) => c.seats_used,
  scans: (c) => c.scans_this_month,
  ends: (c) => c.licence.ends_on,
  status: (c) => (c.suspended ? 'zz' : LICENCE_META[c.licence_status].label),
};

/** S8 · Companies — WeTano Super Admin (LIC-01..07, W6). */
export default function Companies() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [f, setF] = useState<CompanyFilters>(noFilters);
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 'asc' });
  const [open, setOpen] = useState<CompanySummary | 'new' | null>(null);
  const [segment, setSegment] = useState<'organizations' | 'individuals' | 'organizers'>('organizations');
  const [individuals, setIndividuals] = useState<Person[]>([]);
  const [organizers, setOrganizers] = useState<OrganizerDetail[]>([]);
  const [newOrgOpen, setNewOrgOpen] = useState(false);

  const loadIndividuals = async () => {
    try {
      const list = await (await backend()).listIndividuals();
      setIndividuals(list);
    } catch {
      setIndividuals([]);
    }
  };
  useEffect(() => { void loadIndividuals(); }, []);

  const loadOrganizers = async () => {
    try {
      const list = await (await backend()).listOrganizers();
      setOrganizers(list);
    } catch {
      setOrganizers([]);
    }
  };
  useEffect(() => { void loadOrganizers(); }, []);

  const load = async () => {
    try {
      const b = await backend();
      const [cos, subs] = await Promise.all([b.companies(), b.subscriptions().catch((): SubRow[] => [])]);
      const bySub = new Map(subs.map((s) => [s.company_id, s]));
      setRows(cos.map((c) => ({ ...c, plan_name: bySub.get(c.id)?.plan_name ?? '', billing_cycle: bySub.get(c.id)?.billing_cycle ?? 'monthly' })));
    } catch (e) {
      setRows([]);
      toast((e as Error).message, 'error');
    }
  };
  useEffect(() => { void load(); }, []);

  const all = rows ?? [];
  const planNames = useMemo(() => [...new Set(all.map((c) => c.plan_name).filter((n) => n && n !== 'No plan'))].sort(), [rows]);
  const countries = useMemo(() => [...new Set(all.map((c) => c.country).filter(Boolean))].sort(), [rows]);
  const list = useMemo(() => {
    const found = all.filter((c) => (!q || c.name.toLowerCase().includes(q.toLowerCase()))
      && (!status || (status === 'suspended' ? c.suspended : c.licence_status === status))
      && matchesFilters(c, f));
    const read = SORT_KEYS[sort.key] ?? SORT_KEYS.name!;
    return [...found].sort((a, b) => {
      const va = read(a); const vb = read(b);
      const n = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.dir === 'asc' ? n : -n;
    });
  }, [rows, q, status, f, sort]);

  return (
    <div class="mx-auto max-w-7xl">
      <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-bold tracking-tight text-ink">{t('Accounts & Directory')}</h1>
          <p class="text-sm text-muted">{t('Manage organizations, solo operators, event organizers and their limits.')}</p>
        </div>
        {segment === 'organizations' && (
          <button class="btn-primary" onClick={() => setOpen('new')}><Plus class="size-4" />{t('New company')}</button>
        )}
        {segment === 'organizers' && (
          <button class="btn-primary" onClick={() => setNewOrgOpen(true)}><Plus class="size-4" />{t('New event organizer')}</button>
        )}
      </div>

      {/* ── Segment Toggle: Organizations vs Individuals vs Organizers ── */}
      <div class="mb-5 flex items-center p-1 rounded-2xl border border-line bg-subtle max-w-lg">
        <button
          class={`flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
            segment === 'organizations'
              ? 'bg-surface text-ink shadow-sm border border-line'
              : 'text-muted hover:text-ink'
          }`}
          onClick={() => setSegment('organizations')}
        >
          <Building class="size-3.5 text-brand-600" />
          <span>{t('Organizations')}</span>
          <span class="px-1.5 py-0.5 rounded text-[10px] bg-subtle border border-line text-muted">
            {all.length}
          </span>
        </button>
        <button
          class={`flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
            segment === 'individuals'
              ? 'bg-surface text-ink shadow-sm border border-line'
              : 'text-muted hover:text-ink'
          }`}
          onClick={() => setSegment('individuals')}
        >
          <Users class="size-3.5 text-ocean-600" />
          <span>{t('Individuals')}</span>
          <span class="px-1.5 py-0.5 rounded text-[10px] bg-brand-50 text-brand-700 border border-brand-200">
            {individuals.length}
          </span>
        </button>
        <button
          class={`flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
            segment === 'organizers'
              ? 'bg-surface text-ink shadow-sm border border-line'
              : 'text-muted hover:text-ink'
          }`}
          onClick={() => setSegment('organizers')}
        >
          <Ticket class="size-3.5 text-purple-600" />
          <span>{t('Organizers')}</span>
          <span class="px-1.5 py-0.5 rounded text-[10px] bg-purple-50 text-purple-700 border border-purple-200">
            {organizers.length}
          </span>
        </button>
      </div>

      {segment === 'individuals' ? (
        <IndividualsSection individuals={individuals} reload={loadIndividuals} />
      ) : segment === 'organizers' ? (
        <OrganizersSection organizers={organizers} reload={loadOrganizers} onNew={() => setNewOrgOpen(true)} />
      ) : (
        <>
          <div class="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Counter label={t('Active companies')} value={all.filter((c) => c.licence_status !== 'read_only' && !c.suspended).length} />
            <Counter label={t('Seats in use')} value={`${all.reduce((a, c) => a + c.seats_used, 0)} / ${all.reduce((a, c) => a + c.licence.seats, 0)}`} tone="ocean" />
            <Counter label={t('Scans this month')} value={all.reduce((a, c) => a + c.scans_this_month, 0).toLocaleString()} tone="brand" />
            <Counter label={t('Licences expiring in 30 days')} value={all.filter((c) => daysLeft(c.licence.ends_on) <= 30 && daysLeft(c.licence.ends_on) >= 0).length} tone="amber" />
          </div>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <div class="flex min-w-0 basis-full sm:max-w-sm sm:flex-1 sm:basis-auto">
          <SearchInput value={q} onChange={setQ} placeholder={t('Search companies')} label={t('Search companies')} />
        </div>
        {/* Status sits behind the filter button, as on the other list screens. */}
        <FilterPopover label={t('Filter companies')} count={(status ? 1 : 0) + filterCount(f)}
          onClear={() => { setStatus(''); setF(noFilters()); }}>
          <div>
            <span class="label">{t('Status')}</span>
            <div class="flex flex-wrap gap-2">
              {([...(Object.keys(LICENCE_META) as LicenceStatus[]).map((k) => [k as StatusFilter, t(LICENCE_META[k].label)] as const), ['suspended' as StatusFilter, t('Suspended')] as const]).map(([v, label]) => (
                <FilterChip key={v} on={status === v} onClick={() => setStatus(status === v ? '' : v)}>{label}</FilterChip>
              ))}
            </div>
          </div>
          {planNames.length > 0 && (
            <div>
              <span class="label">{t('Plan')}</span>
              <div class="flex flex-wrap gap-2">
                {planNames.map((n) => <FilterChip key={n} on={f.plans.includes(n)} onClick={() => setF(toggle(f, 'plans', n))}>{n}</FilterChip>)}
                <FilterChip on={f.plans.includes(NO_PLAN)} onClick={() => setF(toggle(f, 'plans', NO_PLAN))}>{t('No plan')}</FilterChip>
              </div>
            </div>
          )}
          <div>
            <span class="label">{t('Licence type')}</span>
            <div class="flex flex-wrap gap-2">
              {(['trial', 'monthly', 'annual'] as const).map((v) => (
                <FilterChip key={v} on={f.licence_types.includes(v)} onClick={() => setF(toggle(f, 'licence_types', v))}>{t(LICENCE_TYPE_LABEL[v])}</FilterChip>
              ))}
            </div>
          </div>
          <div>
            <span class="label">{t('When the scan allowance runs out')}</span>
            <div class="flex flex-wrap gap-2">
              {SCAN_ACTIONS.map((a) => (
                <FilterChip key={a.id} on={f.scan_actions.includes(a.id)} onClick={() => setF(toggle(f, 'scan_actions', a.id))}>{t(SCAN_ACTION_SHORT[a.id])}</FilterChip>
              ))}
            </div>
          </div>
          <div>
            <span class="label">{t('Running out')}</span>
            <div class="flex flex-wrap gap-2">
              {(['seats_full', 'scans_near', 'scans_over'] as const).map((v) => (
                <FilterChip key={v} on={f.pressure.includes(v)} onClick={() => setF(toggle(f, 'pressure', v))}>{t(PRESSURE_LABEL[v])}</FilterChip>
              ))}
            </div>
          </div>
          {countries.length > 1 && (
            <div>
              <span class="label">{t('Country')}</span>
              <div class="flex flex-wrap gap-2">
                {countries.map((c) => <FilterChip key={c} on={f.countries.includes(c)} onClick={() => setF(toggle(f, 'countries', c))}>{c}</FilterChip>)}
              </div>
            </div>
          )}
        </FilterPopover>
        {[
          ...(status ? [{ key: 'status', label: status === 'suspended' ? t('Suspended') : t(LICENCE_META[status as LicenceStatus].label), clear: () => setStatus('') }] : []),
          ...chipsFor(f, (next) => setF(next)),
        ].map((c) => (
          <span key={c.key} class="inline-flex min-h-11 items-center gap-1 rounded-full bg-ocean-50 pl-3 text-xs font-semibold text-ocean-800">
            {c.label}
            <button class="-my-2 flex size-10 items-center justify-center rounded-full hover:bg-ocean-100" onClick={c.clear} aria-label={`${t('Remove filter')} ${c.label}`}><X class="size-3.5" /></button>
          </span>
        ))}
        <div class="shrink-0 md:hidden">
          <SortMenu sort={sort} onSort={setSort} options={[
            { id: 'name', label: t('Company') }, { id: 'plan', label: t('Plan') }, { id: 'seats', label: t('Seats used') },
            { id: 'scans', label: t('Scans this month') }, { id: 'ends', label: t('Valid till') }, { id: 'status', label: t('Status') },
          ]} />
        </div>
      </div>

      <div class="card overflow-hidden">
        {!rows ? <div class="flex justify-center py-12"><Spinner class="size-6 text-brand-700" /></div>
          : list.length === 0 ? <Empty icon={<Search class="size-6" />} title={t('No companies match')} />
          : (
            <>
              <table class="hidden w-full text-sm md:table">
                <thead class="bg-subtle text-left text-xs font-semibold text-muted">
                  <tr>
                    <SortHeader id="name" sort={sort} onSort={setSort}>{t('Company')}</SortHeader>
                    <SortHeader id="plan" sort={sort} onSort={setSort}>{t('Licence')}</SortHeader>
                    <SortHeader id="seats" sort={sort} onSort={setSort}>{t('Seats used')}</SortHeader>
                    <SortHeader id="scans" sort={sort} onSort={setSort}>{t('Scans this month')}</SortHeader>
                    <SortHeader id="ends" sort={sort} onSort={setSort}>{t('Valid till')}</SortHeader>
                    <SortHeader id="status" sort={sort} onSort={setSort}>{t('Status')}</SortHeader>
                    <th />
                  </tr>
                </thead>
                <tbody class="divide-y divide-line">
                  {list.map((c) => (
                    <tr key={c.id} class="hover:bg-brand-50/40">
                      <td class="px-4 py-3"><p class="font-semibold">{c.name}</p><p class="text-xs text-muted">{c.country}</p></td>
                      <td class="px-4 py-3">
                        <p class="font-medium">{planLine(c)}</p>
                        <p class="text-xs text-muted capitalize">{t(c.licence.type)}</p>
                      </td>
                      <td class="px-4 py-3 tabular-nums">{c.seats_used} / {c.licence.seats}</td>
                      <td class="px-4 py-3 tabular-nums">{c.scans_this_month.toLocaleString()}{c.licence.scans_per_month ? <span class="text-muted"> / {c.licence.scans_per_month}</span> : ''}</td>
                      <td class="px-4 py-3 tabular-nums">{new Date(c.licence.ends_on).toLocaleDateString()}</td>
                      <td class="px-4 py-3">
                        <span class="flex flex-wrap items-center gap-1">
                          <span class={`pill ${LICENCE_META[c.licence_status].cls}`}>{t(LICENCE_META[c.licence_status].label)}</span>
                          {c.suspended && <SuspendedPill />}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-right"><button class="link inline-flex min-h-11 min-w-11 items-center justify-end text-sm" onClick={() => setOpen(c)}>{t('Open')}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <ul class="divide-y divide-line md:hidden">
                {list.map((c) => (
                  <li key={c.id}>
                    <button class="flex min-h-11 w-full flex-col items-start gap-1 px-4 py-3 text-left" onClick={() => setOpen(c)}>
                      <span class="flex w-full flex-wrap items-center gap-1.5">
                        <span class="min-w-0 flex-1 truncate font-semibold">{c.name}</span>
                        <span class={`pill ${LICENCE_META[c.licence_status].cls}`}>{t(LICENCE_META[c.licence_status].label)}</span>
                        {c.suspended && <SuspendedPill />}
                      </span>
                      <span class="block text-xs font-medium">{planLine(c)}</span>
                      <span class="block text-xs text-muted capitalize">{t(c.licence.type)}</span>
                      <span class="block text-xs text-muted tabular-nums">
                        {t('{used} of {seats} seats', { used: c.seats_used, seats: c.licence.seats })} · {t('{n} scans', { n: c.scans_this_month.toLocaleString() })} · {t('till {date}', { date: new Date(c.licence.ends_on).toLocaleDateString() })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
      </div>

      {open === 'new' && <NewCompany existingIds={all.map((c) => c.id)} onClose={() => setOpen(null)} onDone={() => { setOpen(null); void load(); }} />}
      {open && open !== 'new' && <CompanyPanel company={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); void load(); }} onRefresh={() => void load()} />}
        </>
      )}

      {newOrgOpen && (
        <NewOrganizerModal
          onClose={() => setNewOrgOpen(false)}
          onDone={() => {
            setNewOrgOpen(false);
            void loadOrganizers();
          }}
        />
      )}
    </div>
  );
}

function IndividualsSection({ individuals, reload }: { individuals: Person[]; reload: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const [planFilter, setPlanFilter] = useState<'all' | 'pro' | 'free'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const total = individuals.length;
  const proCount = individuals.filter((i) => i.plan === 'pro').length;
  const freeCount = individuals.filter((i) => i.plan !== 'pro').length;
  const totalScans = individuals.reduce((acc, i) => acc + (i.monthly_scans ?? 0), 0);

  const filtered = individuals.filter((i) => {
    if (planFilter === 'pro' && i.plan !== 'pro') return false;
    if (planFilter === 'free' && i.plan === 'pro') return false;
    if (q) {
      const hay = `${i.name} ${i.email} ${i.phone}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  async function handleTogglePlan(person: Person) {
    setBusyId(person.id);
    const nextPlan = person.plan === 'pro' ? 'free' : 'pro';
    try {
      await (await backend()).updateIndividualPlan(person.id, nextPlan);
      toast(t('Plan updated for {name}', { name: person.name }), 'success');
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleResetScans(person: Person) {
    setBusyId(person.id);
    try {
      await (await backend()).resetIndividualScans(person.id);
      toast(t('Monthly scans reset for {name}', { name: person.name }), 'success');
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleStatus(person: Person) {
    setBusyId(person.id);
    try {
      await (await backend()).toggleIndividualStatus(person.id, !person.active);
      toast(person.active ? t('Account suspended') : t('Account restored'), 'success');
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(person: Person) {
    if (!confirm(`Delete individual account ${person.email}?`)) return;
    setBusyId(person.id);
    try {
      await (await backend()).deleteIndividual(person.id);
      toast(t('Account deleted'), 'success');
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div class="space-y-4">
      {/* 4 Telemetry Cards */}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Counter label={t('Total Individuals')} value={total} tone="ocean" />
        <Counter label={t('Pro Subscribers ($100/mo)')} value={proCount} tone="brand" />
        <Counter label={t('Free Tier (5 limit)')} value={freeCount} tone="amber" />
        <Counter label={t('Total Scans This Month')} value={totalScans.toLocaleString()} />
      </div>

      {/* Filter & Search Bar */}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex-1 min-w-[240px]">
          <SearchInput value={q} onChange={setQ} placeholder={t('Search by name or email...')} label={t('Search individuals')} />
        </div>
        <div class="flex items-center gap-1.5 p-1 rounded-xl border border-line bg-subtle">
          <button
            class={`px-3 py-1 rounded-lg text-xs font-semibold ${planFilter === 'all' ? 'bg-surface text-ink shadow-sm border border-line' : 'text-muted'}`}
            onClick={() => setPlanFilter('all')}
          >
            {t('All')} ({total})
          </button>
          <button
            class={`px-3 py-1 rounded-lg text-xs font-semibold ${planFilter === 'pro' ? 'bg-surface text-emerald-600 dark:text-emerald-400 shadow-sm border border-line' : 'text-muted'}`}
            onClick={() => setPlanFilter('pro')}
          >
            {t('Pro')} ({proCount})
          </button>
          <button
            class={`px-3 py-1 rounded-lg text-xs font-semibold ${planFilter === 'free' ? 'bg-surface text-amber-700 shadow-sm border border-line' : 'text-muted'}`}
            onClick={() => setPlanFilter('free')}
          >
            {t('Free')} ({freeCount})
          </button>
        </div>
      </div>

      {/* List / Table */}
      <div class="card overflow-hidden">
        {filtered.length === 0 ? (
          <Empty icon={<Search class="size-6" />} title={t('No individuals match')} />
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full text-sm min-w-[680px]">
              <thead class="bg-subtle text-left text-xs font-semibold text-muted border-b border-line">
                <tr>
                  <th class="px-4 py-3">{t('User')}</th>
                  <th class="px-4 py-3">{t('Plan')}</th>
                  <th class="px-4 py-3">{t('Scans this month')}</th>
                  <th class="px-4 py-3">{t('Status')}</th>
                  <th class="px-4 py-3 text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                {filtered.map((person) => {
                  const isPro = person.plan === 'pro';
                  const scans = person.monthly_scans ?? 0;
                  return (
                    <tr key={person.id} class="hover:bg-subtle/50 transition-colors">
                      <td class="px-4 py-3">
                        <div class="flex items-center gap-3">
                          <Avatar name={person.name} src={person.avatar_url} />
                          <div>
                            <span class="block font-bold text-ink">{person.name}</span>
                            <span class="block text-xs text-muted">{person.email}</span>
                          </div>
                        </div>
                      </td>
                      <td class="px-4 py-3">
                        {isPro ? (
                          <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                            <Crown class="size-3" />
                            {t('Pro Plan ($100/mo)')}
                          </span>
                        ) : (
                          <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-subtle text-muted border border-line">
                            {t('Free Tier')}
                          </span>
                        )}
                      </td>
                      <td class="px-4 py-3">
                        <div class="flex items-center gap-2">
                          <span class={`font-bold tabular-nums ${!isPro && scans >= 5 ? 'text-red-600' : 'text-ink'}`}>
                            {scans} {isPro ? '/ ∞' : '/ 5'}
                          </span>
                          {!isPro && scans >= 5 && (
                            <span class="text-[10px] font-bold text-red-600 uppercase">
                              {t('Limit reached')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td class="px-4 py-3">
                        {person.active ? (
                          <span class="pill bg-emerald-50 text-emerald-700 border border-emerald-200">
                            {t('Active')}
                          </span>
                        ) : (
                          <span class="pill bg-red-50 text-red-700 border border-red-200">
                            {t('Suspended')}
                          </span>
                        )}
                      </td>
                      <td class="px-4 py-3 text-right">
                        <div class="inline-flex items-center gap-1.5">
                          <button
                            class="btn-secondary h-8 px-2.5 text-xs font-semibold"
                            disabled={busyId === person.id}
                            onClick={() => void handleTogglePlan(person)}
                            title={isPro ? t('Downgrade to Free') : t('Upgrade to Pro')}
                          >
                            <Sparkles class="size-3 text-brand-600" />
                            <span>{isPro ? t('Set Free') : t('Set Pro')}</span>
                          </button>
                          <button
                            class="btn-secondary h-8 px-2 text-xs"
                            disabled={busyId === person.id}
                            onClick={() => void handleResetScans(person)}
                            title={t('Reset monthly scans count')}
                          >
                            <RotateCcw class="size-3" />
                          </button>
                          <button
                            class="btn-secondary h-8 px-2 text-xs text-red-600"
                            disabled={busyId === person.id}
                            onClick={() => void handleToggleStatus(person)}
                            title={person.active ? t('Suspend account') : t('Activate account')}
                          >
                            <Ban class="size-3" />
                          </button>
                          <button
                            class="btn-ghost h-8 px-2 text-xs text-muted hover:text-red-600"
                            disabled={busyId === person.id}
                            onClick={() => void handleDelete(person)}
                            title={t('Delete account')}
                          >
                            <Trash2 class="size-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function LicenceFields({ l, set }: { l: LicenceInput; set: (l: LicenceInput) => void }) {
  return (
    <div class="space-y-3">
      <div>
        <span class="label">{t('Licence type')}</span>
        <div class="grid grid-cols-3 gap-2">
          {(['trial', 'monthly', 'annual'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={l.type === k} onClick={() => set({ ...l, type: k })}
              class={`chip min-h-11 justify-center capitalize ${l.type === k ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface'}`}>{t(k)}</button>
          ))}
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <Field label={t('Start')} for="l-s"><input id="l-s" type="date" class="input" value={l.starts_on} onChange={(e) => set({ ...l, starts_on: e.currentTarget.value })} /></Field>
        <Field label={t('End')} for="l-e"><input id="l-e" type="date" class="input" value={l.ends_on} onChange={(e) => set({ ...l, ends_on: e.currentTarget.value })} /></Field>
        <Field label={t('Staff seats')} for="l-seats"><input id="l-seats" type="number" min={1} class="input" value={l.seats} onInput={(e) => set({ ...l, seats: Number(e.currentTarget.value) })} /></Field>
        <Field label={t('Scans per month')} for="l-scans" hint={t('0 = unlimited')}><input id="l-scans" type="number" min={0} class="input" value={l.scans_per_month} onInput={(e) => set({ ...l, scans_per_month: Number(e.currentTarget.value) })} /></Field>
      </div>
      <div>
        <span class="label">{t('Connectors allowed')}</span>
        <div class="flex flex-wrap gap-2">
          {CONNECTOR_ORDER.map((k) => {
            const on = l.connectors_allowed.includes(k);
            return <button key={k} type="button" aria-pressed={on} onClick={() => set({ ...l, connectors_allowed: on ? l.connectors_allowed.filter((x) => x !== k) : [...l.connectors_allowed, k] })}
              class={`chip text-xs ${on ? 'border-ocean-600 bg-ocean-100 text-ocean-600' : 'border-line bg-surface text-muted'}`}>{CONNECTOR_LABEL[k]}</button>;
          })}
        </div>
      </div>
    </div>
  );
}

/** First renewal date for the new subscription: a month after the start for monthly, else the licence end. */
function firstRenewal(l: LicenceInput) {
  if (l.type !== 'monthly') return l.ends_on;
  const [y, m, d] = l.starts_on.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m!, d!)).toISOString().slice(0, 10);
  return next < l.ends_on ? next : l.ends_on;
}

function NewCompany({ existingIds, onClose, onDone }: { existingIds: string[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Omit<NewCompanyInput, 'licence'>>({ name: '', country: '', admin_name: '', admin_email: '' });
  const [l, setL] = useState<LicenceInput>(defaultLicence);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [planId, setPlanId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** Set once the company exists: the sheet then shows what its admin was emailed. */
  const [sent, setSent] = useState<Invitation | null>(null);

  useEffect(() => { backend().then((b) => b.plans()).then((p) => setPlans(p.filter((x) => x.active))).catch(() => setPlans([])); }, []);
  const plan = plans?.find((p) => p.id === planId) ?? null;
  // SUB-02: the billing cycle follows the licence type.
  const cycle: Subscription['billing_cycle'] = l.type === 'annual' ? 'annual' : 'monthly';

  /** A plan fills in its seats, scans and connectors; they stay editable afterwards. */
  function pickPlan(id: string) {
    setPlanId(id);
    const p = plans?.find((x) => x.id === id);
    if (p) setL((prev) => ({ ...prev, seats: p.seats, scans_per_month: p.scans_per_month, connectors_allowed: [...p.connectors_allowed] }));
  }

  async function create() {
    setErr('');
    if (!f.name.trim() || !f.country.trim()) { setErr(t('Company name and country are required.')); return; }
    if (!isEmail(f.admin_email)) { setErr(t('Please enter a valid admin email.')); return; }
    if (l.ends_on < l.starts_on) { setErr(t('The end date is before the start date.')); return; }
    if (l.seats < 1) { setErr(t('A company needs at least one seat.')); return; }
    setBusy(true);
    try {
      const b = await backend();
      // LIC-01: the company, its licence and its first admin's invitation in one step. The admin
      // then does the same first-time setup as the team they will invite (AUTH-08).
      const invitation = await b.createCompany({ ...f, name: f.name.trim(), licence: l });
      toast(t('{name} created — invitation sent to {email}', { name: f.name.trim(), email: f.admin_email }), 'success');
      // createCompany returns nothing, so the new row is found by name (preferring one we did not have before).
      try {
        const name = f.name.trim().toLowerCase();
        const known = new Set(existingIds);
        const same = (await b.companies()).filter((c) => c.name.trim().toLowerCase() === name);
        const made = same.find((c) => !known.has(c.id)) ?? same[same.length - 1];
        if (!made) throw new Error(t('The new company could not be found.'));
        await b.setSubscription(made.id, { plan_id: plan?.id ?? null, billing_cycle: cycle, renews_on: firstRenewal(l), auto_renew: l.type !== 'trial' });
      } catch (e) {
        toast(t('The company was created, but its plan was not saved: {reason}. Set it under Subscriptions.', { reason: (e as Error).message }), 'error', 7000);
      }
      setSent(invitation);            // the list refreshes when the sheet is closed
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const price = plan ? (cycle === 'annual' ? plan.price_year : plan.price_month) : 0;

  if (sent) {
    return (
      <Sheet open onClose={onDone} centered wide title={t('{name} created', { name: f.name.trim() })}
        footer={<button class="btn-primary ml-auto" onClick={onDone}>{t('Done')}</button>}>
        <InvitationNote email={f.admin_email.trim().toLowerCase()} invitation={sent} />
      </Sheet>
    );
  }

  return (
    <Sheet open onClose={onClose} centered wide title={t('New company')}
      footer={<button class="btn-primary ml-auto" disabled={busy} onClick={() => void create()}>{busy ? <Spinner /> : t('Create & send invite')}</button>}>
      <div class="space-y-5">
        <section class="space-y-3">
          <h3 class="text-xs font-bold tracking-wide text-muted uppercase">{t('Company')}</h3>
          <div class="grid gap-2 sm:grid-cols-2">
            <Field label={t('Company name')} for="nc-name"><input id="nc-name" class="input" value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></Field>
            <Field label={t('Country')} for="nc-country"><input id="nc-country" class="input" value={f.country} onInput={(e) => setF({ ...f, country: e.currentTarget.value })} /></Field>
            <Field label={t('First admin name')} for="nc-an"><input id="nc-an" class="input" value={f.admin_name} onInput={(e) => setF({ ...f, admin_name: e.currentTarget.value })} /></Field>
            <Field label={t('First admin email')} for="nc-ae"><input id="nc-ae" type="email" class="input" value={f.admin_email} onInput={(e) => setF({ ...f, admin_email: e.currentTarget.value })} /></Field>
          </div>
        </section>
        <section class="space-y-3">
          <h3 class="text-xs font-bold tracking-wide text-muted uppercase">{t('Plan & licence')}</h3>
          <Field label={t('Plan')} hint={plans && plans.length === 0 ? t('No active plans yet — create one under Subscriptions.') : t('Fills in seats, scans and connectors below; you can still change them.')}>
            <Select class="w-full" label={t('Plan')} value={planId} onChange={pickPlan}
              options={[{ value: '', label: plans ? t('No plan') : t('Loading…') }, ...(plans ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
          {plan && (
            <p class="rounded-xl bg-subtle px-3 py-2 text-xs text-muted">
              {t('{plan} · billed {cycle} · {price}', { plan: plan.name, cycle: cycle === 'annual' ? t('yearly') : t('monthly'), price: money(price, plan.currency) })}
            </p>
          )}
          <LicenceFields l={l} set={setL} />
          <p class="text-xs text-muted">
            {t('Billing cycle: {cycle} (follows the licence type). First renewal {date}.', { cycle: cycle === 'annual' ? t('yearly') : t('monthly'), date: new Date(`${firstRenewal(l)}T00:00:00`).toLocaleDateString() })}
          </p>
        </section>
        {err && <p class="text-sm font-medium text-red-700">{err}</p>}
      </div>
    </Sheet>
  );
}

function money(minor: number, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format((minor || 0) / 100); }
  catch { return `${((minor || 0) / 100).toFixed(2)} ${currency}`; }
}

function CompanyPanel({ company, onClose, onDone, onRefresh }: { company: CompanySummary; onClose: () => void; onDone: () => void; onRefresh: () => void }) {
  const { id: _i, company_id: _c, ...lic } = company.licence;
  const [l, setL] = useState<LicenceInput>(lic);
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [hist, setHist] = useState<LicenceChange[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [askSuspend, setAskSuspend] = useState(false);
  const [reason, setReason] = useState('');
  const [editingAdmin, setEditingAdmin] = useState<{ id: string; name: string; email: string } | null>(null);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [reinviteAdmin, setReinviteAdmin] = useState(true);
  const [adminSaving, setAdminSaving] = useState(false);

  const loadDetail = () => backend().then((b) => b.companyDetail(company.id)).then(setDetail).catch((e) => toast((e as Error).message, 'error'));
  useEffect(() => { void loadDetail(); }, [company.id]);
  useEffect(() => { backend().then((b) => b.licenceHistory(company.id)).then(setHist).catch(() => setHist([])); }, [company.id]);

  const suspended = detail?.suspended ?? company.suspended;

  async function save() {
    setBusy(true);
    try {
      await (await backend()).updateLicence(company.id, l);
      toast(t('Licence updated'), 'success');
      onDone();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  async function setSuspended(next: boolean) {
    setBusy(true);
    try {
      await (await backend()).setCompanySuspended(company.id, next, reason.trim());
      toast(next ? t('{name} is suspended', { name: company.name }) : t('{name} is active again', { name: company.name }), 'success');
      setAskSuspend(false);
      setReason('');
      await loadDetail();
      onRefresh();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  async function setScanAction(action: ScanLimitAction) {
    try {
      await (await backend()).setScanLimitAction(company.id, action);
      setDetail((d) => (d ? { ...d, scan_limit_action: action } : d));
      toast(t('Saved — {action}', { action: t(SCAN_ACTIONS.find((a) => a.id === action)!.label) }), 'success');
      onRefresh();
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  async function saveAdminEmail() {
    if (!editingAdmin) return;
    const addr = newAdminEmail.trim().toLowerCase();
    if (!isEmail(addr)) {
      toast(t('Please enter a valid email address.'), 'error');
      return;
    }
    setAdminSaving(true);
    try {
      await (await backend()).updatePersonEmail(editingAdmin.id, addr, reinviteAdmin);
      toast(reinviteAdmin ? t('Admin email updated and invitation sent!') : t('Admin email updated!'), 'success');
      setEditingAdmin(null);
      await loadDetail();
      onRefresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setAdminSaving(false);
    }
  }

  return (
    <>
      <Sheet open onClose={onClose} centered wide
        title={<span class="flex flex-wrap items-center gap-2">{company.name}
          <span class={`pill ${LICENCE_META[company.licence_status].cls}`}>{t(LICENCE_META[company.licence_status].label)}</span>
          {suspended && <SuspendedPill />}
        </span>}
        footer={<>
          <button class="btn-secondary" onClick={() => extend(l, setL)}>{t('+1 year')}</button>
          <button class="btn-primary ml-auto min-w-32" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : t('Save licence')}</button>
        </>}>
        <div class="space-y-5">
          <header>
            <p class="text-lg font-bold">{detail ? planLine(detail) : <span class="text-muted">{t('Loading…')}</span>}</p>
            <p class="text-sm text-muted capitalize">{t('{type} licence', { type: t(company.licence.type) })}</p>
            {suspended && detail?.suspended_reason && (
              <p class="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{t('Suspended: {reason}', { reason: detail.suspended_reason })}</p>
            )}
          </header>

          <div class="grid grid-cols-3 gap-2 text-center">
            <div class="rounded-xl bg-subtle p-2"><p class="text-lg font-bold tabular-nums">{detail?.seats_used ?? company.seats_used}/{company.licence.seats}</p><p class="text-xs text-muted">{t('Seats used')}</p></div>
            <div class="rounded-xl bg-subtle p-2"><p class="text-lg font-bold tabular-nums">{detail?.scans_this_month ?? company.scans_this_month}</p><p class="text-xs text-muted">{t('Scans this month')}</p></div>
            <div class="rounded-xl bg-subtle p-2"><p class="text-lg font-bold tabular-nums">{daysLeft(company.licence.ends_on)}</p><p class="text-xs text-muted">{t('Days left')}</p></div>
          </div>

          <div class="rounded-xl border border-line bg-subtle/50 p-3 text-xs text-muted leading-relaxed">
            <span class="font-semibold text-ink">{t('Team capacity control:')}</span>{' '}
            {t('Configure the staff seats allowance below. The company admin manages, invites, activates, and deactivates individual team members within this licensed limit.')}
          </div>

          <section>
            <h3 class="label flex items-center gap-1"><Users class="size-3.5" />{t('Company admins')}</h3>
            {!detail ? <Spinner class="size-4" />
              : detail.admins.length === 0 ? <p class="text-sm text-muted">{t('No company admin yet.')}</p>
              : (
                <ul class="rounded-xl border border-line">
                  {detail.admins.map((a) => (
                    <li key={a.id} class="flex items-center gap-3 border-t border-line px-3 py-2.5 first:border-t-0">
                      <Avatar name={a.name} size="size-8" />
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <p class="truncate text-sm font-semibold">{a.name}</p>
                          <span class={`pill ${a.invited ? 'bg-amber-100 text-amber-800' : a.active ? 'bg-brand-100 text-brand-800' : 'bg-subtle text-muted'}`}>
                            {a.invited ? t('Invited') : a.active ? t('Active') : t('Inactive')}
                          </span>
                        </div>
                        <div class="flex items-center gap-2 mt-0.5">
                          <span class="truncate text-xs text-muted">{a.email}</span>
                          <button
                            type="button"
                            class="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 hover:text-brand-800 hover:underline shrink-0"
                            onClick={() => {
                              setEditingAdmin({ id: a.id, name: a.name, email: a.email });
                              setNewAdminEmail(a.email);
                              setReinviteAdmin(true);
                            }}
                            title={t('Edit email address')}
                          >
                            <Edit3 class="size-3" />
                            <span>{t('Edit mail')}</span>
                          </button>
                        </div>
                        {a.phone && <a class="link block truncate text-xs mt-0.5" href={`tel:${a.phone}`}>{a.phone}</a>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <section>
            <h3 class="label flex items-center gap-1"><Gauge class="size-3.5" />{t('When the scan allowance runs out')}</h3>
            <div class="space-y-2">
              {SCAN_ACTIONS.map((a) => {
                const on = (detail?.scan_limit_action ?? company.scan_limit_action) === a.id;
                return (
                  <button key={a.id} type="button" aria-pressed={on} disabled={!detail} onClick={() => void setScanAction(a.id)}
                    class={`flex min-h-11 w-full flex-col items-start rounded-xl border px-3 py-2 text-left ${on ? 'border-brand-600 bg-brand-50' : 'border-line bg-surface hover:border-ocean-500'}`}>
                    <span class={`text-sm font-semibold ${on ? 'text-brand-800' : ''}`}>{t(a.label)}</span>
                    <span class="text-xs text-muted">{t(a.hint)}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <LicenceFields l={l} set={setL} />

          <section>
            <h3 class="label">{t('Access')}</h3>
            <p class="mb-2 text-xs text-muted">{t('Suspending stops everyone in this company from signing in. Leads already on their devices are kept.')}</p>
            {suspended
              ? <button class="btn-secondary w-full" disabled={busy} onClick={() => setAskSuspend(true)}><Undo2 class="size-4" />{t('Restore company')}</button>
              : <button class="btn-danger w-full" disabled={busy} onClick={() => setAskSuspend(true)}><Ban class="size-4" />{t('Suspend company')}</button>}
          </section>

          <section>
            <h3 class="label flex items-center gap-1"><History class="size-3.5" />{t('Licence history')}</h3>
            {!hist ? <Spinner class="size-4" /> : (
              <ol class="space-y-2 border-l-2 border-line pl-4 text-xs">
                {hist.map((h, i) => (
                  <li key={i} class="relative"><span class="absolute top-1 -left-[21px] size-2.5 rounded-full bg-ocean-500" />
                    <span class="font-semibold">{h.summary}</span><span class="block text-muted">{new Date(h.at).toLocaleString()} · {h.by}</span></li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </Sheet>

      <Dialog open={askSuspend} onClose={() => setAskSuspend(false)} title={suspended ? t('Restore company') : t('Suspend company')}
        footer={<>
          <button class="btn-ghost" onClick={() => setAskSuspend(false)}>{t('Cancel')}</button>
          {suspended
            ? <button class="btn-secondary" disabled={busy} onClick={() => void setSuspended(false)}>{busy ? <Spinner /> : t('Restore company')}</button>
            : <button class="btn-danger" disabled={busy || !reason.trim()} onClick={() => void setSuspended(true)}>{busy ? <Spinner /> : t('Suspend company')}</button>}
        </>}>
        <div class="space-y-3">
          <p class="text-sm">
            {suspended
              ? t('Everyone at {name} will be able to sign in again straight away.', { name: company.name })
              : t('Nobody at {name} will be able to sign in. Leads already on their devices are kept and will sync once the company is restored.', { name: company.name })}
          </p>
          {!suspended && (
            <Field label={t('Reason')} for="sus-reason" hint={t('The company admin sees this, and it is written to the audit log.')}>
              <input id="sus-reason" class="input" value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
            </Field>
          )}
        </div>
      </Dialog>

      <Dialog
        open={editingAdmin !== null}
        onClose={() => setEditingAdmin(null)}
        title={t('Edit Admin Email Address')}
        footer={<>
          <button class="btn-ghost" onClick={() => setEditingAdmin(null)}>{t('Cancel')}</button>
          <button class="btn-primary min-w-32" disabled={adminSaving || !newAdminEmail.trim()} onClick={() => void saveAdminEmail()}>
            {adminSaving ? <Spinner /> : t('Save & update')}
          </button>
        </>}
      >
        <div class="space-y-4">
          <p class="text-sm text-muted">
            {t('Update the login email address for admin {name}. Active sessions under the old email will be signed out.', {
              name: editingAdmin?.name || '',
            })}
          </p>
          <Field label={t('Admin Email Address')} for="admin-new-email">
            <div class="relative">
              <Mail class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input
                id="admin-new-email"
                type="email"
                class="input pl-9"
                value={newAdminEmail}
                onInput={(e) => setNewAdminEmail(e.currentTarget.value)}
                placeholder="admin@company.com"
                autoFocus
              />
            </div>
          </Field>
          <label class="flex items-center gap-2 text-xs font-semibold text-ink cursor-pointer pt-1">
            <input
              type="checkbox"
              class="size-4 accent-emerald-600 rounded"
              checked={reinviteAdmin}
              onChange={(e) => setReinviteAdmin(e.currentTarget.checked)}
            />
            <span>{t('Send invitation / password setup link to the new email address')}</span>
          </label>
        </div>
      </Dialog>
    </>
  );
}

function extend(l: LicenceInput, set: (l: LicenceInput) => void) {
  const d = new Date(l.ends_on);
  d.setFullYear(d.getFullYear() + 1);
  set({ ...l, ends_on: d.toISOString().slice(0, 10), type: l.type === 'trial' ? 'annual' : l.type });
}

function OrganizersSection({
  organizers,
  reload,
  onNew,
}: {
  organizers: OrganizerDetail[];
  reload: () => Promise<void>;
  onNew: () => void;
}) {
  const [q, setQ] = useState('');
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [assignEventOrgId, setAssignEventOrgId] = useState<string | null>(null);
  const [pickOrgModal, setPickOrgModal] = useState(false);
  const [editLimit, setEditLimit] = useState<{ id: string; name: string; current: number } | null>(null);
  const [newLimitVal, setNewLimitVal] = useState(10);
  const [savingLimit, setSavingLimit] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const total = organizers.length;
  const activeCount = organizers.filter((o) => !o.is_expired && o.active).length;
  const totalMembers = organizers.reduce((sum, o) => sum + (o.members_count ?? 0), 0);
  const expiredCount = organizers.filter((o) => o.is_expired).length;

  const filtered = organizers.filter((o) => {
    if (!q) return true;
    const hay = `${o.name} ${o.email} ${o.event_name} ${o.referral_code} ${o.venue}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  const copy = (linkOrCode: string) => {
    navigator.clipboard.writeText(linkOrCode);
    setCopiedCode(linkOrCode);
    toast(t('Referral link copied to clipboard!'), 'success');
    setTimeout(() => setCopiedCode(null), 2500);
  };

  async function saveNewLimit() {
    if (!editLimit) return;
    setSavingLimit(true);
    try {
      await (await backend()).updateOrganizerLogins(editLimit.id, newLimitVal);
      toast(t('Logins limit updated to {n}', { n: newLimitVal }), 'success');
      setEditLimit(null);
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSavingLimit(false);
    }
  }

  return (
    <div class="space-y-4">
      {/* 4 Telemetry Counters */}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Counter label={t('Event Organizers')} value={total} tone="ocean" />
        <Counter label={t('Active Event Campaigns')} value={activeCount} tone="brand" />
        <Counter label={t('Team Logins Used')} value={totalMembers} tone="amber" />
        <Counter label={t('Concluded / Deactivated')} value={expiredCount} />
      </div>

      {/* Organizer Policy Disclaimer Banner */}
      <div class="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-relaxed text-amber-950 dark:text-amber-200 flex items-start gap-3">
        <AlertCircle class="size-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <div>
          <span class="font-bold text-sm text-amber-900 dark:text-amber-100">{t('Event Organizer Retention Policy')}</span>
          <p class="mt-1 text-muted">
            {t('Organizers receive an exclusive auto-generated referral link with an allowed login quota. When attendees open the link, they register directly with name, email and password. All attendee logins and scanned leads permanently deactivate 24 hours after the event completes.')}
          </p>
        </div>
      </div>

      {/* Search and Action Bar */}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex-1 min-w-[260px]">
          <SearchInput value={q} onChange={setQ} placeholder={t('Search organizers, events or referral links...')} label={t('Search')} />
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          {organizers.length > 0 && (
            <button
              class="btn-secondary h-10 px-3.5 text-xs font-bold gap-1.5 border-purple-300 text-purple-700 bg-purple-50 hover:bg-purple-100 cursor-pointer shadow-xs"
              onClick={() => {
                if (organizers.length === 1) {
                  setAssignEventOrgId(organizers[0].id);
                } else {
                  setPickOrgModal(true);
                }
              }}
              title={t('Assign multiple events to an existing organizer')}
            >
              <Plus class="size-4 text-purple-600" />
              <span>{t('Assign event to organizer')}</span>
            </button>
          )}
          <button class="btn-primary" onClick={onNew}>
            <Plus class="size-4" />{t('New event organizer')}
          </button>
        </div>
      </div>

      {/* Directory Table */}
      <div class="card overflow-hidden">
        {filtered.length === 0 ? (
          <Empty icon={<Ticket class="size-6" />} title={t('No organizers found')} text={t('Create your first event organizer to generate referral links.')} />
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full text-sm min-w-[760px]">
              <thead class="bg-subtle text-left text-xs font-semibold text-muted border-b border-line">
                <tr>
                  <th class="px-4 py-3">{t('Event')}</th>
                  <th class="px-4 py-3">{t('Organizer')}</th>
                  <th class="px-4 py-3">{t('Referral Link')}</th>
                  <th class="px-4 py-3">{t('Team Logins')}</th>
                  <th class="px-4 py-3">{t('Status')}</th>
                  <th class="px-4 py-3 text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                {filtered.map((org) => {
                  const maxL = org.max_logins ?? 10;
                  const usedL = org.members_count ?? 0;
                  const isFull = usedL >= maxL;
                  const slug = (org.name || 'organizer').toLowerCase().replace(/[^a-z0-9]/g, '');
                  const vanityDomain = `wetano.${slug}.com`;
                  const liveReferralUrl = typeof window !== 'undefined'
                    ? `${window.location.origin}/signin?ref=${org.referral_code}`
                    : `https://app.wetasnap.com/signin?ref=${org.referral_code}`;

                  return (
                    <tr key={org.id} class="hover:bg-subtle/50 transition-colors cursor-pointer" onClick={() => setSelectedOrgId(org.id)}>
                      <td class="px-4 py-3">
                        <div>
                          <span class="block font-bold text-ink hover:text-brand-600 transition-colors">{org.event_name}</span>
                          <span class="block text-xs text-muted">
                            {org.starts_on && org.ends_on ? `${new Date(org.starts_on).toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(org.ends_on).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                            {org.venue ? ` · ${org.venue}` : ''}
                          </span>
                        </div>
                      </td>

                      <td class="px-4 py-3">
                        <div class="flex items-center gap-2.5">
                          <Avatar name={org.name} src={org.avatar_url} />
                          <div>
                            <span class="block font-semibold text-ink">{org.name}</span>
                            <span class="block text-xs text-muted">{org.email}</span>
                          </div>
                        </div>
                      </td>

                      <td class="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-subtle border border-line text-xs font-semibold text-brand-700">
                          <Link class="size-3.5 text-brand-600 shrink-0" />
                          <span class="font-mono text-[11px] truncate max-w-[130px] text-ink">{vanityDomain}</span>
                          <button
                            class="text-muted hover:text-brand-600 ml-1 p-0.5"
                            onClick={() => copy(liveReferralUrl)}
                            title={t('Copy direct referral link')}
                          >
                            {copiedCode === liveReferralUrl ? <Check class="size-3.5 text-brand-600" /> : <Copy class="size-3.5" />}
                          </button>
                        </div>
                      </td>

                      <td class="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div class="flex items-center gap-2">
                          <span class={`font-bold tabular-nums ${isFull ? 'text-amber-700' : 'text-ink'}`}>
                            {usedL} / {maxL} {t('logins')}
                          </span>
                          <button
                            class="text-xs text-brand-700 hover:underline font-semibold"
                            onClick={() => { setEditLimit({ id: org.id, name: org.name, current: maxL }); setNewLimitVal(maxL); }}
                            title={t('Edit maximum logins allowance')}
                          >
                            {t('Edit limit')}
                          </button>
                        </div>
                      </td>

                      <td class="px-4 py-3">
                        {org.is_expired ? (
                          <span class="pill bg-subtle text-muted border border-line text-[10px]">
                            {t('Concluded (24h past)')}
                          </span>
                        ) : org.active ? (
                          <span class="pill bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px]">
                            {t('Active')}
                          </span>
                        ) : (
                          <span class="pill bg-red-50 text-red-700 border border-red-200 text-[10px]">
                            {t('Deactivated')}
                          </span>
                        )}
                      </td>

                      <td class="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <div class="inline-flex items-center gap-1.5 justify-end">
                          <button
                            class="btn-secondary h-8 px-2.5 text-xs font-semibold gap-1 text-purple-700 bg-purple-50 hover:bg-purple-100 border-purple-200 cursor-pointer"
                            onClick={() => setAssignEventOrgId(org.id)}
                            title={t('Assign another event to this organizer')}
                          >
                            <Plus class="size-3.5 text-purple-600" />
                            <span>{t('Assign Event')}</span>
                          </button>
                          <button
                            class="btn-secondary h-8 px-2.5 text-xs font-semibold gap-1 cursor-pointer"
                            onClick={() => setSelectedOrgId(org.id)}
                          >
                            <span>{t('Details & team')}</span>
                            <ChevronRight class="size-3.5 text-muted" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Max Logins Dialog */}
      <Dialog
        open={editLimit !== null}
        onClose={() => setEditLimit(null)}
        title={t('Update Logins Allowance')}
        footer={<>
          <button class="btn-ghost" onClick={() => setEditLimit(null)}>{t('Cancel')}</button>
          <button class="btn-primary" disabled={savingLimit} onClick={() => void saveNewLimit()}>
            {savingLimit ? <Spinner class="size-4" /> : t('Save allowance')}
          </button>
        </>}
      >
        <div class="space-y-3">
          <p class="text-sm text-muted">
            {t('Set the maximum number of referral user accounts that can register under {name}.', { name: editLimit?.name ?? '' })}
          </p>
          <Field label={t('Allowed logins limit')} for="edit-max-logins" hint={t('Restricted based on the plan or package chosen by the organizer.')}>
            <input
              id="edit-max-logins"
              type="number"
              min={1}
              max={10000}
              class="input text-sm font-semibold"
              value={newLimitVal}
              onInput={(e) => setNewLimitVal(Number(e.currentTarget.value))}
            />
          </Field>
        </div>
      </Dialog>

      {/* Assign Event to Organizer Modal */}
      {assignEventOrgId && (
        <AssignOrganizerEventModal
          organizerId={assignEventOrgId}
          onClose={() => setAssignEventOrgId(null)}
          onDone={() => {
            setAssignEventOrgId(null);
            void reload();
          }}
        />
      )}

      {/* Select Organizer Dialog (from top action bar) */}
      <Dialog
        open={pickOrgModal}
        onClose={() => setPickOrgModal(false)}
        title={t('Select Organizer to Assign Event')}
        footer={<button class="btn-ghost" onClick={() => setPickOrgModal(false)}>{t('Cancel')}</button>}
      >
        <div class="space-y-2">
          <p class="text-xs text-muted mb-2">
            {t('Choose which organizer you want to assign an event to:')}
          </p>
          <div class="divide-y divide-line rounded-xl border border-line overflow-hidden max-h-60 overflow-y-auto">
            {organizers.map((o) => (
              <button
                key={o.id}
                type="button"
                class="flex w-full items-center justify-between p-3 text-left hover:bg-subtle transition-colors cursor-pointer"
                onClick={() => {
                  setPickOrgModal(false);
                  setAssignEventOrgId(o.id);
                }}
              >
                <div>
                  <p class="font-bold text-xs text-ink">{o.name}</p>
                  <p class="text-[11px] text-muted">{o.email} · {o.event_name || t('No event')}</p>
                </div>
                <span class="text-xs font-semibold text-brand-600 flex items-center gap-1">
                  <span>{t('Select')}</span>
                  <ChevronRight class="size-3.5" />
                </span>
              </button>
            ))}
          </div>
        </div>
      </Dialog>

      {/* Organizer Details & Team Management Panel */}
      {selectedOrgId && (
        <OrganizerDetailPanel
          organizerId={selectedOrgId}
          onClose={() => setSelectedOrgId(null)}
          onRefresh={reload}
        />
      )}
    </div>
  );
}

function NewOrganizerModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [eventsList, setEventsList] = useState<EventItem[]>([]);
  const [attachMode, setAttachMode] = useState<'new' | 'existing'>('new');
  const [selectedEventId, setSelectedEventId] = useState('');
  const [eventName, setEventName] = useState('');
  const [startsOn, setStartsOn] = useState(new Date().toISOString().slice(0, 10));
  const [endsOn, setEndsOn] = useState(new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10));
  const [venue, setVenue] = useState('');
  const [orgName, setOrgName] = useState('');
  const [orgEmail, setOrgEmail] = useState('');
  const [password, setPassword] = useState('WetaSnap#2026');
  const [maxLogins, setMaxLogins] = useState(10);
  const [busy, setBusy] = useState(false);
  const [createdResult, setCreatedResult] = useState<{ referral_code: string; organizer: Person } | null>(null);

  useEffect(() => {
    backend().then((b) => b.events()).then((evs) => {
      setEventsList(evs);
      if (evs.length > 0 && !selectedEventId) {
        setSelectedEventId(evs[0].id);
      }
    }).catch(() => {});
  }, []);

  async function create() {
    if (attachMode === 'new') {
      if (!eventName.trim()) { toast(t('Please enter event name.'), 'error'); return; }
      if (new Date(startsOn).getTime() > new Date(endsOn).getTime()) {
        toast(t('Event start date must be before or on end date.'), 'error'); return;
      }
    } else {
      if (!selectedEventId) { toast(t('Please select an event.'), 'error'); return; }
    }
    if (!orgName.trim()) { toast(t('Please enter organizer name.'), 'error'); return; }
    if (!isEmail(orgEmail)) { toast(t('Please enter a valid email address.'), 'error'); return; }

    const chosen = attachMode === 'existing' ? eventsList.find((e) => e.id === selectedEventId) : null;

    setBusy(true);
    try {
      const res = await (await backend()).createOrganizer({
        event_id: attachMode === 'existing' ? selectedEventId : undefined,
        event_name: chosen ? chosen.name : eventName,
        starts_on: chosen ? chosen.starts_on : startsOn,
        ends_on: chosen ? chosen.ends_on : endsOn,
        venue: chosen ? chosen.venue : venue,
        organizer_name: orgName,
        organizer_email: orgEmail,
        password,
        max_logins: maxLogins,
      });
      setCreatedResult(res);
      toast(t('Organizer account provisioned successfully!'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (createdResult) {
    return (
      <Sheet open onClose={onDone} centered title={t('Organizer Event Ready!')}
        footer={<button class="btn-primary w-full justify-center font-bold" onClick={onDone}>{t('Done')}</button>}>
        <div class="space-y-4 py-2">
          <div class="rounded-2xl border border-brand-500/30 bg-brand-50/50 p-5 text-center space-y-2">
            <span class="text-xs uppercase tracking-wider font-bold text-muted">{t('Shareable Event Referral Code')}</span>
            <div class="text-3xl font-mono font-extrabold text-brand-700 tracking-wider">
              {createdResult.referral_code}
            </div>
            <button
              class="btn-secondary mx-auto text-xs gap-1.5 px-4"
              onClick={() => {
                navigator.clipboard.writeText(createdResult.referral_code);
                toast(t('Referral code copied!'), 'success');
              }}
            >
              <Copy class="size-3.5" />
              <span>{t('Copy referral code')}</span>
            </button>
          </div>

          <div class="rounded-xl border border-line bg-subtle p-3.5 space-y-1.5 text-xs">
            <p><strong class="text-ink">{t('Organizer:')}</strong> {createdResult.organizer.name} ({createdResult.organizer.email})</p>
            <p><strong class="text-ink">{t('Max Allowed Logins:')}</strong> {maxLogins} {t('accounts')}</p>
            <p><strong class="text-ink">{t('Event End Date:')}</strong> {endsOn}</p>
          </div>

          <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-950 dark:text-amber-200">
            <p class="font-bold">{t('24-Hour Cutoff Disclaimer:')}</p>
            <p class="mt-0.5 text-muted">{t('Participant accounts and all captured lead scans will automatically deactivate 24 hours after {date}. Attendees must export data before that time.', { date: endsOn })}</p>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open onClose={onClose} centered wide title={t('Create Event & Organizer')}
      footer={<>
        <button class="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
        <button class="btn-primary min-w-36 font-bold" disabled={busy} onClick={() => void create()}>
          {busy ? <Spinner class="size-4" /> : t('Create event & organizer')}
        </button>
      </>}>
      <div class="space-y-4">
        <div class="rounded-xl border border-line bg-subtle/50 p-3 text-xs text-muted leading-relaxed">
          {t('Super Admin provisions an organizer account. You can create a fresh event or assign this organizer to an existing active event so multiple organizers can share the same event.')}
        </div>

        {eventsList.length > 0 && (
          <div class="flex items-center gap-2 rounded-xl bg-subtle p-1 border border-line">
            <button
              type="button"
              class={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition ${attachMode === 'new' ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
              onClick={() => setAttachMode('new')}
            >
              {t('Create new event')}
            </button>
            <button
              type="button"
              class={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition ${attachMode === 'existing' ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
              onClick={() => setAttachMode('existing')}
            >
              {t('Assign to existing event')}
            </button>
          </div>
        )}

        {attachMode === 'existing' && eventsList.length > 0 ? (
          <Field label={t('Select existing event')} for="org-select-ev" hint={t('Multiple organizers can be linked to the same event')}>
            <select
              id="org-select-ev"
              class="input font-semibold"
              value={selectedEventId}
              onChange={(e) => setSelectedEventId(e.currentTarget.value)}
            >
              {eventsList.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name} ({new Date(ev.starts_on).toLocaleDateString([], { month: 'short', day: 'numeric' })} – {new Date(ev.ends_on).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })})
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label={t('Event name')} for="org-ev-name">
              <input id="org-ev-name" class="input" placeholder="e.g. Hannover Messe 2026" value={eventName} onInput={(e) => setEventName(e.currentTarget.value)} />
            </Field>

            <div class="grid grid-cols-2 gap-3">
              <Field label={t('Starts on')} for="org-ev-start">
                <input id="org-ev-start" type="date" class="input" value={startsOn} onChange={(e) => setStartsOn(e.currentTarget.value)} />
              </Field>
              <Field label={t('Ends on')} for="org-ev-end" hint={t('Deactivates 24h after')}>
                <input id="org-ev-end" type="date" class="input" value={endsOn} onChange={(e) => setEndsOn(e.currentTarget.value)} />
              </Field>
            </div>

            <Field label={t('Venue & booth')} for="org-ev-venue">
              <input id="org-ev-venue" class="input" placeholder="e.g. Hall 4 · Booth 212" value={venue} onInput={(e) => setVenue(e.currentTarget.value)} />
            </Field>
          </>
        )}

        <div class="border-t border-line pt-3 space-y-3">
          <h3 class="text-xs font-bold text-muted uppercase tracking-wider">{t('Organizer Account Details')}</h3>
          <div class="grid grid-cols-2 gap-3">
            <Field label={t('Organizer name')} for="org-name">
              <input id="org-name" class="input" placeholder="David Miller" value={orgName} onInput={(e) => setOrgName(e.currentTarget.value)} />
            </Field>
            <Field label={t('Organizer email')} for="org-email">
              <input id="org-email" type="email" class="input" placeholder="david@eventpro.com" value={orgEmail} onInput={(e) => setOrgEmail(e.currentTarget.value)} />
            </Field>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <Field label={t('Password')} for="org-pw" hint={t('Defaults to WetaSnap#2026')}>
              <input id="org-pw" class="input" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
            </Field>
            <Field label={t('Allowed participant logins limit')} for="org-max" hint={t('Restricted by plan/tier')}>
              <input id="org-max" type="number" min={1} max={10000} class="input font-semibold" value={maxLogins} onInput={(e) => setMaxLogins(Number(e.currentTarget.value))} />
            </Field>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

function OrganizerDetailPanel({
  organizerId,
  onClose,
  onRefresh,
}: {
  organizerId: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [data, setData] = useState<{
    organizer: OrganizerDetail;
    events?: EventItem[];
    members: (Person & { lead_count?: number; event_name?: string })[];
    total_scans: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [editEventOpen, setEditEventOpen] = useState(false);
  const [assignEventOpen, setAssignEventOpen] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await (await backend()).getOrganizerDetails(organizerId);
      setData(res);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [organizerId]);

  if (loading || !data) {
    return (
      <Sheet open onClose={onClose} centered wide title={t('Organizer Details')}>
        <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>
      </Sheet>
    );
  }

  const { organizer: org, members, total_scans } = data;
  const slug = (org.name || 'organizer').toLowerCase().replace(/[^a-z0-9]/g, '');
  const vanityDomain = `wetano.${slug}.com`;
  const liveReferralUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/signin?ref=${org.referral_code}`
    : `https://app.wetasnap.com/signin?ref=${org.referral_code}`;

  const copyLink = () => {
    navigator.clipboard.writeText(liveReferralUrl);
    setCopiedLink(true);
    toast(t('Referral link copied to clipboard!'), 'success');
    setTimeout(() => setCopiedLink(false), 2500);
  };

  async function toggleMember(member: Person) {
    setBusyMemberId(member.id);
    try {
      await (await backend()).updateOrganizerMember(org.id, member.id, { active: !member.active });
      toast(member.active ? t('Member deactivated') : t('Member activated'), 'success');
      await load();
      await onRefresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusyMemberId(null);
    }
  }

  async function deleteMember(member: Person) {
    if (!confirm(t('Remove {name} from this event team?', { name: member.name }))) return;
    setBusyMemberId(member.id);
    try {
      await (await backend()).deleteOrganizerMember(org.id, member.id);
      toast(t('Team member removed'), 'success');
      await load();
      await onRefresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusyMemberId(null);
    }
  }

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        centered
        wide
        title={
          <span class="flex flex-wrap items-center gap-2">
            <span>{org.name}</span>
            <span class="pill bg-purple-100 text-purple-800 text-[10px] font-bold uppercase">{t('Organizer')}</span>
            {org.is_expired ? (
              <span class="pill bg-subtle text-muted text-[10px]">{t('Concluded')}</span>
            ) : org.active ? (
              <span class="pill bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px]">{t('Active')}</span>
            ) : (
              <span class="pill bg-red-50 text-red-700 border border-red-200 text-[10px]">{t('Deactivated')}</span>
            )}
          </span>
        }
        footer={<button class="btn-primary ml-auto" onClick={onClose}>{t('Done')}</button>}
      >
        <div class="space-y-5">
          {/* Summary Metric Cards */}
          <div class="grid grid-cols-3 gap-2 text-center">
            <div class="rounded-xl bg-subtle p-2.5">
              <p class="text-xl font-bold tabular-nums text-ink">{members.length} / {org.max_logins ?? 10}</p>
              <p class="text-xs text-muted">{t('Logins used')}</p>
            </div>
            <div class="rounded-xl bg-subtle p-2.5">
              <p class="text-xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{total_scans}</p>
              <p class="text-xs text-muted">{t('Total team scans')}</p>
            </div>
            <div class="rounded-xl bg-subtle p-2.5">
              <p class="text-xl font-bold text-ink">{org.is_expired ? t('Expired') : t('Active')}</p>
              <p class="text-xs text-muted">{t('Campaign status')}</p>
            </div>
          </div>

          {/* Auto-generated Referral Link Card */}
          <div class="rounded-2xl border border-brand-500/30 bg-gradient-to-br from-brand-50/40 via-surface to-surface p-4 space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-muted uppercase tracking-wider flex items-center gap-1.5">
                <Link class="size-3.5 text-brand-600" />
                <span>{t('Auto-Generated Referral Link')}</span>
              </span>
              <span class="font-mono text-xs font-bold text-brand-700 px-2 py-0.5 rounded bg-brand-50 border border-brand-200">
                {org.referral_code}
              </span>
            </div>

            <div class="flex items-center gap-2 rounded-xl border border-line bg-surface p-2.5">
              <div class="min-w-0 flex-1">
                <span class="block font-mono text-xs font-bold text-ink truncate">{vanityDomain}</span>
                <span class="block font-mono text-[11px] text-muted truncate">{liveReferralUrl}</span>
              </div>
              <button
                class="btn-primary h-8 px-3 text-xs font-bold gap-1.5 shrink-0"
                onClick={copyLink}
              >
                {copiedLink ? <Check class="size-3.5 text-white" /> : <Copy class="size-3.5 text-white" />}
                <span>{copiedLink ? t('Copied!') : t('Copy link')}</span>
              </button>
            </div>
            <p class="text-[11px] text-muted">
              {t('The organizer shares this link with attendees. Attendees open the link and register directly with name, email & password; the event referral code is auto-applied.')}
            </p>
          </div>

          {/* Assigned Events Card (Multi-Event Support) */}
          <div class="card p-4 space-y-3">
            <div class="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h3 class="text-xs font-bold uppercase tracking-wider text-muted flex items-center gap-1.5">
                  <Store class="size-3.5 text-ocean-600" />
                  <span>{t('Assigned Events ({n})', { n: (data.events?.length || (org.event_name ? 1 : 0)) })}</span>
                </h3>
                <p class="text-[11px] text-muted">{t('Organizer can manage attendees and capture leads across these events.')}</p>
              </div>
              <div class="flex items-center gap-1.5">
                <button
                  class="btn-secondary h-7 px-2.5 text-xs font-semibold gap-1 text-brand-700 hover:bg-brand-50"
                  onClick={() => setAssignEventOpen(true)}
                >
                  <Plus class="size-3 text-brand-600" />
                  <span>{t('Assign event')}</span>
                </button>
                <button
                  class="btn-secondary h-7 px-2.5 text-xs font-semibold gap-1"
                  onClick={() => setEditEventOpen(true)}
                >
                  <Edit3 class="size-3" />
                  <span>{t('Edit limits')}</span>
                </button>
              </div>
            </div>

            <div class="divide-y divide-line rounded-xl border border-line bg-subtle/50 overflow-hidden">
              {(data.events && data.events.length > 0 ? data.events : [
                { id: org.event_id || 'default', name: org.event_name || t('Assigned Event'), starts_on: org.starts_on || '', ends_on: org.ends_on || '', venue: org.venue || '' } as EventItem
              ]).map((ev) => (
                <div key={ev.id} class="p-3 bg-surface flex flex-wrap items-center justify-between gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="font-bold text-ink text-xs truncate">{ev.name}</span>
                      {ev.id === org.default_event_id && (
                        <span class="pill bg-brand-50 text-brand-700 text-[10px] font-semibold">{t('Primary')}</span>
                      )}
                    </div>
                    <p class="text-[11px] text-muted mt-0.5">
                      {ev.starts_on && ev.ends_on
                        ? `${new Date(ev.starts_on).toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(ev.ends_on).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
                        : '—'}
                      {ev.venue ? ` · ${ev.venue}` : ''}
                    </p>
                  </div>
                  {data.events && data.events.length > 1 && (
                    <button
                      type="button"
                      class="text-xs text-red-600 hover:text-red-700 px-2 py-1 hover:bg-red-50 rounded font-semibold cursor-pointer"
                      onClick={async () => {
                        if (!confirm(t('Unassign "{name}" from this organizer?', { name: ev.name }))) return;
                        try {
                          await (await backend()).unassignOrganizerEvent(org.id, ev.id);
                          toast(t('Event unassigned successfully'), 'success');
                          await load();
                        } catch (e) {
                          toast((e as Error).message, 'error');
                        }
                      }}
                    >
                      {t('Unassign')}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div class="flex items-center justify-between text-xs text-muted pt-1">
              <span>{t('Allowed Logins: {count} participants max', { count: org.max_logins ?? 10 })}</span>
            </div>
          </div>

          {/* Referred Team Members (Super Admin Full Management) */}
          <div class="space-y-2">
            <div class="flex items-center justify-between px-1">
              <div>
                <h3 class="text-sm font-bold text-ink">{t('Event Team Members ({n})', { n: members.length })}</h3>
                <p class="text-xs text-muted">{t('Users who registered via this organizer’s referral link.')}</p>
              </div>
            </div>

            <div class="card overflow-hidden">
              {members.length === 0 ? (
                <div class="p-6 text-center text-xs text-muted">
                  <p>{t('No members have registered with this referral link yet.')}</p>
                </div>
              ) : (
                <div class="overflow-x-auto">
                  <table class="w-full text-xs min-w-[540px]">
                    <thead class="bg-subtle text-left font-semibold text-muted border-b border-line">
                      <tr>
                        <th class="px-3.5 py-2.5">{t('Member')}</th>
                        <th class="px-3.5 py-2.5">{t('Scans captured')}</th>
                        <th class="px-3.5 py-2.5">{t('Joined')}</th>
                        <th class="px-3.5 py-2.5">{t('Status')}</th>
                        <th class="px-3.5 py-2.5 text-right">{t('Action')}</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-line">
                      {members.map((m) => (
                        <tr key={m.id} class="hover:bg-subtle/40 transition-colors">
                          <td class="px-3.5 py-2.5">
                            <div class="flex items-center gap-2">
                              <Avatar name={m.name} size="size-6 text-[10px]" />
                              <div>
                                <span class="block font-semibold text-ink">{m.name}</span>
                                <span class="block text-[10px] text-muted">{m.email}</span>
                              </div>
                            </div>
                          </td>
                          <td class="px-3.5 py-2.5 font-bold tabular-nums text-ink">
                            {m.lead_count ?? 0} {t('leads')}
                          </td>
                          <td class="px-3.5 py-2.5 text-muted">
                            {m.created_at ? new Date(m.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—'}
                          </td>
                          <td class="px-3.5 py-2.5">
                            {m.active ? (
                              <span class="pill bg-emerald-50 text-emerald-700 border border-emerald-200 text-[9px]">{t('Active')}</span>
                            ) : (
                              <span class="pill bg-red-50 text-red-700 border border-red-200 text-[9px]">{t('Deactivated')}</span>
                            )}
                          </td>
                          <td class="px-3.5 py-2.5 text-right">
                            <div class="inline-flex items-center gap-1 justify-end">
                              <button
                                class={`btn-secondary h-7 px-2 text-[11px] gap-1 ${m.active ? 'text-amber-700 hover:bg-amber-50' : 'text-emerald-700 hover:bg-emerald-50'}`}
                                disabled={busyMemberId === m.id}
                                onClick={() => void toggleMember(m)}
                                title={m.active ? t('Deactivate account') : t('Activate account')}
                              >
                                {m.active ? <UserX class="size-3" /> : <UserCheck class="size-3" />}
                                <span>{m.active ? t('Deactivate') : t('Activate')}</span>
                              </button>
                              <button
                                class="btn-ghost size-7 p-0 flex items-center justify-center text-muted hover:text-red-600"
                                disabled={busyMemberId === m.id}
                                onClick={() => void deleteMember(m)}
                                title={t('Remove from event team')}
                              >
                                <Trash2 class="size-3" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </Sheet>

      {editEventOpen && (
        <EditOrganizerEventModal
          organizer={org}
          onClose={() => setEditEventOpen(false)}
          onDone={() => {
            setEditEventOpen(false);
            void load();
            void onRefresh();
          }}
        />
      )}

      {assignEventOpen && (
        <AssignOrganizerEventModal
          organizerId={org.id}
          onClose={() => setAssignEventOpen(false)}
          onDone={() => {
            setAssignEventOpen(false);
            void load();
            void onRefresh();
          }}
        />
      )}
    </>
  );
}

function AssignOrganizerEventModal({
  organizerId,
  onClose,
  onDone,
}: {
  organizerId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [eventsList, setEventsList] = useState<EventItem[]>([]);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [selectedEventId, setSelectedEventId] = useState('');
  const [eventName, setEventName] = useState('');
  const [startsOn, setStartsOn] = useState(new Date().toISOString().slice(0, 10));
  const [endsOn, setEndsOn] = useState(new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10));
  const [venue, setVenue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    backend().then((b) => b.events()).then((evs) => {
      setEventsList(evs);
      if (evs.length > 0 && !selectedEventId) {
        setSelectedEventId(evs[0].id);
      }
    }).catch(() => {});
  }, []);

  async function save() {
    if (mode === 'new') {
      if (!eventName.trim()) { toast(t('Please enter event name.'), 'error'); return; }
      if (new Date(startsOn).getTime() > new Date(endsOn).getTime()) {
        toast(t('Event start date must be before or on end date.'), 'error'); return;
      }
    } else if (!selectedEventId) {
      toast(t('Please select an event.'), 'error'); return;
    }

    setBusy(true);
    try {
      await (await backend()).assignOrganizerEvent(organizerId, {
        event_id: mode === 'existing' ? selectedEventId : undefined,
        event_name: mode === 'new' ? eventName : undefined,
        starts_on: mode === 'new' ? startsOn : undefined,
        ends_on: mode === 'new' ? endsOn : undefined,
        venue: mode === 'new' ? venue : undefined,
      });
      toast(t('Event assigned to organizer successfully!'), 'success');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} centered wide title={t('Assign Event to Organizer')}
      footer={<>
        <button class="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
        <button class="btn-primary min-w-32 font-bold" disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner class="size-4" /> : t('Assign event')}
        </button>
      </>}>
      <div class="space-y-4">
        <div class="flex rounded-xl bg-subtle p-1 border border-line">
          <button
            type="button"
            class={`flex-1 py-1.5 text-xs font-bold rounded-lg transition ${mode === 'existing' ? 'bg-surface shadow-xs text-ink' : 'text-muted hover:text-ink'}`}
            onClick={() => setMode('existing')}
          >
            {t('Assign existing event')}
          </button>
          <button
            type="button"
            class={`flex-1 py-1.5 text-xs font-bold rounded-lg transition ${mode === 'new' ? 'bg-surface shadow-xs text-ink' : 'text-muted hover:text-ink'}`}
            onClick={() => setMode('new')}
          >
            {t('Create & assign new event')}
          </button>
        </div>

        {mode === 'existing' ? (
          <Field label={t('Select platform event')} for="assign-ev-select">
            {eventsList.length === 0 ? (
              <p class="text-xs text-muted py-2">{t('No existing events found. Choose "Create new event" above.')}</p>
            ) : (
              <select
                id="assign-ev-select"
                class="input"
                value={selectedEventId}
                onChange={(e) => setSelectedEventId(e.currentTarget.value)}
              >
                {eventsList.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({new Date(e.starts_on).toLocaleDateString([], { month: 'short', day: 'numeric' })} – {new Date(e.ends_on).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })})
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <>
            <Field label={t('Event name')} for="new-ev-name">
              <input id="new-ev-name" class="input" value={eventName} onInput={(e) => setEventName(e.currentTarget.value)} placeholder="e.g. Global Tech Expo 2026" />
            </Field>

            <div class="grid grid-cols-2 gap-3">
              <Field label={t('Starts on')} for="new-ev-start">
                <input id="new-ev-start" type="date" class="input" value={startsOn} onChange={(e) => setStartsOn(e.currentTarget.value)} />
              </Field>
              <Field label={t('Ends on')} for="new-ev-end">
                <input id="new-ev-end" type="date" class="input" value={endsOn} onChange={(e) => setEndsOn(e.currentTarget.value)} />
              </Field>
            </div>

            <Field label={t('Venue')} for="new-ev-venue">
              <input id="new-ev-venue" class="input" value={venue} onInput={(e) => setVenue(e.currentTarget.value)} placeholder="Hall 3, Stand B12" />
            </Field>
          </>
        )}
      </div>
    </Sheet>
  );
}

function EditOrganizerEventModal({
  organizer,
  onClose,
  onDone,
}: {
  organizer: OrganizerDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const [eventName, setEventName] = useState(organizer.event_name || '');
  const [startsOn, setStartsOn] = useState(organizer.starts_on || new Date().toISOString().slice(0, 10));
  const [endsOn, setEndsOn] = useState(organizer.ends_on || new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10));
  const [venue, setVenue] = useState(organizer.venue || '');
  const [maxLogins, setMaxLogins] = useState(organizer.max_logins || 10);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!eventName.trim()) { toast(t('Please enter event name.'), 'error'); return; }
    setBusy(true);
    try {
      await (await backend()).updateOrganizerEvent(organizer.id, {
        event_name: eventName,
        starts_on: startsOn,
        ends_on: endsOn,
        venue,
        max_logins: maxLogins,
      });
      toast(t('Event and organizer limits updated successfully!'), 'success');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} centered wide title={t('Edit Organizer Event & Limits')}
      footer={<>
        <button class="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
        <button class="btn-primary min-w-32 font-bold" disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner class="size-4" /> : t('Save changes')}
        </button>
      </>}>
      <div class="space-y-4">
        <Field label={t('Event name')} for="edit-org-ev-name">
          <input id="edit-org-ev-name" class="input" value={eventName} onInput={(e) => setEventName(e.currentTarget.value)} />
        </Field>

        <div class="grid grid-cols-2 gap-3">
          <Field label={t('Starts on')} for="edit-org-ev-start">
            <input id="edit-org-ev-start" type="date" class="input" value={startsOn} onChange={(e) => setStartsOn(e.currentTarget.value)} />
          </Field>
          <Field label={t('Ends on')} for="edit-org-ev-end" hint={t('Deactivates 24h after')}>
            <input id="edit-org-ev-end" type="date" class="input" value={endsOn} onChange={(e) => setEndsOn(e.currentTarget.value)} />
          </Field>
        </div>

        <Field label={t('Venue & booth')} for="edit-org-ev-venue">
          <input id="edit-org-ev-venue" class="input" value={venue} onInput={(e) => setVenue(e.currentTarget.value)} />
        </Field>

        <Field label={t('Allowed participant logins limit')} for="edit-org-max" hint={t('Restricted based on organizer plan')}>
          <input id="edit-org-max" type="number" min={1} max={10000} class="input font-semibold" value={maxLogins} onInput={(e) => setMaxLogins(Number(e.currentTarget.value))} />
        </Field>
      </div>
    </Sheet>
  );
}
