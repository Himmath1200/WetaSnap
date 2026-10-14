import { useEffect, useMemo, useState } from 'preact/hooks';
import { Plus, Search, History, Ban, Undo2, Users, Gauge, X } from 'lucide-preact';
import { Avatar, Counter, Dialog, Empty, Field, FilterChip, FilterPopover, SearchInput, Select, Sheet, SortHeader, SortMenu, Spinner } from '../components/ui';
import { backend, type CompanyDetail, type Invitation, type LicenceChange, type NewCompanyInput } from '../lib/backend';
import { InvitationNote } from '../components/Invitation';
import { toast } from '../lib/store';
import { LICENCE_META, daysLeft } from '../lib/licence';
import { CONNECTOR_LABEL, CONNECTOR_ORDER } from '../lib/connectors';
import { isEmail } from '../lib/validate';
import { t } from '../lib/i18n';
import type { CompanySummary, Licence, LicenceStatus, LicenceType, Plan, ScanLimitAction, Sort, Subscription } from '../lib/types';

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
          <h1 class="text-xl font-bold">{t('Companies')}</h1>
          <p class="text-sm text-muted">{t('Clients, their licences and what they use.')}</p>
        </div>
        <button class="btn-primary" onClick={() => setOpen('new')}><Plus class="size-4" />{t('New company')}</button>
      </div>

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
              class={`chip text-xs ${on ? 'border-ocean-600 bg-ocean-50 text-ocean-800' : 'border-line bg-surface text-slate-500'}`}>{CONNECTOR_LABEL[k]}</button>;
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
      <Sheet open onClose={onDone} title={t('{name} created', { name: f.name.trim() })}
        footer={<button class="btn-primary ml-auto" onClick={onDone}>{t('Done')}</button>}>
        <InvitationNote email={f.admin_email.trim().toLowerCase()} invitation={sent} />
      </Sheet>
    );
  }

  return (
    <Sheet open onClose={onClose} title={t('New company')} wide
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

  return (
    <>
      <Sheet open onClose={onClose} wide
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
            <div class="rounded-xl bg-subtle p-2"><p class="text-lg font-bold tabular-nums">{detail?.seats_used ?? company.seats_used}/{company.licence.seats}</p><p class="text-xs text-muted">{t('Seats')}</p></div>
            <div class="rounded-xl bg-subtle p-2"><p class="text-lg font-bold tabular-nums">{detail?.scans_this_month ?? company.scans_this_month}</p><p class="text-xs text-muted">{t('Scans this month')}</p></div>
            <div class="rounded-xl bg-subtle p-2"><p class="text-lg font-bold tabular-nums">{daysLeft(company.licence.ends_on)}</p><p class="text-xs text-muted">{t('Days left')}</p></div>
          </div>

          <section>
            <h3 class="label flex items-center gap-1"><Users class="size-3.5" />{t('Company admins')}</h3>
            {!detail ? <Spinner class="size-4" />
              : detail.admins.length === 0 ? <p class="text-sm text-muted">{t('No company admin yet.')}</p>
              : (
                <ul class="rounded-xl border border-line">
                  {detail.admins.map((a) => (
                    <li key={a.id} class="flex items-start gap-3 border-t border-line px-3 py-2.5 first:border-t-0">
                      <Avatar name={a.name} size="size-8" />
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-semibold">{a.name}</p>
                        <a class="link block truncate text-xs leading-[2.75rem]" href={`mailto:${a.email}`}>{a.email}</a>
                        {a.phone && <a class="link -mt-3 block truncate text-xs leading-[2.75rem]" href={`tel:${a.phone}`}>{a.phone}</a>}
                      </div>
                      <span class={`pill ${a.invited ? 'bg-amber-100 text-amber-800' : a.active ? 'bg-brand-100 text-brand-800' : 'bg-subtle text-muted'}`}>
                        {a.invited ? t('Invited') : a.active ? t('Active') : t('Inactive')}
                      </span>
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
    </>
  );
}

function extend(l: LicenceInput, set: (l: LicenceInput) => void) {
  const d = new Date(l.ends_on);
  d.setFullYear(d.getFullYear() + 1);
  set({ ...l, ends_on: d.toISOString().slice(0, 10), type: l.type === 'trial' ? 'annual' : l.type });
}
