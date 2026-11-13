import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  Plus, Package, Repeat, ReceiptText, Pencil, Check, Send, Ban, CircleDollarSign, SlidersHorizontal, Trash2, X,
  FileSpreadsheet, FileDown, ChevronRight,
} from 'lucide-preact';
import { BulkBar, Counter, Dialog, Empty, Field, SearchInput, Select, Sheet, SortHeader, SortMenu, Spinner, Tabs, Tick } from '../components/ui';
import { backend } from '../lib/backend';
import { toast } from '../lib/store';
import { CONNECTOR_LABEL, CONNECTOR_ORDER } from '../lib/connectors';
import { today } from '../lib/id';
import { t, tn } from '../lib/i18n';
import {
  INVOICE_STATUS_LABEL, invoicesToPdf, invoicesToXlsx, subscriptionsToXlsx, type BillTo, type SubscriptionRow,
} from '../lib/billingExport';
import type { CompanySummary, IndividualPricingConfig, Invoice, InvoiceStatus, Person, Plan, Sort, Subscription } from '../lib/types';

/** S9 · Subscriptions & billing — WeTano Super Admin: plans, company subscriptions and invoices (SUB-01..03). */

type Tab = 'plans' | 'individuals' | 'subs' | 'invoices';
type SubRow = SubscriptionRow;

// ---------------------------------------------------------------- money (minor units everywhere)
/** 1999 + "EUR" → "€19.99". Falls back to a plain amount for unusual currency codes. */
function money(minor: number, currency: string) {
  const amount = (minor || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
/** "19,99" / "19.99" → 1999 minor units. */
const toMinor = (text: string) => Math.round((Number(String(text).replace(',', '.').replace(/[^\d.-]/g, '')) || 0) * 100);
const toMajor = (minor: number) => ((minor || 0) / 100).toFixed(2);
const asDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString() : '—');
const addMonths = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daysTo = (date: string) => Math.ceil((new Date(`${date}T23:59:59`).getTime() - Date.now()) / 86_400_000);
const sumBy = <T,>(rows: T[], cur: (r: T) => string, value: (r: T) => number) => {
  const by = new Map<string, number>();
  for (const r of rows) by.set(cur(r), (by.get(cur(r)) ?? 0) + value(r));
  return [...by].map(([c, v]) => money(v, c)).join(' · ') || '—';
};

const INVOICE_STATUSES: InvoiceStatus[] = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
const INVOICE_CLS: Record<InvoiceStatus, string> = {
  draft: 'bg-subtle text-muted',
  sent: 'bg-subtle text-muted',
  paid: 'bg-brand-100 text-brand-800',
  overdue: 'bg-red-100 text-red-700',
  cancelled: 'bg-subtle text-muted',
};
const statusLabel = (s: InvoiceStatus) => t(INVOICE_STATUS_LABEL[s]);
const InvoicePill = ({ status }: { status: InvoiceStatus }) => <span class={`pill ${INVOICE_CLS[status]}`}>{statusLabel(status)}</span>;
const cycleLabel = (c: Subscription['billing_cycle']) => (c === 'annual' ? t('Yearly') : t('Monthly'));

/** Blue pill button used inside the bulk bar (44 px tall so it stays thumb-sized) — as on Leads. */
const BULK = 'inline-flex min-h-11 items-center gap-1.5 rounded-full border border-ocean-200 bg-surface px-3 text-xs font-semibold text-ocean-800 transition hover:bg-ocean-100 disabled:opacity-50';

export default function Subscriptions() {
  const [tab, setTab] = useState<Tab>('plans');
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [newPlan, setNewPlan] = useState(false);
  const [newInvoice, setNewInvoice] = useState(false);

  const loadPlans = () => backend().then((b) => b.plans()).then(setPlans).catch((e) => { setPlans([]); toast((e as Error).message, 'error'); });
  useEffect(() => { void loadPlans(); }, []);

  return (
    <div class="mx-auto max-w-7xl">
      <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div class="min-w-0">
          <h1 class="text-xl font-bold">{t('Subscriptions')}</h1>
          <p class="text-sm text-muted">{t('Company and individual plans, active subscriptions and invoices.')}</p>
        </div>
        {tab === 'plans' && <button class="btn-primary" onClick={() => setNewPlan(true)}><Plus class="size-4" />{t('New plan')}</button>}
        {tab === 'invoices' && <button class="btn-primary" onClick={() => setNewInvoice(true)}><Plus class="size-4" />{t('New invoice')}</button>}
      </div>

      <Tabs<Tab> value={tab} onChange={setTab} items={[
        { id: 'plans', label: t('Company Plans') },
        { id: 'individuals', label: t('Individual Plans') },
        { id: 'subs', label: t('Subscriptions') },
        { id: 'invoices', label: t('Invoices') },
      ]} />

      <div class="mt-5">
        {tab === 'plans' && <PlansTab plans={plans} reload={loadPlans} newOpen={newPlan} closeNew={() => setNewPlan(false)} />}
        {tab === 'individuals' && <IndividualPlansTab />}
        {tab === 'subs' && <SubsTab plans={plans ?? []} />}
        {tab === 'invoices' && <InvoicesTab plans={plans ?? []} newOpen={newInvoice} closeNew={() => setNewInvoice(false)} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- plans
function PlansTab({ plans, reload, newOpen, closeNew }: { plans: Plan[] | null; reload: () => void; newOpen: boolean; closeNew: () => void }) {
  const [edit, setEdit] = useState<Plan | null>(null);
  const [remove, setRemove] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');

  async function doDelete() {
    if (!remove) return;
    setBusy(true); setWhy('');
    try {
      await (await backend()).deletePlan(remove.id);
      toast(t('{name} deleted', { name: remove.name }), 'success');
      setRemove(null);
      reload();
    } catch (e) {
      // A plan in use cannot go: say which, and offer the thing that does work.
      setWhy((e as Error).message);
    } finally { setBusy(false); }
  }

  async function hideInstead() {
    if (!remove) return;
    setBusy(true);
    try {
      await (await backend()).savePlan({ ...remove, active: false });
      toast(t('{name} is hidden — existing subscriptions keep it', { name: remove.name }), 'success');
      setRemove(null); setWhy('');
      reload();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  if (!plans) return <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>;

  return (
    <>
      {plans.length === 0 ? (
        <div class="card"><Empty icon={<Package class="size-6" />} title={t('No plans yet')} text={t('Create a plan to put companies on a subscription.')} /></div>
      ) : (
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((p) => (
            <article key={p.id} class="card flex flex-col gap-3 p-4">
              <header class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <h2 class="truncate font-bold">{p.name}</h2>
                  <p class="line-clamp-2 text-xs text-muted">{p.description}</p>
                </div>
                <span class={`pill ${p.active ? 'bg-brand-100 text-brand-800' : 'bg-subtle text-muted'}`}>{p.active ? t('Active') : t('Hidden')}</span>
              </header>
              <p class="text-2xl font-bold tabular-nums">
                {money(p.price_month, p.currency)}<span class="text-sm font-medium text-muted"> / {t('month')}</span>
              </p>
              <p class="-mt-2 text-xs text-muted tabular-nums">{money(p.price_year, p.currency)} / {t('year')}</p>
              <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt class="text-muted">{t('Seats')}</dt><dd class="font-semibold tabular-nums">{p.seats}</dd>
                <dt class="text-muted">{t('Scans per month')}</dt><dd class="font-semibold tabular-nums">{p.scans_per_month === 0 ? t('Unlimited') : p.scans_per_month.toLocaleString()}</dd>
              </dl>
              <div class="flex flex-wrap gap-1.5">
                {p.connectors_allowed.map((k) => <span key={k} class="pill bg-ocean-100 text-ocean-800">{CONNECTOR_LABEL[k]}</span>)}
              </div>
              {p.features.length > 0 && (
                <ul class="space-y-1 text-xs">
                  {p.features.map((f, i) => <li key={i} class="flex items-start gap-1.5"><Check class="mt-0.5 size-3.5 shrink-0 text-brand-600" />{f}</li>)}
                </ul>
              )}
              <div class="mt-auto flex gap-2">
                <button class="btn-secondary flex-1" onClick={() => setEdit(p)}><Pencil class="size-4" />{t('Edit plan')}</button>
                <button class="btn-danger px-3" onClick={() => { setRemove(p); setWhy(''); }} aria-label={`${t('Delete plan')} ${p.name}`}>
                  <Trash2 class="size-4" />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {(newOpen || edit) && (
        <PlanSheet plan={edit} onClose={() => { setEdit(null); closeNew(); }} onDone={() => { setEdit(null); closeNew(); reload(); }} />
      )}

      <Dialog open={!!remove} onClose={() => { setRemove(null); setWhy(''); }} title={t('Delete this plan?')}
        footer={<>
          <button class="btn-ghost" disabled={busy} onClick={() => { setRemove(null); setWhy(''); }}>{t('Cancel')}</button>
          {why
            ? <button class="btn-primary" disabled={busy} onClick={() => void hideInstead()}>{busy ? <Spinner /> : t('Hide it instead')}</button>
            : <button class="btn-danger" disabled={busy} onClick={() => void doDelete()}>{busy ? <Spinner /> : t('Delete plan')}</button>}
        </>}>
        <div class="space-y-3">
          <p class="text-sm">
            {t('{name} will be removed for good. A plan can only be deleted while no company is on it and no invoice was billed on it.', { name: remove?.name ?? '' })}
          </p>
          {why && <p class="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">{why}</p>}
          {why && <p class="text-sm text-muted">{t('Hiding keeps every subscription and invoice as it is, and takes the plan out of the pickers.')}</p>}
        </div>
      </Dialog>
    </>
  );
}

type PlanInput = Omit<Plan, 'id'> & { id?: string };
const emptyPlan = (): PlanInput => ({
  name: '', description: '', price_month: 0, price_year: 0, currency: 'EUR', seats: 5,
  scans_per_month: 0, connectors_allowed: ['zoho_crm', 'hubspot', 'webhook', 'csv'], features: [], active: true,
});

function PlanSheet({ plan, onClose, onDone }: { plan: Plan | null; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState<PlanInput>(() => (plan ? { ...plan } : emptyPlan()));
  const [month, setMonth] = useState(() => toMajor(plan?.price_month ?? 0));
  const [year, setYear] = useState(() => toMajor(plan?.price_year ?? 0));
  const [featureText, setFeatureText] = useState(() => (plan?.features ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (patch: Partial<PlanInput>) => setP((prev) => ({ ...prev, ...patch }));

  async function save() {
    setErr('');
    if (!p.name.trim()) { setErr(t('The plan needs a name.')); return; }
    if (!/^[A-Za-z]{3}$/.test(p.currency.trim())) { setErr(t('Use a 3-letter currency code, e.g. EUR.')); return; }
    setBusy(true);
    try {
      await (await backend()).savePlan({
        ...p,
        name: p.name.trim(),
        currency: p.currency.trim().toUpperCase(),
        price_month: toMinor(month),
        price_year: toMinor(year),
        features: featureText.split('\n').map((f) => f.trim()).filter(Boolean),
      });
      toast(plan ? t('Plan saved') : t('Plan created'), 'success');
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Sheet open onClose={onClose} wide title={plan ? plan.name : t('New plan')}
      footer={<>
        <span class="text-xs text-muted">{money(toMinor(month), p.currency)} / {t('month')}</span>
        <button class="btn-primary ml-auto min-w-32" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : t('Save plan')}</button>
      </>}>
      <div class="space-y-4">
        <Field label={t('Plan name')} for="p-name"><input id="p-name" class="input" value={p.name} onInput={(e) => set({ name: e.currentTarget.value })} /></Field>
        <Field label={t('Description')} for="p-desc"><textarea id="p-desc" class="input" rows={2} value={p.description} onInput={(e) => set({ description: e.currentTarget.value })} /></Field>

        <div class="grid grid-cols-2 gap-2">
          <Field label={t('Price per month')} for="p-month" hint={t('Shown to clients in {currency}', { currency: p.currency.toUpperCase() })}>
            <input id="p-month" class="input" inputMode="decimal" value={month} onInput={(e) => setMonth(e.currentTarget.value)} onBlur={(e) => setMonth(toMajor(toMinor(e.currentTarget.value)))} />
          </Field>
          <Field label={t('Price per year')} for="p-year">
            <input id="p-year" class="input" inputMode="decimal" value={year} onInput={(e) => setYear(e.currentTarget.value)} onBlur={(e) => setYear(toMajor(toMinor(e.currentTarget.value)))} />
          </Field>
          <Field label={t('Currency')} for="p-cur"><input id="p-cur" class="input uppercase" maxLength={3} value={p.currency} onInput={(e) => set({ currency: e.currentTarget.value })} /></Field>
          <Field label={t('Staff seats')} for="p-seats"><input id="p-seats" type="number" min={1} class="input" value={p.seats} onInput={(e) => set({ seats: Number(e.currentTarget.value) })} /></Field>
          <Field label={t('Scans per month')} for="p-scans" hint={t('0 = unlimited')}>
            <input id="p-scans" type="number" min={0} class="input" value={p.scans_per_month} onInput={(e) => set({ scans_per_month: Number(e.currentTarget.value) })} />
          </Field>
        </div>

        <div>
          <span class="label">{t('Connectors allowed')}</span>
          <div class="flex flex-wrap gap-2">
            {CONNECTOR_ORDER.map((k) => {
              const on = p.connectors_allowed.includes(k);
              return (
                <button key={k} type="button" aria-pressed={on} class={`chip text-xs ${on ? 'border-ocean-600 bg-ocean-50 text-ocean-800' : 'border-line bg-surface text-muted'}`}
                  onClick={() => set({ connectors_allowed: on ? p.connectors_allowed.filter((x) => x !== k) : [...p.connectors_allowed, k] })}>
                  {CONNECTOR_LABEL[k]}
                </button>
              );
            })}
          </div>
        </div>

        <Field label={t('Features')} for="p-feat" hint={t('One per line.')}>
          <textarea id="p-feat" class="input" rows={4} value={featureText} onInput={(e) => setFeatureText(e.currentTarget.value)} />
        </Field>

        <Toggle label={t('Active')} hint={t('Hidden plans cannot be picked for a company.')} on={p.active} onChange={(active) => set({ active })} />
        {err && <p class="text-sm font-medium text-red-700">{err}</p>}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- subscriptions
interface SubFilters {
  /** '' = any plan, 'none' = companies without a plan. */
  plan_id: string;
  cycle: Subscription['billing_cycle'] | '';
  auto: 'on' | 'off' | '';
  renew30: boolean;
  company: 'active' | 'suspended' | '';
}
const emptySubFilters = (): SubFilters => ({ plan_id: '', cycle: '', auto: '', renew30: false, company: '' });

const SUB_SORT: Record<string, (r: SubRow) => string | number> = {
  company: (r) => r.company_name.toLowerCase(),
  plan: (r) => (r.plan_name || '').toLowerCase(),
  cycle: (r) => r.billing_cycle,
  renews: (r) => r.renews_on || '',
  auto: (r) => (r.auto_renew ? 1 : 0),
  mrr: (r) => r.mrr,
};

function SubsTab({ plans }: { plans: Plan[] }) {
  const [rows, setRows] = useState<SubRow[] | null>(null);
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [open, setOpen] = useState<SubRow | null>(null);
  const [q, setQ] = useState('');
  const [f, setF] = useState<SubFilters>(emptySubFilters);
  const [sort, setSort] = useState<Sort>({ key: 'mrr', dir: 'desc' });
  const [exporting, setExporting] = useState(false);

  const load = () => backend().then((b) => b.subscriptions()).then(setRows).catch((e) => { setRows([]); toast((e as Error).message, 'error'); });
  useEffect(() => { void load(); }, []);
  useEffect(() => { backend().then((b) => b.companies()).then(setCompanies).catch(() => {}); }, []);

  const suspended = useMemo(() => new Set(companies.filter((c) => c.suspended).map((c) => c.id)), [companies]);
  const set = (patch: Partial<SubFilters>) => setF((prev) => ({ ...prev, ...patch }));
  const planName = (id: string) => (id === 'none' ? t('No plan') : plans.find((p) => p.id === id)?.name ?? t('Plan'));

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const found = (rows ?? []).filter((r) => {
      if (needle && !`${r.company_name} ${r.plan_name}`.toLowerCase().includes(needle)) return false;
      if (f.plan_id === 'none' ? r.plan_id : f.plan_id && r.plan_id !== f.plan_id) return false;
      if (f.cycle && r.billing_cycle !== f.cycle) return false;
      if (f.auto && r.auto_renew !== (f.auto === 'on')) return false;
      if (f.renew30) { const d = r.renews_on ? daysTo(r.renews_on) : -1; if (d < 0 || d > 30) return false; }
      if (f.company && suspended.has(r.company_id) !== (f.company === 'suspended')) return false;
      return true;
    });
    return sortRows(found, sort, SUB_SORT, 'company');
  }, [rows, q, f, sort, suspended]);

  const pick = useSelection(list, (r) => r.company_id);

  const chips: FilterChip[] = [];
  if (f.plan_id) chips.push({ key: 'plan', label: planName(f.plan_id), clear: () => set({ plan_id: '' }) });
  if (f.cycle) chips.push({ key: 'cycle', label: cycleLabel(f.cycle), clear: () => set({ cycle: '' }) });
  if (f.auto) chips.push({ key: 'auto', label: f.auto === 'on' ? t('Auto-renew on') : t('Auto-renew off'), clear: () => set({ auto: '' }) });
  if (f.renew30) chips.push({ key: 'r30', label: t('Renewing within 30 days'), clear: () => set({ renew30: false }) });
  if (f.company) chips.push({ key: 'co', label: f.company === 'suspended' ? t('Suspended') : t('Not suspended'), clear: () => set({ company: '' }) });

  function summary() {
    const out: string[] = [];
    if (q.trim()) out.push(`${t('Search')}: ${q.trim()}`);
    chips.forEach((c) => out.push(c.label));
    if (pick.chosen.length) out.push(t('{n} selected rows only', { n: pick.chosen.length }));
    return out;
  }

  async function exportXlsx() {
    const only = pick.chosen.length ? pick.chosen : list;
    setExporting(true);
    try {
      save(await subscriptionsToXlsx(only, { filterSummary: summary() }), `wetano-subscriptions-${today()}.xlsx`);
      toast(tn(only.length, 'Export ready — {n} subscription', 'Export ready — {n} subscriptions'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setExporting(false); }
  }

  if (!rows) return <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>;

  return (
    <>
      <div class="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Counter label={t('Subscriptions')} value={list.length} />
        <Counter label={t('Monthly recurring revenue')} value={sumBy(list, (r) => r.currency, (r) => r.mrr)} tone="ocean" />
        <Counter label={t('Auto-renew on')} value={list.filter((r) => r.auto_renew).length} tone="brand" />
        <Counter label={t('Renewing in 30 days')} value={list.filter((r) => r.renews_on && daysTo(r.renews_on) <= 30 && daysTo(r.renews_on) >= 0).length} tone="amber" />
      </div>

      <div class="mb-2 space-y-2">
        <div class="flex items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder={t('Search company or plan')} label={t('Search subscriptions')} />
          <FilterPanel title={t('Filter subscriptions')} count={chips.length} onClearAll={() => setF(emptySubFilters())}>
            <ChipGroup label={t('Plan')} value={f.plan_id} onChange={(plan_id) => set({ plan_id })}
              items={[...plans.map((p) => ({ id: p.id, label: p.name })), { id: 'none', label: t('No plan') }]} />
            <ChipGroup<Subscription['billing_cycle']> label={t('Billing cycle')} value={f.cycle} onChange={(cycle) => set({ cycle })}
              items={[{ id: 'monthly', label: t('Monthly') }, { id: 'annual', label: t('Yearly') }]} />
            <ChipGroup<'on' | 'off'> label={t('Auto-renew')} value={f.auto} onChange={(auto) => set({ auto })}
              items={[{ id: 'on', label: t('On') }, { id: 'off', label: t('Off') }]} />
            <ChipGroup<'active' | 'suspended'> label={t('Company status')} value={f.company} onChange={(company) => set({ company })}
              items={[{ id: 'active', label: t('Not suspended') }, { id: 'suspended', label: t('Suspended') }]} />
            <div>
              <span class="label">{t('Renewal')}</span>
              <Chip on={f.renew30} onClick={() => set({ renew30: !f.renew30 })}>{t('Renewing within 30 days')}</Chip>
            </div>
          </FilterPanel>
          <button class="btn-secondary px-3" disabled={exporting || !list.length} onClick={() => void exportXlsx()}
            title={pick.chosen.length ? t('Export {n} selected', { n: pick.chosen.length }) : t('Export all {n}', { n: list.length })} aria-label={t('Export to Excel')}>
            {exporting ? <Spinner class="size-4" /> : <FileSpreadsheet class="size-4" />}<span class="hidden sm:inline">{t('Export')}</span>
          </button>
        </div>
        <ActiveChips chips={chips} onClearAll={() => setF(emptySubFilters())} />
      </div>

      <BulkBar count={pick.chosen.length} onClear={pick.clear}>
        <button class={BULK} disabled={exporting} onClick={() => void exportXlsx()}>
          {exporting ? <Spinner class="size-3.5" /> : <FileSpreadsheet class="size-3.5" />}{t('Export selected')}
        </button>
      </BulkBar>

      <div class="card overflow-hidden">
        {rows.length === 0 ? <Empty icon={<Repeat class="size-6" />} title={t('No subscriptions yet')} text={t('Companies you put on a plan appear here.')} />
          : list.length === 0 ? <Empty icon={<Repeat class="size-6" />} title={t('No subscriptions match')} text={t('Try removing a filter or changing the search.')} />
          : (
            <>
              <table class="hidden w-full text-sm lg:table">
                <thead class="bg-subtle text-left text-xs font-semibold text-muted">
                  <tr>
                    <th class="w-10 px-4 py-2.5">
                      <Tick on={pick.allOn} indeterminate={pick.chosen.length > 0 && !pick.allOn} onChange={pick.toggleAll} label={t('Select all subscriptions')} />
                    </th>
                    <SortHeader id="company" sort={sort} onSort={setSort}>{t('Company')}</SortHeader>
                    <SortHeader id="plan" sort={sort} onSort={setSort}>{t('Plan')}</SortHeader>
                    <SortHeader id="cycle" sort={sort} onSort={setSort}>{t('Cycle')}</SortHeader>
                    <SortHeader id="renews" sort={sort} onSort={setSort}>{t('Renews on')}</SortHeader>
                    <SortHeader id="auto" sort={sort} onSort={setSort}>{t('Auto-renew')}</SortHeader>
                    <SortHeader id="mrr" sort={sort} onSort={setSort} align="right">{t('MRR')}</SortHeader>
                    <th />
                  </tr>
                </thead>
                <tbody class="divide-y divide-line">
                  {list.map((r) => (
                    <tr key={r.company_id} class={`cursor-pointer hover:bg-brand-50/40 ${pick.sel.has(r.company_id) ? 'bg-ocean-50/50' : ''}`} onClick={() => setOpen(r)}>
                      <td class="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <Tick on={pick.sel.has(r.company_id)} onChange={(v) => pick.toggle(r.company_id, v)} label={t('Select {name}', { name: r.company_name })} />
                      </td>
                      <td class="px-4 py-3">
                        <span class="flex flex-wrap items-center gap-1.5 font-semibold">{r.company_name}{suspended.has(r.company_id) && <SuspendedPill />}</span>
                      </td>
                      <td class="px-4 py-3">{r.plan_name || <span class="text-muted">{t('No plan')}</span>}</td>
                      <td class="px-4 py-3">{cycleLabel(r.billing_cycle)}</td>
                      <td class="px-4 py-3 tabular-nums">{asDate(r.renews_on)}</td>
                      <td class="px-4 py-3">
                        <span class={`pill ${r.auto_renew ? 'bg-brand-100 text-brand-800' : 'bg-subtle text-muted'}`}>{r.auto_renew ? t('On') : t('Off')}</span>
                      </td>
                      <td class="px-4 py-3 text-right font-semibold tabular-nums">{money(r.mrr, r.currency)}</td>
                      <td class="px-4 py-3 text-right"><span class="link text-sm">{t('Change')}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div class="flex items-center justify-between gap-2 border-b border-line px-4 py-2 lg:hidden">
                <span class="flex items-center gap-2 text-xs font-medium text-muted">
                  <Tick on={pick.allOn} indeterminate={pick.chosen.length > 0 && !pick.allOn} onChange={pick.toggleAll} label={t('Select all subscriptions')} />
                  {t('Select all')}
                </span>
                <SortMenu sort={sort} onSort={setSort} options={[
                  { id: 'mrr', label: t('MRR') }, { id: 'company', label: t('Company') }, { id: 'plan', label: t('Plan') },
                  { id: 'cycle', label: t('Cycle') }, { id: 'renews', label: t('Renews on') }, { id: 'auto', label: t('Auto-renew') },
                ]} />
              </div>
              <ul class="divide-y divide-line lg:hidden">
                {list.map((r) => (
                  <li key={r.company_id} class={`flex items-center gap-2 ${pick.sel.has(r.company_id) ? 'bg-ocean-50/50' : ''}`}>
                    <span class="flex min-h-11 items-center pl-4">
                      <Tick on={pick.sel.has(r.company_id)} onChange={(v) => pick.toggle(r.company_id, v)} label={t('Select {name}', { name: r.company_name })} />
                    </span>
                    <button class="flex min-h-11 min-w-0 flex-1 items-center gap-3 py-3 pr-4 pl-1 text-left" onClick={() => setOpen(r)}>
                      <span class="min-w-0 flex-1">
                        <span class="flex items-center gap-1.5">
                          <span class="min-w-0 truncate font-semibold">{r.company_name}</span>
                          {suspended.has(r.company_id) && <SuspendedPill />}
                        </span>
                        <span class="block truncate text-xs text-muted">
                          {(r.plan_name || t('No plan'))} · {cycleLabel(r.billing_cycle)} · {asDate(r.renews_on)}
                        </span>
                      </span>
                      <span class="flex shrink-0 flex-col items-end gap-1">
                        <span class="text-sm font-semibold tabular-nums">{money(r.mrr, r.currency)}</span>
                        <span class={`pill ${r.auto_renew ? 'bg-brand-100 text-brand-800' : 'bg-subtle text-muted'}`}>{r.auto_renew ? t('Auto-renew') : t('Ends')}</span>
                      </span>
                      <ChevronRight class="size-4 shrink-0 text-muted" />
                    </button>
                  </li>
                ))}
              </ul>
              <p class="border-t border-line px-4 py-2 text-xs text-muted">{tn(list.length, '{n} subscription', '{n} subscriptions')}</p>
            </>
          )}
      </div>

      {open && <SubSheet row={open} plans={plans} onClose={() => setOpen(null)} onDone={() => { setOpen(null); void load(); }} />}
    </>
  );
}

function SubSheet({ row, plans, onClose, onDone }: { row: SubRow; plans: Plan[]; onClose: () => void; onDone: () => void }) {
  const [s, setS] = useState<Omit<Subscription, 'company_id'>>({ plan_id: row.plan_id, billing_cycle: row.billing_cycle, renews_on: row.renews_on, auto_renew: row.auto_renew });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const plan = plans.find((p) => p.id === s.plan_id) ?? null;

  async function save() {
    setErr('');
    if (!s.renews_on) { setErr(t('Pick a renewal date.')); return; }
    setBusy(true);
    try {
      await (await backend()).setSubscription(row.company_id, s);
      toast(t('Subscription updated'), 'success');
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // A hidden plan stays listed while it is the current one, so opening the sheet never changes it.
  const choices = plans.filter((p) => p.active || p.id === row.plan_id);

  return (
    <Sheet open onClose={onClose} centered title={row.company_name}
      footer={<button class="btn-primary ml-auto min-w-32" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : t('Save subscription')}</button>}>
      <div class="space-y-4">
        <Field label={t('Plan')}>
          <Select class="w-full" label={t('Plan')} value={s.plan_id ?? ''} onChange={(v) => setS({ ...s, plan_id: v || null })}
            options={[{ value: '', label: t('No plan') }, ...choices.map((p) => ({ value: p.id, label: p.active ? p.name : `${p.name} (${t('Hidden')})` }))]} />
        </Field>

        <div>
          <span class="label">{t('Billing cycle')}</span>
          <div class="grid grid-cols-2 gap-2">
            {([['monthly', t('Monthly')], ['annual', t('Yearly')]] as const).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={s.billing_cycle === id} onClick={() => setS({ ...s, billing_cycle: id })}
                class={`chip min-h-11 justify-center ${s.billing_cycle === id ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface'}`}>{label}</button>
            ))}
          </div>
        </div>

        <Field label={t('Renews on')} for="s-renew">
          <input id="s-renew" type="date" class="input" value={s.renews_on} onChange={(e) => setS({ ...s, renews_on: e.currentTarget.value })} />
        </Field>

        <Toggle label={t('Auto-renew')} hint={t('Off means the subscription ends on the renewal date.')} on={s.auto_renew} onChange={(auto_renew) => setS({ ...s, auto_renew })} />

        {plan && (
          <p class="rounded-xl bg-subtle px-3 py-2 text-xs text-muted">
            {t('{plan}: {price} per month, {seats} seats.', { plan: plan.name, price: money(plan.price_month, plan.currency), seats: plan.seats })}
          </p>
        )}
        {err && <p class="text-sm font-medium text-red-700">{err}</p>}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- invoices
interface InvoiceFilters {
  /** Multi-select: empty = every status. */
  statuses: InvoiceStatus[];
  /** Only invoices of suspended companies (a company flag, not an invoice status). */
  suspended: boolean;
  /** Multi-select: empty = every company. */
  company_ids: string[];
  /** '' = any plan, 'none' = invoices without a plan. */
  plan_id: string;
  /** Issue-date range, yyyy-mm-dd. */
  from: string;
  to: string;
}
const emptyInvoiceFilters = (): InvoiceFilters => ({ statuses: [], suspended: false, company_ids: [], plan_id: '', from: '', to: '' });

const INVOICE_SORT: Record<string, (i: Invoice) => string | number> = {
  number: (i) => i.number,
  company: (i) => i.company_name.toLowerCase(),
  plan: (i) => (i.plan_name || '').toLowerCase(),
  period: (i) => i.period_start,
  amount: (i) => i.amount + i.tax,
  status: (i) => INVOICE_STATUSES.indexOf(i.status),
  issued: (i) => i.issued_on,
  due: (i) => i.due_on,
};

/** What a bulk status change may touch — paid and cancelled invoices are final. */
const CAN_BECOME: Record<'sent' | 'paid' | 'cancelled', InvoiceStatus[]> = {
  sent: ['draft'],
  paid: ['draft', 'sent', 'overdue'],
  cancelled: ['draft', 'sent', 'overdue'],
};

function InvoicesTab({ plans, newOpen, closeNew }: { plans: Plan[]; newOpen: boolean; closeNew: () => void }) {
  const [rows, setRows] = useState<Invoice[] | null>(null);
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [q, setQ] = useState('');
  const [f, setF] = useState<InvoiceFilters>(emptyInvoiceFilters);
  const [sort, setSort] = useState<Sort>({ key: 'issued', dir: 'desc' });
  const [open, setOpen] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Invoice id being drawn, or 'bulk' for the selection. */
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);
  const [askPaid, setAskPaid] = useState(false);
  const [askCancel, setAskCancel] = useState(false);
  const [paidOn, setPaidOn] = useState(today());
  const [paidBy, setPaidBy] = useState('');

  const load = () => backend().then((b) => b.invoices()).then(setRows).catch((e) => { setRows([]); toast((e as Error).message, 'error'); });
  useEffect(() => { void load(); }, []);
  useEffect(() => { backend().then((b) => b.companies()).then(setCompanies).catch(() => {}); }, []);

  const set = (patch: Partial<InvoiceFilters>) => setF((prev) => ({ ...prev, ...patch }));
  const suspendedIds = useMemo(() => new Set(companies.filter((c) => c.suspended).map((c) => c.id)), [companies]);
  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? rows?.find((i) => i.company_id === id)?.company_name ?? t('Company');
  const planName = (id: string) => (id === 'none' ? t('No plan') : plans.find((p) => p.id === id)?.name ?? t('Plan'));
  // Companies that have invoices come first in the picker; the rest follow.
  const companyItems = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of rows ?? []) seen.set(i.company_id, i.company_name);
    for (const c of companies) if (!seen.has(c.id)) seen.set(c.id, c.name);
    return [...seen].map(([id, label]) => ({ id, label, note: suspendedIds.has(id) ? t('Suspended') : '' })).sort((a, b) => a.label.localeCompare(b.label));
  }, [rows, companies, suspendedIds]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const found = (rows ?? []).filter((i) => {
      if (needle && !`${i.number} ${i.company_name} ${i.plan_name} ${i.notes} ${i.paid_by}`.toLowerCase().includes(needle)) return false;
      if (f.statuses.length && !f.statuses.includes(i.status)) return false;
      if (f.suspended && !suspendedIds.has(i.company_id)) return false;
      if (f.company_ids.length && !f.company_ids.includes(i.company_id)) return false;
      if (f.plan_id === 'none' ? i.plan_id : f.plan_id && i.plan_id !== f.plan_id) return false;
      if (f.from && i.issued_on < f.from) return false;
      if (f.to && i.issued_on > f.to) return false;
      return true;
    });
    return sortRows(found, sort, INVOICE_SORT, 'issued');
  }, [rows, q, f, sort, suspendedIds]);

  const pick = useSelection(list, (i) => i.id);
  const total = (i: Invoice) => i.amount + i.tax;
  const month = new Date().toISOString().slice(0, 7);
  const outstanding = useMemo(() => sumBy(list.filter((i) => i.status === 'sent' || i.status === 'overdue'), (i) => i.currency, total), [list]);
  const paidThisMonth = useMemo(() => sumBy(list.filter((i) => i.status === 'paid' && i.paid_on?.startsWith(month)), (i) => i.currency, total), [list]);

  // Issue-date presets.
  const year = new Date().getFullYear();
  const presets = [
    { id: 'month', label: t('This month'), from: `${month}-01` },
    { id: '30d', label: t('Last 30 days'), from: daysAgo(29) },
    { id: 'year', label: t('This year'), from: `${year}-01-01` },
  ];
  const preset = !f.to ? presets.find((p) => p.from === f.from) : undefined;
  const dateLabel = preset ? preset.label : f.from || f.to ? `${f.from || '…'} → ${f.to || '…'}` : '';

  const chips: FilterChip[] = [
    ...f.statuses.map((s) => ({ key: `s${s}`, label: statusLabel(s), clear: () => set({ statuses: f.statuses.filter((x) => x !== s) }) })),
    ...(f.suspended ? [{ key: 'susp', label: t('Suspended companies'), clear: () => set({ suspended: false }) }] : []),
    ...f.company_ids.map((id) => ({ key: `c${id}`, label: companyName(id), clear: () => set({ company_ids: f.company_ids.filter((x) => x !== id) }) })),
    ...(f.plan_id ? [{ key: 'plan', label: planName(f.plan_id), clear: () => set({ plan_id: '' }) }] : []),
    ...(dateLabel ? [{ key: 'date', label: `${t('Issued')} ${dateLabel}`, clear: () => set({ from: '', to: '' }) }] : []),
  ];
  const count = (f.statuses.length || f.suspended ? 1 : 0) + (f.company_ids.length ? 1 : 0) + (f.plan_id ? 1 : 0) + (f.from || f.to ? 1 : 0);

  // The quick status dropdown and the filter panel edit the same filter.
  const quick = !f.statuses.length && !f.suspended ? '' : f.statuses.length === 1 && !f.suspended ? f.statuses[0]! : !f.statuses.length && f.suspended ? 'suspended' : 'multi';
  const quickOptions = [
    { value: '', label: t('All statuses') },
    ...INVOICE_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
    { value: 'suspended', label: t('Suspended') },
    ...(quick === 'multi' ? [{ value: 'multi', label: t('Several statuses') }] : []),
  ];
  const setQuick = (v: string) => {
    if (v === 'multi') return;
    if (v === 'suspended') set({ statuses: [], suspended: true });
    else set({ statuses: v ? [v as InvoiceStatus] : [], suspended: false });
  };

  function summary() {
    const out: string[] = [];
    if (q.trim()) out.push(`${t('Search')}: ${q.trim()}`);
    if (f.statuses.length) out.push(`${t('Status')}: ${f.statuses.map(statusLabel).join(', ')}`);
    if (f.suspended) out.push(t('Suspended companies only'));
    if (f.company_ids.length) out.push(`${t('Companies')}: ${f.company_ids.map(companyName).join(', ')}`);
    if (f.plan_id) out.push(`${t('Plan')}: ${planName(f.plan_id)}`);
    if (dateLabel) out.push(`${t('Issued')}: ${dateLabel}`);
    if (pick.chosen.length) out.push(t('{n} selected rows only', { n: pick.chosen.length }));
    return out;
  }

  async function exportXlsx() {
    const only = pick.chosen.length ? pick.chosen : list;
    setExporting(true);
    try {
      save(await invoicesToXlsx(only, { filterSummary: summary() }), `wetano-invoices-${today()}.xlsx`);
      toast(tn(only.length, 'Export ready — {n} invoice', 'Export ready — {n} invoices'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setExporting(false); }
  }

  /** Bill-to details come from the company list; a company missing from it is looked up on its own. */
  async function billToFor(invoices: Invoice[]) {
    const map = new Map<string, BillTo>(companies.map((c) => [c.id, { name: c.name, headquarters: c.headquarters ?? '', country: c.country ?? '' }]));
    const missing = [...new Set(invoices.map((i) => i.company_id))].filter((id) => !map.has(id));
    if (missing.length) {
      const b = await backend();
      await Promise.all(missing.map(async (id) => {
        try {
          const d = await b.companyDetail(id);
          map.set(id, { name: d.name, headquarters: d.headquarters ?? '', country: d.country ?? '' });
        } catch { /* falls back to the name on the invoice */ }
      }));
    }
    return (id: string) => map.get(id);
  }

  async function downloadPdf(invoices: Invoice[]) {
    if (!invoices.length) return;
    setPdfBusy(invoices.length === 1 ? invoices[0]!.id : 'bulk');
    try {
      const blob = await invoicesToPdf(invoices, { billTo: await billToFor(invoices) });
      save(blob, invoices.length === 1 ? `${invoices[0]!.number}.pdf` : `wetano-invoices-${today()}.pdf`);
      toast(tn(invoices.length, '{n} invoice ready', '{n} invoices ready — one per page'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setPdfBusy(null); }
  }

  async function bulkStatus(status: 'sent' | 'paid' | 'cancelled', paid: { paid_on: string; paid_by: string } | null = null) {
    const targets = pick.chosen.filter((i) => CAN_BECOME[status].includes(i.status));
    const skipped = pick.chosen.length - targets.length;
    if (!targets.length) {
      toast(t('None of the selected invoices can be marked {status}.', { status: statusLabel(status).toLowerCase() }), 'error');
      return;
    }
    setBusy(true);
    const failed: string[] = [];
    try {
      const b = await backend();
      for (const i of targets) {
        try { await b.setInvoiceStatus(i.id, status, paid); } catch { failed.push(i.number); }
      }
      const done = targets.length - failed.length;
      if (done) {
        const msg = tn(done, '{n} invoice marked {status}', '{n} invoices marked {status}', { status: statusLabel(status).toLowerCase() });
        toast(skipped ? `${msg} · ${tn(skipped, '{n} skipped (status does not allow it)', '{n} skipped (status does not allow it)')}` : msg, 'success');
      }
      if (failed.length) toast(t('Could not update {list}', { list: failed.join(', ') }), 'error');
      setAskPaid(false);
      setAskCancel(false);
      await load();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  const eligible = (s: keyof typeof CAN_BECOME) => pick.chosen.filter((i) => CAN_BECOME[s].includes(i.status)).length;

  return (
    <>
      <div class="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Counter label={t('Outstanding')} value={outstanding} tone="amber" />
        <Counter label={t('Paid this month')} value={paidThisMonth} tone="brand" />
        <Counter label={t('Overdue')} value={list.filter((i) => i.status === 'overdue').length} tone="red" />
        <Counter label={t('Invoices')} value={list.length} tone="ocean" />
      </div>

      <div class="mb-2 space-y-2">
        <div class="flex items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder={t('Search number, company, plan…')} label={t('Search invoices')} />
          <FilterPanel title={t('Filter invoices')} count={count} onClearAll={() => setF(emptyInvoiceFilters())}>
            <div>
              <div class="flex items-baseline justify-between">
                <span class="label">{t('Status')}</span>
                {(f.statuses.length > 0 || f.suspended) && <button class="tap mb-1 text-[11px] font-semibold text-ocean-700 hover:underline" onClick={() => set({ statuses: [], suspended: false })}>{t('Clear')}</button>}
              </div>
              <div class="flex flex-wrap gap-2">
                {INVOICE_STATUSES.map((s) => (
                  <Chip key={s} on={f.statuses.includes(s)} onClick={() => set({ statuses: f.statuses.includes(s) ? f.statuses.filter((x) => x !== s) : [...f.statuses, s] })}>
                    {statusLabel(s)}
                  </Chip>
                ))}
                <Chip on={f.suspended} onClick={() => set({ suspended: !f.suspended })}>{t('Suspended')}</Chip>
              </div>
              <p class="mt-1 text-[11px] text-muted">{t('Suspended shows invoices of suspended companies.')}</p>
            </div>
            <MultiPick label={t('Companies')} all={t('All companies')} selected={f.company_ids} items={companyItems}
              onToggle={(id) => set({ company_ids: f.company_ids.includes(id) ? f.company_ids.filter((x) => x !== id) : [...f.company_ids, id] })}
              onClear={() => set({ company_ids: [] })} />
            <ChipGroup label={t('Plan')} value={f.plan_id} onChange={(plan_id) => set({ plan_id })}
              items={[...plans.map((p) => ({ id: p.id, label: p.name })), { id: 'none', label: t('No plan') }]} />
            <div>
              <span class="label">{t('Issue date')}</span>
              <div class="flex flex-wrap gap-2">
                {presets.map((p) => (
                  <Chip key={p.id} on={preset?.id === p.id} onClick={() => set(preset?.id === p.id ? { from: '', to: '' } : { from: p.from, to: '' })}>{p.label}</Chip>
                ))}
              </div>
              <div class="mt-2 grid grid-cols-2 gap-2">
                <input type="date" class="input" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.currentTarget.value })} aria-label={t('From date')} />
                <input type="date" class="input" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.currentTarget.value })} aria-label={t('To date')} />
              </div>
            </div>
          </FilterPanel>
          <div class="hidden w-44 shrink-0 sm:block">
            <Select class="w-full" label={t('Invoice status')} value={quick} onChange={setQuick} options={quickOptions} />
          </div>
          <button class="btn-secondary px-3" disabled={exporting || !list.length} onClick={() => void exportXlsx()}
            title={pick.chosen.length ? t('Export {n} selected', { n: pick.chosen.length }) : t('Export all {n}', { n: list.length })} aria-label={t('Export to Excel')}>
            {exporting ? <Spinner class="size-4" /> : <FileSpreadsheet class="size-4" />}<span class="hidden sm:inline">{t('Export')}</span>
          </button>
        </div>
        <ActiveChips chips={chips} onClearAll={() => setF(emptyInvoiceFilters())} />
      </div>

      <BulkBar count={pick.chosen.length} onClear={pick.clear}>
        <button class={BULK} disabled={exporting} onClick={() => void exportXlsx()}>
          {exporting ? <Spinner class="size-3.5" /> : <FileSpreadsheet class="size-3.5" />}{t('Export selected')}
        </button>
        <button class={BULK} disabled={pdfBusy !== null} onClick={() => void downloadPdf(pick.chosen)}>
          {pdfBusy === 'bulk' ? <Spinner class="size-3.5" /> : <FileDown class="size-3.5" />}{t('Download invoices')}
        </button>
        <button class={BULK} disabled={busy || !eligible('sent')} onClick={() => void bulkStatus('sent')}>
          <Send class="size-3.5" />{t('Mark as sent')}
        </button>
        <button class={BULK} disabled={busy || !eligible('paid')} onClick={() => { setPaidOn(today()); setPaidBy(''); setAskPaid(true); }}>
          <CircleDollarSign class="size-3.5" />{t('Mark as paid')}
        </button>
        <button class={`${BULK} border-red-200 text-red-700 hover:bg-red-50`} disabled={busy || !eligible('cancelled')} onClick={() => setAskCancel(true)}>
          <Ban class="size-3.5" />{t('Cancel')}
        </button>
      </BulkBar>

      <div class="card overflow-hidden">
        {!rows ? <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>
          : list.length === 0 ? <Empty icon={<ReceiptText class="size-6" />} title={t('No invoices match')} text={t('Change the filters, or create the first invoice.')} />
          : (
            <>
              <table class="hidden w-full text-sm lg:table">
                <thead class="bg-subtle text-left text-xs font-semibold text-muted">
                  <tr>
                    <th class="w-10 px-4 py-2.5">
                      <Tick on={pick.allOn} indeterminate={pick.chosen.length > 0 && !pick.allOn} onChange={pick.toggleAll} label={t('Select all invoices')} />
                    </th>
                    <SortHeader id="number" sort={sort} onSort={setSort}>{t('Number')}</SortHeader>
                    <SortHeader id="company" sort={sort} onSort={setSort}>{t('Company')}</SortHeader>
                    <SortHeader id="plan" sort={sort} onSort={setSort} class="hidden lg:table-cell">{t('Plan')}</SortHeader>
                    <SortHeader id="period" sort={sort} onSort={setSort} class="hidden lg:table-cell">{t('Period')}</SortHeader>
                    <SortHeader id="amount" sort={sort} onSort={setSort} align="right">{t('Amount')}</SortHeader>
                    <SortHeader id="status" sort={sort} onSort={setSort}>{t('Status')}</SortHeader>
                    <SortHeader id="due" sort={sort} onSort={setSort}>{t('Due')}</SortHeader>
                    <th class="w-12 px-2 py-2.5"><span class="sr-only">{t('Download invoice')}</span></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-line">
                  {list.map((i) => (
                    <tr key={i.id} class={`cursor-pointer hover:bg-brand-50/40 ${pick.sel.has(i.id) ? 'bg-ocean-50/50' : ''}`} onClick={() => setOpen(i)}>
                      <td class="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <Tick on={pick.sel.has(i.id)} onChange={(v) => pick.toggle(i.id, v)} label={t('Select {name}', { name: i.number })} />
                      </td>
                      <td class="px-4 py-3 font-semibold whitespace-nowrap tabular-nums">{i.number}</td>
                      <td class="px-4 py-3">
                        <span class="flex flex-wrap items-center gap-1.5">{i.company_name}{suspendedIds.has(i.company_id) && <SuspendedPill />}</span>
                      </td>
                      <td class="hidden px-4 py-3 text-muted lg:table-cell">{i.plan_name || '—'}</td>
                      <td class="hidden px-4 py-3 text-xs whitespace-nowrap tabular-nums lg:table-cell">{asDate(i.period_start)} → {asDate(i.period_end)}</td>
                      <td class="px-4 py-3 text-right font-semibold whitespace-nowrap tabular-nums">{money(total(i), i.currency)}</td>
                      <td class="px-4 py-3"><InvoicePill status={i.status} /></td>
                      <td class="px-4 py-3 whitespace-nowrap tabular-nums">{asDate(i.due_on)}</td>
                      <td class="px-2 py-1 text-right" onClick={(e) => e.stopPropagation()}>
                        <DownloadButton busy={pdfBusy === i.id} disabled={pdfBusy !== null} number={i.number} onClick={() => void downloadPdf([i])} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div class="flex items-center justify-between gap-2 border-b border-line px-4 py-2 lg:hidden">
                <span class="flex items-center gap-2 text-xs font-medium text-muted">
                  <Tick on={pick.allOn} indeterminate={pick.chosen.length > 0 && !pick.allOn} onChange={pick.toggleAll} label={t('Select all invoices')} />
                  {t('Select all')}
                </span>
                <SortMenu sort={sort} onSort={setSort} options={[
                  { id: 'issued', label: t('Issued') }, { id: 'due', label: t('Due') }, { id: 'amount', label: t('Amount') },
                  { id: 'company', label: t('Company') }, { id: 'number', label: t('Number') }, { id: 'status', label: t('Status') },
                  { id: 'plan', label: t('Plan') }, { id: 'period', label: t('Period') },
                ]} />
              </div>
              <ul class="divide-y divide-line lg:hidden">
                {list.map((i) => (
                  <li key={i.id} class={`flex items-center gap-1 ${pick.sel.has(i.id) ? 'bg-ocean-50/50' : ''}`}>
                    <span class="flex min-h-11 items-center pl-4">
                      <Tick on={pick.sel.has(i.id)} onChange={(v) => pick.toggle(i.id, v)} label={t('Select {name}', { name: i.number })} />
                    </span>
                    <button class="flex min-h-11 min-w-0 flex-1 items-start gap-3 py-3 pl-2 text-left" onClick={() => setOpen(i)}>
                      <span class="min-w-0 flex-1">
                        <span class="flex items-center gap-1.5">
                          <span class="min-w-0 truncate font-semibold">{i.company_name}</span>
                          {suspendedIds.has(i.company_id) && <SuspendedPill />}
                        </span>
                        <span class="block truncate text-xs text-muted tabular-nums">{i.number} · {t('due {date}', { date: asDate(i.due_on) })}</span>
                      </span>
                      <span class="flex shrink-0 flex-col items-end gap-1">
                        <span class="text-sm font-semibold tabular-nums">{money(total(i), i.currency)}</span>
                        <InvoicePill status={i.status} />
                      </span>
                    </button>
                    <span class="pr-2">
                      <DownloadButton busy={pdfBusy === i.id} disabled={pdfBusy !== null} number={i.number} onClick={() => void downloadPdf([i])} />
                    </span>
                  </li>
                ))}
              </ul>
              <p class="border-t border-line px-4 py-2 text-xs text-muted">{tn(list.length, '{n} invoice', '{n} invoices')}</p>
            </>
          )}
      </div>

      <Dialog open={askPaid} onClose={() => setAskPaid(false)} title={t('Mark as paid')}
        footer={<>
          <button class="btn-ghost" onClick={() => setAskPaid(false)}>{t('Cancel')}</button>
          <button class="btn-primary" disabled={busy || !paidOn} onClick={() => void bulkStatus('paid', { paid_on: paidOn, paid_by: paidBy.trim() })}>{busy ? <Spinner /> : t('Mark as paid')}</button>
        </>}>
        <div class="space-y-3">
          <p class="text-sm">{tn(eligible('paid'), 'This date and method are recorded on {n} invoice.', 'This date and method are recorded on all {n} invoices.')}</p>
          {eligible('paid') < pick.chosen.length && (
            <p class="text-xs text-muted">{tn(pick.chosen.length - eligible('paid'), '{n} selected invoice is already paid or cancelled and is left as it is.', '{n} selected invoices are already paid or cancelled and are left as they are.')}</p>
          )}
          <Field label={t('Paid on')} for="bpd-date"><input id="bpd-date" type="date" class="input" value={paidOn} onChange={(e) => setPaidOn(e.currentTarget.value)} /></Field>
          <Field label={t('How was it paid?')} for="bpd-by" hint={t('For example: bank transfer, card, cash.')}>
            <input id="bpd-by" class="input" value={paidBy} onInput={(e) => setPaidBy(e.currentTarget.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog open={askCancel} onClose={() => setAskCancel(false)} title={t('Cancel invoices?')}
        footer={<>
          <button class="btn-ghost" onClick={() => setAskCancel(false)}>{t('Keep them')}</button>
          <button class="btn-danger" disabled={busy} onClick={() => void bulkStatus('cancelled')}>{busy ? <Spinner /> : <Ban class="size-4" />}{t('Cancel invoices')}</button>
        </>}>
        <p class="text-sm">{tn(eligible('cancelled'), '{n} invoice will be cancelled. Nothing will be due on it.', '{n} invoices will be cancelled. Nothing will be due on them.')}</p>
        {eligible('cancelled') < pick.chosen.length && (
          <p class="mt-2 text-xs text-muted">{tn(pick.chosen.length - eligible('cancelled'), '{n} selected invoice is already paid or cancelled and is left as it is.', '{n} selected invoices are already paid or cancelled and are left as they are.')}</p>
        )}
        <p class="mt-2 text-sm text-muted">{t('Cancelled invoices stay in the list and in exports; this cannot be undone.')}</p>
      </Dialog>

      {newOpen && <NewInvoiceSheet companies={companies} plans={plans} onClose={closeNew} onDone={() => { closeNew(); void load(); }} />}
      {open && (
        <InvoiceSheet invoice={open} downloading={pdfBusy === open.id} onDownload={() => void downloadPdf([open])}
          onClose={() => setOpen(null)} onDone={(i) => { setOpen(i); void load(); }} />
      )}
    </>
  );
}

function DownloadButton({ busy, disabled, number, onClick }: { busy: boolean; disabled: boolean; number: string; onClick: () => void }) {
  return (
    <button class="inline-flex size-11 items-center justify-center rounded-xl text-ocean-700 transition hover:bg-ocean-50 disabled:opacity-50"
      disabled={disabled} onClick={onClick} aria-label={t('Download invoice {number}', { number })} title={t('Download invoice (PDF)')}>
      {busy ? <Spinner class="size-4" /> : <FileDown class="size-4" />}
    </button>
  );
}

type InvoiceInput = Omit<Invoice, 'id' | 'number' | 'company_name' | 'plan_name'>;

function NewInvoiceSheet({ companies, plans, onClose, onDone }: { companies: CompanySummary[]; plans: Plan[]; onClose: () => void; onDone: () => void }) {
  const [i, setI] = useState<InvoiceInput>({
    company_id: '', plan_id: null, period_start: today(), period_end: addMonths(1), amount: 0, tax: 0,
    currency: 'EUR', status: 'draft', issued_on: today(), due_on: addDays(14), paid_on: null, paid_by: '', notes: '',
  });
  const [amount, setAmount] = useState('0.00');
  const [tax, setTax] = useState('0.00');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (patch: Partial<InvoiceInput>) => setI((prev) => ({ ...prev, ...patch }));

  function pickPlan(id: string) {
    const p = plans.find((x) => x.id === id);
    set({ plan_id: id || null, currency: p?.currency ?? i.currency });
    if (p) setAmount(toMajor(p.price_month));
  }

  async function create() {
    setErr('');
    if (!i.company_id) { setErr(t('Pick a company.')); return; }
    if (i.period_end < i.period_start) { setErr(t('The period ends before it starts.')); return; }
    setBusy(true);
    try {
      const made = await (await backend()).createInvoice({ ...i, amount: toMinor(amount), tax: toMinor(tax), currency: i.currency.trim().toUpperCase() });
      toast(t('Invoice {number} created', { number: made.number }), 'success');
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Sheet open onClose={onClose} wide title={t('New invoice')}
      footer={<>
        <span class="text-xs text-muted tabular-nums">{money(toMinor(amount) + toMinor(tax), i.currency)}</span>
        <button class="btn-primary ml-auto min-w-32" disabled={busy} onClick={() => void create()}>{busy ? <Spinner /> : t('Create invoice')}</button>
      </>}>
      <div class="space-y-4">
        <Field label={t('Company')}>
          <Select class="w-full" label={t('Company')} value={i.company_id} onChange={(company_id) => set({ company_id })}
            options={[{ value: '', label: t('Pick a company') }, ...companies.map((c) => ({ value: c.id, label: c.suspended ? `${c.name} (${t('Suspended')})` : c.name }))]} />
        </Field>
        <Field label={t('Plan')}>
          <Select class="w-full" label={t('Plan')} value={i.plan_id ?? ''} onChange={pickPlan}
            options={[{ value: '', label: t('No plan') }, ...plans.map((p) => ({ value: p.id, label: p.name }))]} />
        </Field>
        <div class="grid grid-cols-2 gap-2">
          <Field label={t('Period start')} for="i-ps"><input id="i-ps" type="date" class="input" value={i.period_start} onChange={(e) => set({ period_start: e.currentTarget.value })} /></Field>
          <Field label={t('Period end')} for="i-pe"><input id="i-pe" type="date" class="input" value={i.period_end} onChange={(e) => set({ period_end: e.currentTarget.value })} /></Field>
          <Field label={t('Amount')} for="i-amt"><input id="i-amt" class="input" inputMode="decimal" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} onBlur={(e) => setAmount(toMajor(toMinor(e.currentTarget.value)))} /></Field>
          <Field label={t('Tax')} for="i-tax"><input id="i-tax" class="input" inputMode="decimal" value={tax} onInput={(e) => setTax(e.currentTarget.value)} onBlur={(e) => setTax(toMajor(toMinor(e.currentTarget.value)))} /></Field>
          <Field label={t('Currency')} for="i-cur"><input id="i-cur" class="input uppercase" maxLength={3} value={i.currency} onInput={(e) => set({ currency: e.currentTarget.value })} /></Field>
          <Field label={t('Issued on')} for="i-iss"><input id="i-iss" type="date" class="input" value={i.issued_on} onChange={(e) => set({ issued_on: e.currentTarget.value })} /></Field>
          <Field label={t('Due on')} for="i-due"><input id="i-due" type="date" class="input" value={i.due_on} onChange={(e) => set({ due_on: e.currentTarget.value })} /></Field>
          <Field label={t('Status')}>
            <Select<'draft' | 'sent'> class="w-full" label={t('Status')} value={i.status === 'sent' ? 'sent' : 'draft'} onChange={(status) => set({ status })}
              options={[{ value: 'draft', label: t('Draft') }, { value: 'sent', label: t('Sent') }]} />
          </Field>
        </div>
        <Field label={t('Notes')} for="i-notes"><textarea id="i-notes" class="input" rows={2} value={i.notes} onInput={(e) => set({ notes: e.currentTarget.value })} /></Field>
        {err && <p class="text-sm font-medium text-red-700">{err}</p>}
      </div>
    </Sheet>
  );
}

function addDays(n: number) { return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10); }

function InvoiceSheet({ invoice, downloading, onDownload, onClose, onDone }: {
  invoice: Invoice; downloading: boolean; onDownload: () => void; onClose: () => void; onDone: (i: Invoice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [askPaid, setAskPaid] = useState(false);
  const [askCancel, setAskCancel] = useState(false);
  const [paidOn, setPaidOn] = useState(today());
  const [paidBy, setPaidBy] = useState(invoice.paid_by || '');

  async function setStatus(status: InvoiceStatus, paid: { paid_on: string; paid_by: string } | null = null) {
    setBusy(true);
    try {
      const next = await (await backend()).setInvoiceStatus(invoice.id, status, paid);
      toast(t('Invoice {number} is now {status}', { number: invoice.number, status: statusLabel(status).toLowerCase() }), 'success');
      setAskPaid(false);
      onDone(next);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  const done = invoice.status === 'paid' || invoice.status === 'cancelled';

  return (
    <>
      <Sheet open onClose={onClose} wide title={<span class="flex items-center gap-2">{invoice.number}<InvoicePill status={invoice.status} /></span>}
        footer={done ? <span class="text-xs text-muted">{invoice.status === 'paid' ? t('Paid on {date}', { date: asDate(invoice.paid_on) }) : t('This invoice was cancelled.')}</span> : <>
          <button class="btn-danger px-3" disabled={busy} onClick={() => setAskCancel(true)}><Ban class="size-4" />{t('Cancel')}</button>
          {invoice.status === 'draft' && <button class="btn-secondary px-3" disabled={busy} onClick={() => void setStatus('sent')}><Send class="size-4" />{t('Send')}</button>}
          <button class="btn-primary ml-auto" disabled={busy} onClick={() => setAskPaid(true)}><CircleDollarSign class="size-4" />{t('Mark as paid')}</button>
        </>}>
        <div class="space-y-4">
          <div class="card bg-subtle p-4">
            <p class="text-2xl font-bold tabular-nums">{money(invoice.amount + invoice.tax, invoice.currency)}</p>
            <p class="text-xs text-muted tabular-nums">{t('Net {net} + tax {tax}', { net: money(invoice.amount, invoice.currency), tax: money(invoice.tax, invoice.currency) })}</p>
          </div>
          <button class="btn-secondary w-full" disabled={downloading} onClick={onDownload}>
            {downloading ? <Spinner class="size-4" /> : <FileDown class="size-4" />}{t('Download invoice (PDF)')}
          </button>
          <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt class="text-muted">{t('Company')}</dt><dd class="font-medium break-words">{invoice.company_name}</dd>
            <dt class="text-muted">{t('Plan')}</dt><dd class="font-medium">{invoice.plan_name || '—'}</dd>
            <dt class="text-muted">{t('Period')}</dt><dd class="font-medium tabular-nums">{asDate(invoice.period_start)} → {asDate(invoice.period_end)}</dd>
            <dt class="text-muted">{t('Issued on')}</dt><dd class="font-medium tabular-nums">{asDate(invoice.issued_on)}</dd>
            <dt class="text-muted">{t('Due on')}</dt><dd class="font-medium tabular-nums">{asDate(invoice.due_on)}</dd>
            {invoice.paid_on && <><dt class="text-muted">{t('Paid on')}</dt><dd class="font-medium tabular-nums">{asDate(invoice.paid_on)}</dd></>}
            {invoice.paid_by && <><dt class="text-muted">{t('Paid by')}</dt><dd class="font-medium break-words">{invoice.paid_by}</dd></>}
          </dl>
          {invoice.notes && <p class="rounded-xl bg-subtle px-3 py-2 text-sm break-words">{invoice.notes}</p>}
        </div>
      </Sheet>

      <Dialog open={askCancel} onClose={() => setAskCancel(false)} title={t('Cancel invoice {number}?', { number: invoice.number })}
        footer={<>
          <button class="btn-ghost" onClick={() => setAskCancel(false)}>{t('Keep it')}</button>
          <button class="btn-danger" disabled={busy} onClick={() => { setAskCancel(false); void setStatus('cancelled'); }}>{t('Cancel invoice')}</button>
        </>}>
        <p class="text-sm">{t('Nothing will be due on this invoice any more. This is recorded in the audit log.')}</p>
      </Dialog>
      <Dialog open={askPaid} onClose={() => setAskPaid(false)} title={t('Mark as paid')}
        footer={<>
          <button class="btn-ghost" onClick={() => setAskPaid(false)}>{t('Cancel')}</button>
          <button class="btn-primary" disabled={busy || !paidOn} onClick={() => void setStatus('paid', { paid_on: paidOn, paid_by: paidBy.trim() })}>{busy ? <Spinner /> : t('Mark as paid')}</button>
        </>}>
        <div class="space-y-3">
          <Field label={t('Paid on')} for="pd-date"><input id="pd-date" type="date" class="input" value={paidOn} onChange={(e) => setPaidOn(e.currentTarget.value)} /></Field>
          <Field label={t('How was it paid?')} for="pd-by" hint={t('For example: bank transfer, card, cash.')}>
            <input id="pd-by" class="input" value={paidBy} onInput={(e) => setPaidBy(e.currentTarget.value)} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- shared bits

const SuspendedPill = () => <span class="pill bg-red-100 text-red-700">{t('Suspended')}</span>;

function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function sortRows<T>(rows: T[], sort: Sort, keys: Record<string, (r: T) => string | number>, fallback: string): T[] {
  const read = keys[sort.key] ?? keys[fallback]!;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = read(a); const y = read(b);
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}

/** Tick-box selection over the visible list; ticks on rows that are filtered away are dropped. */
function useSelection<T>(list: T[], idOf: (r: T) => string) {
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    const ids = new Set(list.map(idOf));
    setSelected((prev) => (prev.every((id) => ids.has(id)) ? prev : prev.filter((id) => ids.has(id))));
  }, [list]);
  const sel = useMemo(() => new Set(selected), [selected]);
  const chosen = useMemo(() => list.filter((r) => sel.has(idOf(r))), [list, sel]);
  return {
    sel,
    chosen,
    allOn: list.length > 0 && chosen.length === list.length,
    clear: () => setSelected([]),
    toggle: (id: string, on: boolean) => setSelected((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id))),
    toggleAll: (on: boolean) => setSelected(on ? list.map(idOf) : []),
  };
}

interface FilterChip { key: string; label: string; clear: () => void }

/**
 * Filter button with a count badge — the same pattern as the Leads toolbar: a popover beside the
 * button on laptops, a bottom sheet on phones.
 */
function FilterPanel({ title, count, onClearAll, children }: { title: string; count: number; onClearAll: () => void; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);

  return (
    <div class="relative shrink-0" ref={wrap}>
      <button
        class={`btn relative border px-3 ${count ? 'border-ocean-600 bg-ocean-50 text-ocean-700' : 'border-line bg-surface text-ink hover:border-ocean-500 hover:text-ocean-700'}`}
        onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label={title}
      >
        <SlidersHorizontal class="size-4" />
        <span class="hidden sm:inline">{t('Filter')}</span>
        {count > 0 && <span class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ocean-600 text-[11px] font-bold text-white">{count}</span>}
      </button>

      {open && <div class="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm sm:hidden" onClick={() => setOpen(false)} />}
      {open && (
        <div class="pop fixed inset-x-0 bottom-0 z-40 max-h-[80dvh] overflow-y-auto rounded-t-3xl rounded-b-none p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:bottom-auto sm:mt-2 sm:max-h-[70vh] sm:w-[340px] sm:rounded-2xl sm:pb-4" role="dialog" aria-label={title}>
          <div class="mb-3 flex items-center justify-between">
            <p class="text-sm font-bold">{title}</p>
            <button class="inline-flex min-h-11 items-center text-xs font-semibold text-ocean-700 hover:underline disabled:opacity-40" disabled={!count} onClick={onClearAll}>{t('Clear all')}</button>
          </div>
          <div class="space-y-4">{children}</div>
          <button class="btn-primary mt-4 w-full" onClick={() => setOpen(false)}>{t('Show results')}</button>
        </div>
      )}
    </div>
  );
}

/** Removable chips under the toolbar, one per active filter. */
function ActiveChips({ chips, onClearAll }: { chips: FilterChip[]; onClearAll: () => void }) {
  if (!chips.length) return null;
  return (
    <div class="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span key={c.key} class="inline-flex max-w-full items-center gap-1 rounded-full bg-ocean-50 py-1 pr-1 pl-2.5 text-xs font-semibold text-ocean-800">
          <span class="truncate">{c.label}</span>
          <button class="-my-2 flex size-10 items-center justify-center rounded-full hover:bg-ocean-100" onClick={c.clear} aria-label={`${t('Remove filter')} ${c.label}`}><X class="size-3.5" /></button>
        </span>
      ))}
      {chips.length > 1 && <button class="inline-flex min-h-11 items-center px-1 text-xs font-semibold text-muted hover:text-ink" onClick={onClearAll}>{t('Clear all')}</button>}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ComponentChildren }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      class={`chip ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-surface text-ink hover:border-ocean-500'}`}>
      {children}
    </button>
  );
}

function ChipGroup<T extends string>({ label, value, onChange, items }: { label: string; value: T | ''; onChange: (v: T | '') => void; items: { id: T; label: string }[] }) {
  return (
    <div>
      <span class="label">{label}</span>
      <div class="flex flex-wrap gap-2">
        <Chip on={!value} onClick={() => onChange('')}>{t('Any')}</Chip>
        {items.map((i) => <Chip key={i.id} on={value === i.id} onClick={() => onChange(value === i.id ? '' : i.id)}>{i.label}</Chip>)}
      </div>
    </div>
  );
}

/** Checkbox list — “All …” when nothing is ticked, so the common case needs no clicks. */
function MultiPick({ label, all, items, selected, onToggle, onClear }: {
  label: string; all: string; selected: string[]; onToggle: (id: string) => void; onClear: () => void;
  items: { id: string; label: string; note?: string }[];
}) {
  return (
    <div>
      <div class="flex items-baseline justify-between">
        <span class="label">{label}</span>
        {selected.length > 0 && <button class="tap mb-1 text-[11px] font-semibold text-ocean-700 hover:underline" onClick={onClear}>{t('Clear')}</button>}
      </div>
      <div class="max-h-44 overflow-y-auto rounded-xl border border-line">
        <button class={`flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm ${selected.length === 0 ? 'bg-brand-50 font-semibold text-brand-800' : 'hover:bg-subtle'}`} onClick={onClear}>
          <span class={`flex size-4 items-center justify-center rounded border ${selected.length === 0 ? 'border-brand-600 bg-brand-600 text-white' : 'border-line'}`}>{selected.length === 0 && <Check class="size-3" />}</span>
          {all}
        </button>
        {items.map((i) => {
          const on = selected.includes(i.id);
          return (
            <button key={i.id} class={`flex min-h-11 w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-sm ${on ? 'bg-ocean-50' : 'hover:bg-subtle'}`} onClick={() => onToggle(i.id)} aria-pressed={on}>
              <span class={`flex size-4 shrink-0 items-center justify-center rounded border ${on ? 'border-ocean-600 bg-ocean-600 text-white' : 'border-line'}`}>{on && <Check class="size-3" />}</span>
              <span class="min-w-0 flex-1 truncate">{i.label}</span>
              {i.note && <span class="shrink-0 text-[11px] font-semibold text-red-700">{i.note}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      class="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-left">
      <span>
        <span class="block text-sm font-semibold">{label}</span>
        {hint && <span class="block text-xs text-muted">{hint}</span>}
      </span>
      <span class={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${on ? 'bg-brand-600' : 'bg-subtle'}`}>
        <span class={`size-5 rounded-full bg-white shadow transition ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- individual plans tab (synchronized with PlansTab)
function IndividualPlansTab() {
  const [pricing, setPricing] = useState<IndividualPricingConfig | null>(null);
  const [individuals, setIndividuals] = useState<Person[]>([]);
  const [editModal, setEditModal] = useState<'free' | 'pro' | null>(null);

  const load = () => {
    void backend().then((b) => b.getIndividualPricing()).then(setPricing).catch((e) => toast((e as Error).message, 'error'));
    void backend().then((b) => b.listIndividuals()).then(setIndividuals).catch(() => {});
  };

  useEffect(() => { void load(); }, []);

  if (!pricing) return <div class="flex justify-center py-16"><Spinner class="size-6 text-brand-700" /></div>;

  const proCount = individuals.filter((i) => i.plan === 'pro').length;
  const totalScans = individuals.reduce((acc, i) => acc + (i.monthly_scans ?? 0), 0);
  const mrr = proCount * pricing.pro_price_month;
  const currency = pricing.currency || 'USD';

  return (
    <>
      {/* 4 Telemetry Counters matching SubsTab */}
      <div class="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Counter label={t('Individual accounts')} value={individuals.length} />
        <Counter label={t('Monthly recurring revenue')} value={money(mrr * 100, currency)} tone="ocean" />
        <Counter label={t('Pro subscribers')} value={proCount} tone="brand" />
        <Counter label={t('Scans this month')} value={totalScans.toLocaleString()} tone="amber" />
      </div>

      {/* Synchronized Plan Cards Grid matching Company Plans layout */}
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
        {/* Card 1: Solo Free */}
        <article class="card flex flex-col gap-3 p-4">
          <header class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h2 class="truncate font-bold">{t('Solo Free')}</h2>
              <p class="line-clamp-2 text-xs text-muted">{t('Default free tier for individual self-registered users.')}</p>
            </div>
            <span class="pill bg-brand-100 text-brand-800">{t('Active')}</span>
          </header>

          <p class="text-2xl font-bold tabular-nums">
            {money(0, currency)}<span class="text-sm font-medium text-muted"> / {t('month')}</span>
          </p>
          <p class="-mt-2 text-xs text-muted tabular-nums">{money(0, currency)} / {t('year')}</p>

          <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt class="text-muted">{t('Seats')}</dt>
            <dd class="font-semibold tabular-nums">1 ({t('Solo')})</dd>
            <dt class="text-muted">{t('Scans per month')}</dt>
            <dd class="font-semibold tabular-nums">{pricing.free_scans_limit}</dd>
          </dl>

          <div class="flex flex-wrap gap-1.5">
            <span class="pill bg-subtle text-muted">{t('Self-Registration')}</span>
            <span class="pill bg-subtle text-muted">{t('No card required')}</span>
          </div>

          {pricing.free_features && pricing.free_features.length > 0 && (
            <ul class="space-y-1 text-xs">
              {pricing.free_features.map((f, i) => (
                <li key={i} class="flex items-start gap-1.5">
                  <Check class="mt-0.5 size-3.5 shrink-0 text-brand-600" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          )}

          <div class="mt-auto flex gap-2">
            <button class="btn-secondary flex-1" onClick={() => setEditModal('free')}>
              <Pencil class="size-4" />{t('Edit plan')}
            </button>
          </div>
        </article>

        {/* Card 2: WeTa Snap Pro */}
        <article class="card flex flex-col gap-3 p-4">
          <header class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h2 class="truncate font-bold">{t('WeTa Snap Pro')}</h2>
              <p class="line-clamp-2 text-xs text-muted">{t('Unlimited card scans, Gemini AI verification & exports.')}</p>
            </div>
            <span class="pill bg-brand-100 text-brand-800">{t('Active')}</span>
          </header>

          <p class="text-2xl font-bold tabular-nums">
            {money(pricing.pro_price_month * 100, currency)}<span class="text-sm font-medium text-muted"> / {t('month')}</span>
          </p>
          <p class="-mt-2 text-xs text-muted tabular-nums">
            {money(pricing.pro_price_year * 100, currency)} / {t('year')}
            {pricing.pro_price_month * 12 > pricing.pro_price_year && (
              <span class="ml-1 text-brand-700 font-semibold">
                ({t('saves {n}/yr', { n: money((pricing.pro_price_month * 12 - pricing.pro_price_year) * 100, currency) })})
              </span>
            )}
          </p>

          <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt class="text-muted">{t('Seats')}</dt>
            <dd class="font-semibold tabular-nums">1 ({t('Solo')})</dd>
            <dt class="text-muted">{t('Scans per month')}</dt>
            <dd class="font-semibold tabular-nums">{t('Unlimited')}</dd>
          </dl>

          <div class="flex flex-wrap gap-1.5">
            <span class="pill bg-brand-100 text-brand-800">{t('Unlimited Scans')}</span>
            <span class="pill bg-ocean-100 text-ocean-800">{t('Gemini AI Verification')}</span>
            <span class="pill bg-ocean-100 text-ocean-800">{t('Full Exports')}</span>
          </div>

          {pricing.pro_features && pricing.pro_features.length > 0 && (
            <ul class="space-y-1 text-xs">
              {pricing.pro_features.map((f, i) => (
                <li key={i} class="flex items-start gap-1.5">
                  <Check class="mt-0.5 size-3.5 shrink-0 text-brand-600" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          )}

          <div class="mt-auto flex gap-2">
            <button class="btn-secondary flex-1" onClick={() => setEditModal('pro')}>
              <Pencil class="size-4" />{t('Edit plan')}
            </button>
          </div>
        </article>
      </div>

      {editModal && (
        <IndividualPlanSheet
          mode={editModal}
          pricing={pricing}
          onClose={() => setEditModal(null)}
          onDone={() => { setEditModal(null); void load(); }}
        />
      )}
    </>
  );
}

function IndividualPlanSheet({
  mode,
  pricing,
  onClose,
  onDone,
}: {
  mode: 'free' | 'pro';
  pricing: IndividualPricingConfig;
  onClose: () => void;
  onDone: () => void;
}) {
  const isFree = mode === 'free';
  const [freeLimit, setFreeLimit] = useState(pricing.free_scans_limit);
  const [proMonth, setProMonth] = useState(pricing.pro_price_month);
  const [proYear, setProYear] = useState(pricing.pro_price_year);
  const [currency, setCurrency] = useState(pricing.currency || 'USD');
  const [featureText, setFeatureText] = useState((isFree ? pricing.free_features : pricing.pro_features).join('\n'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setErr('');
    if (!isFree && proMonth < 1) { setErr(t('Monthly price must be at least 1.')); return; }
    if (!isFree && proYear < 1) { setErr(t('Yearly price must be at least 1.')); return; }
    if (isFree && freeLimit < 1) { setErr(t('Free limit must be at least 1 scan.')); return; }

    setBusy(true);
    try {
      const parsedFeatures = featureText.split('\n').map((f) => f.trim()).filter(Boolean);
      await (await backend()).updateIndividualPricing({
        ...(isFree
          ? { free_scans_limit: freeLimit, free_features: parsedFeatures }
          : { pro_price_month: proMonth, pro_price_year: proYear, currency, pro_features: parsedFeatures }),
      });
      toast(t('Plan saved successfully'), 'success');
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const title = isFree ? t('Edit Solo Free Plan') : t('Edit WeTa Snap Pro Plan');

  return (
    <Sheet open onClose={onClose} centered wide title={title}
      footer={<>
        <span class="text-xs text-muted">
          {isFree ? t('{n} scans/mo', { n: freeLimit }) : `${money(proMonth * 100, currency)} / ${t('month')}`}
        </span>
        <button class="btn-primary ml-auto min-w-32" disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner /> : t('Save plan')}
        </button>
      </>}>
      <div class="space-y-4">
        {err && <p class="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">{err}</p>}

        <Field label={t('Plan name')} for="ind-name">
          <input id="ind-name" class="input" value={isFree ? t('Solo Free') : t('WeTa Snap Pro')} disabled />
        </Field>

        <Field label={t('Description')} for="ind-desc">
          <textarea
            id="ind-desc"
            class="input"
            rows={2}
            value={isFree ? t('Default free tier for individual self-registered users.') : t('Unlimited card scans, Gemini AI verification & exports.')}
            disabled
          />
        </Field>

        {isFree ? (
          <div class="grid grid-cols-2 gap-2">
            <Field label={t('Monthly free scan limit')} for="ind-limit" hint={t('After this limit, users are prompted to upgrade.')}>
              <input
                id="ind-limit"
                type="number"
                min={1}
                max={500}
                class="input"
                value={freeLimit}
                onInput={(e) => setFreeLimit(Number(e.currentTarget.value))}
              />
            </Field>
            <Field label={t('Price')} for="ind-free-price">
              <input id="ind-free-price" class="input" value="$0.00" disabled />
            </Field>
          </div>
        ) : (
          <div class="grid grid-cols-3 gap-2">
            <Field label={t('Price per month')} for="ind-month" hint={t('Shown in {currency}', { currency })}>
              <input
                id="ind-month"
                type="number"
                min={1}
                class="input font-semibold"
                value={proMonth}
                onInput={(e) => setProMonth(Number(e.currentTarget.value))}
              />
            </Field>
            <Field label={t('Price per year')} for="ind-year">
              <input
                id="ind-year"
                type="number"
                min={1}
                class="input font-semibold"
                value={proYear}
                onInput={(e) => setProYear(Number(e.currentTarget.value))}
              />
            </Field>
            <Field label={t('Currency')} for="ind-cur">
              <input
                id="ind-cur"
                class="input uppercase"
                maxLength={3}
                value={currency}
                onInput={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
              />
            </Field>
          </div>
        )}

        <div>
          <label class="label" for="ind-features">{t('Features list (one line per bullet)')}</label>
          <textarea
            id="ind-features"
            class="input text-xs"
            rows={6}
            value={featureText}
            onInput={(e) => setFeatureText(e.currentTarget.value)}
          />
          <p class="mt-1 text-xs text-muted">{t('These features appear directly on the Upgrade screen for individual users.')}</p>
        </div>
      </div>
    </Sheet>
  );
}
