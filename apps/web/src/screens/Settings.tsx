import { useEffect, useRef, useState } from 'preact/hooks';
import { Download, Plus, GripVertical, ChevronUp, ChevronDown, Trash2, Link2, Send, CheckCircle2, CalendarDays, LifeBuoy, MapPin, Plug, Unplug, Paperclip, FileText, Copy, Star, Tag as TagIcon, ScanLine, Sparkles, X } from 'lucide-preact';
import { Dialog, Field, Spinner, Tabs } from '../components/ui';
import { backend } from '../lib/backend';
import { useStore, toast } from '../lib/store';
import { config, pullConfig, refreshSession, session } from '../lib/session';
import { CONNECTOR_LABEL, CONNECTOR_ORDER } from '../lib/connectors';
import { TAG_META } from '../lib/leads';
import { ocrHealth, ocrUrl, setOcrUrl, type OcrHealth } from '../lib/ocr';
import {
  GEMINI_MODELS, geminiApiKey, geminiModel,
  setGeminiApiKey, setGeminiModel, testGeminiApiKey, type GeminiModelId,
} from '../lib/gemini';
import { LANGUAGES, TIME_ZONES } from '../lib/locale';
import { LICENCE_META, daysLeft, licenceStatus } from '../lib/licence';
import { DEFAULT_FOLLOWUP_MESSAGE, saveFollowUpConfig } from '../lib/followup';
import { invoicesToPdf } from '../lib/billingExport';
import { t, tn } from '../lib/i18n';
import type { Company, Connection, ConnectorKind, EventItem, FieldDefinition, FieldTemplate, FieldType, Invoice, Tag, TagColour } from '../lib/types';
import type { SeatInfo } from '../lib/backend';

type Tab = 'events' | 'fields' | 'tags' | 'crm' | 'company' | 'billing';

/** S7 · Settings — make the scanner fit each company without developer work (ADM-03..05, CRM-01..09). */
export default function Settings() {
  const [tab, setTab] = useState<Tab>(() => (location.pathname.endsWith('/crm') ? 'crm' : (new URLSearchParams(location.search).get('tab') as Tab) || 'events'));
  // Back from the CRM's sign-in page (crm-oauth callback).
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const done = p.get('connected') as ConnectorKind | null;
    if (done) toast(t('{crm} connected', { crm: CONNECTOR_LABEL[done] ?? done }), 'success');
    if (p.get('error')) toast(p.get('error')!, 'error', 8000);
    if (done || p.get('error')) history.replaceState(null, '', '/settings?tab=crm');
  }, []);
  const change = (v: Tab) => { setTab(v); history.replaceState(null, '', `/client-admin/settings?tab=${v}`); };
  return (
    <div class="mx-auto max-w-6xl">
      <div class="mb-5">
        <h1 class="text-2xl font-bold tracking-tight text-ink">{t('Settings')}</h1>
        <p class="text-sm text-muted mt-0.5">{t('Configure events, card fields, CRM connections and company details')}</p>
      </div>
      <Tabs value={tab} onChange={change} items={[
        { id: 'events', label: t('Events') }, { id: 'fields', label: t('Card fields') }, { id: 'tags', label: t('Tags') },
        { id: 'crm', label: t('CRM connection') }, { id: 'company', label: t('Company') },
        { id: 'billing', label: t('Billing & plan') },
      ]} />
      <div class="mt-5">
        {tab === 'events' && <EventsTab />}
        {tab === 'fields' && <FieldsTab />}
        {tab === 'tags' && <TagsTab />}
        {tab === 'crm' && <CrmTab />}
        {tab === 'company' && <CompanyTab />}
        {tab === 'billing' && <BillingTab />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Billing & plan (Client Admin)
function BillingTab() {
  const co = useStore(session)?.company ?? null;
  const [pdfBusy, setPdfBusy] = useState('');
  const [data, setData] = useState<Awaited<ReturnType<Awaited<ReturnType<typeof backend>>['mySubscription']>>>(undefined as never);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [seats, setSeats] = useState<SeatInfo | null>(null);

  useEffect(() => {
    void (async () => {
      const b = await backend();
      const [sub, inv, st] = await Promise.all([b.mySubscription(), b.invoices().catch(() => []), b.seats().catch(() => null)]);
      setData(sub); setInvoices(inv); setSeats(st);
    })().catch((e) => toast((e as Error).message, 'error'));
  }, []);

  async function downloadInvoice(inv: Invoice) {
    setPdfBusy(inv.id);
    try {
      const blob = await invoicesToPdf([inv], {
        billTo: () => ({ name: co?.name ?? inv.company_name ?? '', headquarters: co?.headquarters ?? '', country: co?.country ?? '' }),
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${inv.number}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setPdfBusy(''); }
  }

  if (data === undefined || !invoices) return <div class="flex justify-center py-12"><Spinner class="size-6 text-brand-700" /></div>;

  const plan = data?.plan ?? null;
  const sub = data?.subscription ?? null;
  const licence = seats?.licence;
  const status = licence ? licenceStatus(licence) : null;
  const scanLimit = plan?.scans_per_month ?? licence?.scans_per_month ?? 0;
  const scans = data?.scans_this_month ?? 0;
  const pct = scanLimit ? Math.min(100, Math.round((scans / scanLimit) * 100)) : 0;

  return (
    <div class="space-y-4">
      <div class="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div class="card p-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-xs font-semibold tracking-wide text-muted uppercase">{t('Your plan')}</p>
              <p class="title text-2xl font-bold">{plan?.name ?? t('No plan yet')}</p>
              <p class="mt-0.5 text-sm text-muted">{plan?.description ?? t('Ask WeTano which plan suits your shows.')}</p>
            </div>
            <div class="text-right">
              {plan && (
                <p class="title text-xl font-bold">
                  {money(sub?.billing_cycle === 'annual' ? plan.price_year : plan.price_month, plan.currency)}
                  <span class="text-xs font-medium text-muted"> / {sub?.billing_cycle === 'annual' ? t('year') : t('month')}</span>
                </p>
              )}
              {status && <span class={`pill mt-1 ${LICENCE_META[status].cls}`}>{t(LICENCE_META[status].label)}</span>}
            </div>
          </div>

          <dl class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('Seats used')} value={`${data?.seats_used ?? 0} / ${seats?.seats ?? plan?.seats ?? '—'}`} />
            <Stat label={t('Scans this month')} value={scanLimit ? `${scans} / ${scanLimit}` : String(scans)} />
            <Stat label={t('Renews on')} value={sub?.renews_on ? new Date(sub.renews_on).toLocaleDateString() : '—'} />
            <Stat label={t('Days left')} value={licence ? String(Math.max(0, daysLeft(licence.ends_on))) : '—'} />
          </dl>

          {scanLimit > 0 && (
            <div class="mt-4">
              <div class="mb-1 flex items-baseline justify-between text-xs">
                <span class="font-semibold">{t('Scan allowance')}</span>
                <span class="text-muted tabular-nums">{pct}%</span>
              </div>
              <div class="h-2.5 overflow-hidden rounded-full bg-line">
                <div class={`h-full rounded-full ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-gradient-to-r from-brand-500 to-ocean-600'}`} style={{ width: `${pct}%` }} />
              </div>
              {pct >= 80 && <p class="mt-1 text-xs font-medium text-amber-800">{t('You are close to this month\u2019s allowance — contact WeTano if you need more.')}</p>}
            </div>
          )}

          {plan && plan.features.length > 0 && (
            <ul class="mt-4 grid gap-1.5 sm:grid-cols-2">
              {plan.features.map((f) => (
                <li key={f} class="flex items-center gap-2 text-sm"><CheckCircle2 class="size-4 shrink-0 text-brand-600" />{f}</li>
              ))}
            </ul>
          )}
        </div>

        <div class="card h-fit p-4">
          <h3 class="title mb-1 text-sm font-bold">{t('Need a change?')}</h3>
          <p class="mb-3 text-xs text-muted">{t('More seats, a bigger scan allowance or another connector — WeTano sets these for you.')}</p>
          <a href="/support" class="btn-primary w-full"><LifeBuoy class="size-4" />{t('Ask WeTano')}</a>
          <p class="mt-3 text-[11px] text-muted">{t('Payment is arranged with WeTano directly; there is no card on file.')}</p>
        </div>
      </div>

      <div class="card overflow-hidden">
        <div class="border-b border-line px-4 py-3"><p class="text-sm font-bold">{t('Invoices')}</p></div>
        {invoices.length === 0 ? (
          <p class="px-4 py-8 text-center text-sm text-muted">{t('No invoices yet.')}</p>
        ) : (
          <>
            <div class="hidden overflow-x-auto lg:block">
            <table class="w-full text-sm">
              <thead class="bg-subtle text-left text-xs font-semibold text-muted">
                <tr><th class="px-4 py-2.5">{t('Number')}</th><th class="px-4 py-2.5">{t('Period')}</th><th class="px-4 py-2.5">{t('Plan')}</th><th class="px-4 py-2.5 text-right">{t('Amount')}</th><th class="px-4 py-2.5">{t('Status')}</th><th class="px-4 py-2.5">{t('Due')}</th><th class="px-4 py-2.5 text-right"><span class="sr-only">{t('Download')}</span></th></tr>
              </thead>
              <tbody class="divide-y divide-line">
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td class="px-4 py-3 font-mono text-xs">{i.number}</td>
                    <td class="px-4 py-3 text-xs">{new Date(i.period_start).toLocaleDateString()} → {new Date(i.period_end).toLocaleDateString()}</td>
                    <td class="px-4 py-3">{i.plan_name}</td>
                    <td class="px-4 py-3 text-right tabular-nums">{money(i.amount + i.tax, i.currency)}</td>
                    <td class="px-4 py-3"><span class={`pill ${INVOICE_TONE[i.status]}`}>{t(i.status)}</span></td>
                    <td class="px-4 py-3 text-xs tabular-nums">{new Date(i.due_on).toLocaleDateString()}</td>
                    <td class="px-4 py-3 text-right">
                      <button class="btn-secondary px-3" disabled={pdfBusy === i.id} onClick={() => void downloadInvoice(i)} aria-label={`${t('Download')} ${i.number}`}>
                        {pdfBusy === i.id ? <Spinner /> : <Download class="size-4" />}<span class="hidden lg:inline">{t('Download')}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <ul class="divide-y divide-line lg:hidden">
              {invoices.map((i) => (
                <li key={i.id} class="flex items-center gap-3 px-4 py-3">
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-semibold">{i.plan_name} · {money(i.amount + i.tax, i.currency)}</span>
                    <span class="block truncate text-xs text-muted">{i.number} · {t('due')} {new Date(i.due_on).toLocaleDateString()}</span>
                  </span>
                  <span class={`pill ${INVOICE_TONE[i.status]}`}>{t(i.status)}</span>
                  <button class="btn-secondary shrink-0 px-3" disabled={pdfBusy === i.id} onClick={() => void downloadInvoice(i)} aria-label={`${t('Download')} ${i.number}`}>
                    {pdfBusy === i.id ? <Spinner /> : <Download class="size-4" />}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

const INVOICE_TONE: Record<Invoice['status'], string> = {
  draft: 'bg-subtle text-muted',
  sent: 'bg-subtle text-muted',
  paid: 'bg-brand-100 text-brand-800',
  overdue: 'bg-red-100 text-red-700',
  cancelled: 'bg-subtle text-muted',
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div class="rounded-xl bg-subtle px-3 py-2">
      <dt class="text-[11px] text-muted">{label}</dt>
      <dd class="title text-lg font-bold tabular-nums">{value}</dd>
    </div>
  );
}

/** Minor units → “€99.00”. */
function money(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

// ------------------------------------------------------------------ Events
const blankEvent = (): Omit<EventItem, 'company_id' | 'id'> & { id?: string } =>
  ({ name: '', starts_on: '', ends_on: '', venue: '', booth: '', status: 'open', description: '', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, template_id: null, attachments: [] });

function EventsTab() {
  const cfg = useStore(config);
  const [sel, setSel] = useState<(Omit<EventItem, 'company_id' | 'id'> & { id?: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<FieldTemplate[]>([]);
  const [uploading, setUploading] = useState(false);
  useEffect(() => { void backend().then((b) => b.templates()).then(setTemplates).catch(() => {}); }, []);

  async function attach(file: File | undefined) {
    if (!file || !sel?.id) return;
    setUploading(true);
    try {
      const ev = await (await backend()).uploadAttachment(sel.id, file);
      setSel(ev);
      await pullConfig();
      toast(t('{name} attached', { name: file.name }), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setUploading(false); }
  }

  async function detach(attId: string) {
    if (!sel?.id) return;
    const ev = await (await backend()).deleteAttachment(sel.id, attId);
    setSel(ev);
    await pullConfig();
  }

  async function save() {
    if (!sel) return;
    if (!sel.name.trim() || !sel.starts_on || !sel.ends_on) { toast(t('Name and dates are required.'), 'error'); return; }
    if (sel.ends_on < sel.starts_on) { toast(t('The end date is before the start date.'), 'error'); return; }
    setBusy(true);
    try {
      const saved = await (await backend()).saveEvent(sel);
      await pullConfig();
      setSel(saved);
      toast(t('Event saved'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  return (
    <div class="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div class="card overflow-hidden">
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          <p class="text-sm font-bold">{tn(cfg.events.length, '{n} event', '{n} events')}</p>
          <button class="btn-secondary px-3" onClick={() => setSel(blankEvent())}><Plus class="size-4" />{t('Add')}</button>
        </div>
        <ul class="divide-y divide-line">
          {cfg.events.map((e) => (
            <li key={e.id}>
              <button class={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-subtle ${sel?.id === e.id ? 'bg-brand-50/60' : ''}`} onClick={() => setSel(e)}>
                <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-ocean-50 text-ocean-700"><CalendarDays class="size-5" /></span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-semibold">{e.name}</span>
                  <span class="flex items-center gap-1 truncate text-xs text-muted"><MapPin class="size-3" />{e.venue} · {e.booth} · {e.starts_on} → {e.ends_on}</span>
                </span>
                {e.attachments.length > 0 && <span class="pill bg-subtle text-muted"><Paperclip class="size-3" />{e.attachments.length}</span>}
                <span class={`pill ${e.status === 'open' ? 'bg-brand-100 text-brand-800' : 'bg-subtle text-muted'}`}>{e.status === 'open' ? t('Open') : t('Closed')}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div class="card h-fit p-4">
        {!sel ? <p class="py-8 text-center text-sm text-muted">{t('Select an event or add a new one.')}</p> : (
          <div class="space-y-3">
            <p class="text-sm font-bold">{sel.id ? t('Edit event') : t('New event')}</p>
            <Field label={t('Name')} for="ev-name"><input id="ev-name" class="input" value={sel.name} onInput={(e) => setSel({ ...sel, name: e.currentTarget.value })} /></Field>
            <div class="grid grid-cols-2 gap-2">
              <Field label={t('Starts')} for="ev-s"><input id="ev-s" type="date" class="input" value={sel.starts_on} onChange={(e) => setSel({ ...sel, starts_on: e.currentTarget.value })} /></Field>
              <Field label={t('Ends')} for="ev-e"><input id="ev-e" type="date" class="input" value={sel.ends_on} onChange={(e) => setSel({ ...sel, ends_on: e.currentTarget.value })} /></Field>
            </div>
            <Field label={t('Venue')} for="ev-v"><input id="ev-v" class="input" value={sel.venue} onInput={(e) => setSel({ ...sel, venue: e.currentTarget.value })} /></Field>
            <Field label={t('Booth')} for="ev-b"><input id="ev-b" class="input" value={sel.booth} onInput={(e) => setSel({ ...sel, booth: e.currentTarget.value })} /></Field>
            <Field label={t('Time zone')} for="ev-tz" hint={t('The local time at the venue — used for this event\u2019s counters and exports.')}>
              <select id="ev-tz" class="input" value={sel.time_zone} onChange={(e) => setSel({ ...sel, time_zone: e.currentTarget.value })}>
                {TIME_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </Field>
            <Field label={t('Description / notes')} for="ev-desc" hint={t('Shown to staff on the scan screen — what to ask, what to hand out.')}>
              <textarea id="ev-desc" rows={3} class="input" value={sel.description} onInput={(e) => setSel({ ...sel, description: e.currentTarget.value })} />
            </Field>
            <Field label={t('Card fields template')} for="ev-tpl" hint={t('Which set of fields staff fill in at this event.')}>
              <select id="ev-tpl" class="input" value={sel.template_id ?? ''} onChange={(e) => setSel({ ...sel, template_id: e.currentTarget.value || null })}>
                <option value="">{t('Company default')}</option>
                {templates.map((x) => <option key={x.id} value={x.id}>{x.name}{x.is_default ? ` (${t('default')})` : ''}</option>)}
              </select>
            </Field>

            <div>
              <span class="label"><Paperclip class="mr-1 inline size-3.5" />{t('Attachments')}</span>
              {!sel.id ? (
                <p class="text-xs text-muted">{t('Save the event first, then add price lists, floor plans or brochures.')}</p>
              ) : (
                <div class="space-y-1.5">
                  {sel.attachments.map((a) => (
                    <div key={a.id} class="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                      <FileText class="size-4 shrink-0 text-ocean-700" />
                      <a href={a.url} download={a.name} target="_blank" rel="noreferrer" class="min-w-0 flex-1 truncate text-sm font-medium hover:underline">{a.name}</a>
                      <span class="shrink-0 text-[11px] text-muted">{(a.size / 1024).toFixed(0)} KB</span>
                      <button class="rounded p-1 text-slate-400 hover:bg-subtle hover:text-red-700" onClick={() => void detach(a.id)} aria-label={t('Remove')}><X class="size-4" /></button>
                    </div>
                  ))}
                  <label class="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line px-3 text-sm font-semibold text-ocean-700 hover:border-ocean-500">
                    {uploading ? <Spinner class="size-4" /> : <Plus class="size-4" />}{t('Add a file')}
                    <input type="file" class="hidden" onChange={(e) => { void attach(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
                  </label>
                  <p class="text-[11px] text-muted">{t('Price lists, floor plans, brochures — up to 10 MB each.')}</p>
                </div>
              )}
            </div>
            <label class="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" class="size-4 accent-brand-700" checked={sel.status === 'closed'} onChange={(e) => setSel({ ...sel, status: e.currentTarget.checked ? 'closed' : 'open' })} />
              {t('Event is closed (staff can no longer pick it)')}
            </label>
            <button class="btn-primary w-full" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : t('Save')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Card fields
const TYPES: { id: FieldType; label: string }[] = [
  { id: 'text', label: 'Text' }, { id: 'email', label: 'Email' }, { id: 'phone', label: 'Phone' },
  { id: 'link', label: 'Link' }, { id: 'choice', label: 'Choice' }, { id: 'longtext', label: 'Long text' },
];
type FieldDraft = Omit<FieldDefinition, 'company_id' | 'id'> & { id?: string };

function FieldsTab() {
  const cfg = useStore(config);
  const [templates, setTemplates] = useState<FieldTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>('');
  const [tplDialog, setTplDialog] = useState<null | { id?: string; name: string; description: string; is_default: boolean; copy_from?: string }>(null);
  const [list, setList] = useState<FieldDefinition[]>([]);
  const [sel, setSel] = useState<FieldDraft | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const loadTemplates = async () => {
    const tpls = await (await backend()).templates();
    setTemplates(tpls);
    setTemplateId((cur) => (cur && tpls.some((x) => x.id === cur) ? cur : tpls.find((x) => x.is_default)?.id ?? tpls[0]?.id ?? ''));
  };
  useEffect(() => { void loadTemplates().catch((e) => toast((e as Error).message, 'error')); }, []);
  useEffect(() => {
    if (!templateId) return;
    setSel(null);
    void backend().then((b) => b.templateFields(templateId)).then(setList).catch(() => {});
  }, [templateId, cfg.fields]);

  async function saveTemplate() {
    if (!tplDialog) return;
    if (!tplDialog.name.trim()) { toast(t('The template needs a name.'), 'error'); return; }
    try {
      const saved = await (await backend()).saveTemplate(tplDialog);
      await loadTemplates();
      setTemplateId(saved.id);
      setTplDialog(null);
      await pullConfig();
      toast(t('Template saved'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  async function deleteTemplate() {
    try {
      await (await backend()).deleteTemplate(templateId);
      await loadTemplates();
      await pullConfig();
      toast(t('Template removed'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  const current = templates.find((x) => x.id === templateId);

  async function persistOrder(next: FieldDefinition[]) {
    setList(next);
    try { await (await backend()).reorderFields(next.map((f) => f.id)); await pullConfig(); } catch (e) { toast((e as Error).message, 'error'); }
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= list.length || from === to) return;
    const next = [...list];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    void persistOrder(next);
  };

  async function save() {
    if (!sel) return;
    if (!sel.label.trim()) { toast(t('The field needs a label.'), 'error'); return; }
    if (sel.type === 'choice' && sel.options.filter(Boolean).length < 2) { toast(t('A choice field needs at least two options.'), 'error'); return; }
    setBusy(true);
    try {
      const saved = await (await backend()).saveField({ ...sel, template_id: templateId, options: sel.options.map((o) => o.trim()).filter(Boolean) });
      setList(await (await backend()).templateFields(templateId));
      await pullConfig();
      setSel(saved);
      toast(t('Field saved — used by the AI on the very next scan'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }
  async function remove() {
    if (!sel?.id) return;
    await (await backend()).deleteField(sel.id);
    setList(await (await backend()).templateFields(templateId));
    await pullConfig();
    setSel(null); setConfirmDel(false);
    toast(t('Field removed'), 'success');
  }

  return (
    <div class="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div class="lg:col-span-2">
        <div class="mb-2 flex items-baseline justify-between">
          <span class="label">{t('Templates')}</span>
          <button class="tap mb-1 text-xs font-semibold text-ocean-700 hover:underline" onClick={() => setTplDialog({ name: '', description: '', is_default: false, copy_from: templateId })}>
            <Plus class="mr-0.5 inline size-3.5" />{t('New template')}
          </button>
        </div>
        <div class="flex flex-wrap gap-2">
          {templates.map((x) => (
            <button key={x.id} onClick={() => setTemplateId(x.id)} aria-pressed={x.id === templateId}
              class={`chip ${x.id === templateId ? 'border-brand-600 bg-brand-100 text-brand-700' : 'border-line bg-surface text-muted hover:border-ocean-500'}`}>
              {x.is_default && <Star class="size-3.5 fill-current" />}
              {x.name}
              <span class="text-[11px] opacity-70">{x.field_count}</span>
            </button>
          ))}
        </div>
        {current && (
          <div class="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
            <span class="min-w-0 flex-1 truncate">{current.description || t('No description')}</span>
            <button class="tap font-semibold text-ocean-700 hover:underline" onClick={() => setTplDialog({ id: current.id, name: current.name, description: current.description, is_default: current.is_default })}>{t('Rename')}</button>
            <button class="tap font-semibold text-ocean-700 hover:underline" onClick={() => setTplDialog({ name: `${current.name} (copy)`, description: current.description, is_default: false, copy_from: current.id })}><Copy class="mr-0.5 inline size-3" />{t('Duplicate')}</button>
            {!current.is_default && <button class="font-semibold text-ocean-700 hover:underline" onClick={() => void (async () => { await (await backend()).saveTemplate({ id: current.id, name: current.name, description: current.description, is_default: true }); await loadTemplates(); await pullConfig(); toast(t('{name} is now the default', { name: current.name }), 'success'); })()}>{t('Make default')}</button>}
            {!current.is_default && <button class="font-semibold text-red-700 hover:underline" onClick={() => void deleteTemplate()}>{t('Delete')}</button>}
          </div>
        )}
      </div>

      <div class="card overflow-hidden">
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          <p class="text-sm font-bold">{tn(list.length, '{n} field · drag to reorder', '{n} fields · drag to reorder')}</p>
          <button class="btn-secondary px-3" onClick={() => setSel({ key: '', label: '', type: 'text', options: [], required: false, ai_hint: '', filled_by: 'ai', sort_order: list.length, template_id: templateId })}><Plus class="size-4" />{t('Add')}</button>
        </div>
        <ul class="divide-y divide-line">
          {list.map((f, i) => (
            <li key={f.id} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); }}
              class={`flex items-center gap-2 px-2 py-2 ${sel?.id === f.id ? 'bg-brand-50/60' : ''} ${drag === i ? 'opacity-50' : ''}`}>
              <GripVertical class="size-4 shrink-0 cursor-grab text-slate-300" />
              <button class="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1 text-left hover:bg-subtle" onClick={() => setSel(f)}>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-semibold">{f.label}{f.required && <span class="text-red-700"> *</span>}</span>
                  <span class="text-xs text-muted">{t(TYPES.find((x) => x.id === f.type)!.label)} · {f.filled_by === 'ai' ? t('Filled by AI') : t('Filled by staff')}</span>
                </span>
              </button>
              <span class="flex">
                <button class="flex size-11 items-center justify-center rounded-lg text-slate-400 hover:bg-subtle disabled:opacity-30" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={t('Move up')}><ChevronUp class="size-4" /></button>
                <button class="flex size-11 items-center justify-center rounded-lg text-slate-400 hover:bg-subtle disabled:opacity-30" disabled={i === list.length - 1} onClick={() => move(i, i + 1)} aria-label={t('Move down')}><ChevronDown class="size-4" /></button>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div class="card h-fit p-4">
        {!sel ? <p class="py-8 text-center text-sm text-muted">{t('Select a field to edit, or add a new one.')}</p> : (
          <div class="space-y-3">
            <p class="text-sm font-bold">{sel.id ? t('Edit field') : t('New field')}</p>
            <Field label={t('Label')} for="fd-label" hint={sel.key ? t('Key: {key}', { key: sel.key }) : undefined}>
              <input id="fd-label" class="input" value={sel.label} onInput={(e) => setSel({ ...sel, label: e.currentTarget.value })} />
            </Field>
            <Field label={t('Type')} for="fd-type">
              <select id="fd-type" class="input" value={sel.type} onChange={(e) => setSel({ ...sel, type: e.currentTarget.value as FieldType })}>
                {TYPES.map((x) => <option key={x.id} value={x.id}>{t(x.label)}</option>)}
              </select>
            </Field>
            {sel.type === 'choice' && (
              <Field label={t('Options (one per line)')} for="fd-opt">
                <textarea id="fd-opt" rows={4} class="input" value={sel.options.join('\n')} onInput={(e) => setSel({ ...sel, options: e.currentTarget.value.split('\n') })} />
              </Field>
            )}
            <div>
              <span class="label">{t('Who fills it')}</span>
              <div class="grid grid-cols-2 gap-2">
                {(['ai', 'staff'] as const).map((w) => (
                  <button key={w} type="button" aria-pressed={sel.filled_by === w} onClick={() => setSel({ ...sel, filled_by: w })}
                    class={`chip justify-center ${sel.filled_by === w ? 'border-brand-600 bg-brand-100 text-brand-700' : 'border-line bg-surface'}`}>{w === 'ai' ? t('AI reads it') : t('Staff fills it')}</button>
                ))}
              </div>
            </div>
            {sel.filled_by === 'ai' && (
              <Field label={t('Hint for the AI (optional)')} for="fd-hint" hint={t('For example: “Prefer the mobile number if there are several”.')}>
                <input id="fd-hint" class="input" value={sel.ai_hint} onInput={(e) => setSel({ ...sel, ai_hint: e.currentTarget.value })} />
              </Field>
            )}
            <label class="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" class="size-4 accent-brand-700" checked={sel.required} onChange={(e) => setSel({ ...sel, required: e.currentTarget.checked })} />
              {t('Required before saving')}
            </label>
            <div class="flex gap-2 pt-1">
              {sel.id && <button class="btn-danger px-3" onClick={() => setConfirmDel(true)} aria-label={t('Remove')}><Trash2 class="size-4" /></button>}
              <button class="btn-primary flex-1" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : t('Save')}</button>
            </div>
          </div>
        )}
      </div>
      <Dialog open={!!tplDialog} onClose={() => setTplDialog(null)} title={tplDialog?.id ? t('Edit template') : t('New template')}
        footer={<><button class="btn-ghost" onClick={() => setTplDialog(null)}>{t('Cancel')}</button><button class="btn-primary" onClick={() => void saveTemplate()}>{t('Save')}</button></>}>
        {tplDialog && (
          <div class="space-y-3">
            <Field label={t('Name')} for="tpl-name"><input id="tpl-name" class="input" value={tplDialog.name} onInput={(e) => setTplDialog({ ...tplDialog, name: e.currentTarget.value })} /></Field>
            <Field label={t('Description')} for="tpl-desc"><input id="tpl-desc" class="input" value={tplDialog.description} onInput={(e) => setTplDialog({ ...tplDialog, description: e.currentTarget.value })} /></Field>
            <label class="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" class="size-4 accent-brand-700" checked={tplDialog.is_default} onChange={(e) => setTplDialog({ ...tplDialog, is_default: e.currentTarget.checked })} />
              {t('Use this template when an event does not choose one')}
            </label>
            {tplDialog.copy_from && !tplDialog.id && <p class="text-xs text-muted">{t('The fields of the current template are copied in, ready to adjust.')}</p>}
          </div>
        )}
      </Dialog>

      <Dialog open={confirmDel} onClose={() => setConfirmDel(false)} title={t('Remove this field?')}
        footer={<><button class="btn-ghost" onClick={() => setConfirmDel(false)}>{t('Cancel')}</button><button class="btn bg-red-600 text-white" onClick={() => void remove()}>{t('Remove')}</button></>}>
        <p class="text-sm text-muted">{t('New scans will no longer ask for “{label}”. Values already captured stay on existing leads.', { label: sel?.label ?? '' })}</p>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ Tags
const TAG_COLOURS: TagColour[] = ['green', 'blue', 'amber', 'red', 'purple', 'slate'];

function TagsTab() {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [sel, setSel] = useState<(Omit<Tag, 'company_id' | 'id'> & { id?: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => backend().then((b) => b.tags()).then(setTags).catch((e) => toast((e as Error).message, 'error'));
  useEffect(() => { void load(); }, []);

  async function save() {
    if (!sel?.name.trim()) { toast(t('The tag needs a name.'), 'error'); return; }
    setBusy(true);
    try {
      await (await backend()).saveTag(sel);
      await load();
      setSel(null);
      toast(t('Tag saved'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  return (
    <div class="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div class="card overflow-hidden">
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          <p class="text-sm font-bold">{tn(tags?.length ?? 0, '{n} tag', '{n} tags')}</p>
          <button class="btn-secondary px-3" onClick={() => setSel({ name: '', colour: 'green' })}><Plus class="size-4" />{t('Add')}</button>
        </div>
        {!tags ? <div class="flex justify-center py-10"><Spinner class="size-5 text-brand-700" /></div> : tags.length === 0 ? (
          <p class="px-4 py-8 text-center text-sm text-muted">{t('Tags group leads — “Distributor”, “Wants a demo”, “Press”. Staff pick them while scanning.')}</p>
        ) : (
          <ul class="divide-y divide-line">
            {tags.map((g) => (
              <li key={g.id} class="flex items-center gap-3 px-4 py-2.5">
                <span class={`size-3 rounded-full ${TAG_META[g.colour].dot}`} />
                <span class="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
                <button class="btn-ghost min-w-11 px-2" onClick={() => setSel(g)} aria-label={t('Edit')}><TagIcon class="size-4" /></button>
                <button class="btn-ghost min-w-11 px-2 text-red-700" onClick={() => void (async () => { await (await backend()).deleteTag(g.id); await load(); })()} aria-label={t('Remove')}><Trash2 class="size-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div class="card h-fit p-4">
        {!sel ? <p class="py-8 text-center text-sm text-muted">{t('Select a tag or add a new one.')}</p> : (
          <div class="space-y-3">
            <p class="text-sm font-bold">{sel.id ? t('Edit tag') : t('New tag')}</p>
            <Field label={t('Name')} for="tag-name"><input id="tag-name" class="input" value={sel.name} onInput={(e) => setSel({ ...sel, name: e.currentTarget.value })} /></Field>
            <div>
              <span class="label">{t('Colour')}</span>
              <div class="flex flex-wrap gap-2">
                {TAG_COLOURS.map((c) => (
                  <button key={c} type="button" aria-pressed={sel.colour === c} onClick={() => setSel({ ...sel, colour: c })}
                    class={`chip capitalize ${sel.colour === c ? TAG_META[c].chip : 'border-line bg-surface text-muted'}`}>
                    <span class={`size-2 rounded-full ${TAG_META[c].dot}`} />{c}
                  </button>
                ))}
              </div>
            </div>
            <button class="btn-primary w-full" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : t('Save')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ CRM
function CrmTab() {
  const cfg = useStore(config);
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [allowed, setAllowed] = useState<ConnectorKind[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [hook, setHook] = useState<string | null>(null);
  const load = async () => {
    try {
      const b = await backend();
      const [c, a] = await Promise.all([b.connections(), b.allowedConnectors()]);
      setConns(c); setAllowed(a);
    } catch (e) {
      setConns([]);
      setAllowed(['webhook', 'csv']);
      toast((e as Error).message, 'error');
    }
  };
  useEffect(() => { void load(); }, []);
  const conn = conns?.[0] ?? null;

  async function connect(kind: ConnectorKind, url?: string) {
    setBusy(kind);
    try {
      const c = await (await backend()).connect(kind, { webhook_url: url });
      setConns([c]);
      setHook(null);
      toast(t('{crm} connected', { crm: CONNECTOR_LABEL[kind] }), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  }

  if (!conns) return <div class="flex justify-center py-12"><Spinner class="size-6 text-brand-700" /></div>;

  return (
    <div class="space-y-5">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {CONNECTOR_ORDER.map((k) => {
          const ok = allowed.includes(k);
          const on = conn?.kind === k;
          return (
            <div key={k} class={`card flex flex-col items-center gap-2 p-4 text-center ${on ? 'ring-2 ring-brand-500' : ''} ${ok ? '' : 'opacity-50'}`}>
              <span class={`flex size-10 items-center justify-center rounded-xl ${on ? 'bg-brand-100 text-brand-700' : 'bg-ocean-50 text-ocean-700'}`}>{k === 'webhook' ? <Link2 class="size-5" /> : <Plug class="size-5" />}</span>
              <p class="text-sm font-semibold">{CONNECTOR_LABEL[k]}</p>
              {k === 'csv' ? <span class="text-xs text-muted">{t('Always on — use Export')}</span>
                : on ? <span class="pill bg-brand-100 text-brand-800"><CheckCircle2 class="size-3.5" />{t('Connected')}</span>
                : <button class="btn-secondary w-full px-2 text-xs" disabled={!ok || !!busy} title={ok ? '' : t('Not included in your licence')}
                    onClick={() => (k === 'webhook' ? setHook('') : void connect(k))}>{busy === k ? <Spinner class="size-4" /> : t('Connect')}</button>}
            </div>
          );
        })}
      </div>
      <p class="text-xs text-muted">{t('You sign in to your CRM to connect it — no API keys. One CRM per company. Zoho data centres (.com, .eu, .in, .com.au) are detected automatically.')}</p>

      {conn && <ConnectionEditor key={conn.id} conn={conn} fieldDefs={cfg.fields} onChange={(c) => setConns([c])} onDisconnect={() => setConns([])} />}

      <Dialog open={hook !== null} onClose={() => setHook(null)} title={t('Connect a webhook')}
        footer={<>
          <button class="btn-ghost" onClick={() => setHook(null)}>{t('Cancel')}</button>
          <button
            class="btn-primary"
            disabled={!(hook ?? '').trim().length || !!busy}
            onClick={() => {
              const raw = (hook ?? '').trim();
              const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
              void connect('webhook', url);
            }}
          >
            {busy === 'webhook' ? <Spinner class="size-4" /> : t('Connect')}
          </button>
        </>}>
        <Field label={t('Webhook URL')} for="hook" hint={t('Paste your webhook URL (e.g. from webhook.site, Zapier, Make, n8n, etc.)')}>
          <input
            id="hook"
            class="input"
            placeholder="https://webhook.site/…"
            value={hook ?? ''}
            onInput={(e) => setHook(e.currentTarget.value)}
            autoFocus
          />
        </Field>
      </Dialog>
    </div>
  );
}

function ConnectionEditor({ conn, fieldDefs, onChange, onDisconnect }: { conn: Connection; fieldDefs: FieldDefinition[]; onChange: (c: Connection) => void; onDisconnect: () => void }) {
  const [c, setC] = useState(conn);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function save() {
    setBusy('save');
    try { await (await backend()).saveConnection(c); onChange(c); toast(t('CRM settings saved'), 'success'); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  }
  async function sendTest() {
    setBusy('test'); setTest(null);
    try { setTest(await (await backend()).sendTestLead(c.id)); } finally { setBusy(null); }
  }
  async function disconnect() {
    await (await backend()).disconnect(c.id);
    setConfirm(false); onDisconnect();
    toast(t('Disconnected'), 'success');
  }

  return (
    <div class="card overflow-hidden">
      <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <p class="text-sm font-bold">{CONNECTOR_LABEL[c.kind]}</p>
        <span class="text-xs text-muted">{c.account_label}</span>
        <button class="btn-ghost ml-auto px-2 text-xs text-red-700" onClick={() => setConfirm(true)}><Unplug class="size-4" />{t('Disconnect')}</button>
      </div>
      <div class="grid gap-5 p-4 lg:grid-cols-[280px_1fr]">
        <div class="space-y-4">
          <Field label={t('Record type')} for="rt">
            <select id="rt" class="input" value={c.record_type} onChange={(e) => setC({ ...c, record_type: e.currentTarget.value })}>
              {(c.kind === 'hubspot' ? ['Contacts'] : c.kind === 'webhook' ? ['JSON'] : c.kind === 'zoho_bigin' ? ['Contacts'] : ['Leads', 'Contacts']).map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
          <div>
            <span class="label">{t('When to send')}</span>
            <div class="space-y-2">
              {(['auto', 'manual'] as const).map((m) => (
                <label key={m} class={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm ${c.mode === m ? 'border-brand-600 bg-brand-50' : 'border-line'}`}>
                  <input type="radio" name="mode" class="mt-0.5 accent-brand-700" checked={c.mode === m} onChange={() => setC({ ...c, mode: m })} />
                  <span><span class="block font-semibold">{m === 'auto' ? t('Automatically after sync') : t('Manually')}</span>
                    <span class="text-xs text-muted">{m === 'auto' ? t('Recommended. Failed pushes retry after 1 min, 5 min, 30 min, 2 h and 12 h.') : t('Admins send leads from the Leads screen.')}</span></span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div>
          <span class="label">{t('Field matching')}</span>
          <div class="overflow-hidden rounded-xl border border-line">
            <table class="w-full text-sm">
              <thead class="bg-subtle text-left text-xs text-muted"><tr><th class="px-3 py-2">{t('WeTa Snap field')}</th><th class="px-3 py-2">{t('{crm} field', { crm: CONNECTOR_LABEL[c.kind] })}</th></tr></thead>
              <tbody class="divide-y divide-line">
                {fieldDefs.map((f) => (
                  <tr key={f.key}>
                    <td class="px-3 py-1.5 font-medium">{f.label}</td>
                    <td class="px-3 py-1.5"><input class="input min-h-9 font-mono text-xs" placeholder={t('Not sent')} value={c.mapping[f.key] ?? ''} onInput={(e) => setC({ ...c, mapping: { ...c.mapping, [f.key]: e.currentTarget.value } })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {test && <p class={`mx-4 mb-3 rounded-xl px-3 py-2 text-sm ${test.ok ? 'bg-brand-50 text-brand-800' : 'bg-red-50 text-red-800'}`}>{test.message}</p>}
      <div class="flex gap-2 border-t border-line px-4 py-3">
        <button class="btn-secondary" disabled={!!busy} onClick={() => void sendTest()}>{busy === 'test' ? <Spinner class="size-4" /> : <Send class="size-4" />}{t('Send test lead')}</button>
        <button class="btn-primary ml-auto min-w-28" disabled={!!busy} onClick={() => void save()}>{busy === 'save' ? <Spinner /> : t('Save')}</button>
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={t('Disconnect {crm}?', { crm: CONNECTOR_LABEL[c.kind] })}
        footer={<><button class="btn-ghost" onClick={() => setConfirm(false)}>{t('Cancel')}</button><button class="btn bg-red-600 text-white" onClick={() => void disconnect()}>{t('Disconnect')}</button></>}>
        <p class="text-sm text-muted">{t('New leads will stay in WeTa Snap and will not be sent until a CRM is connected again.')}</p>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ Company
function CompanyTab() {
  const s = useStore(session)!;
  const [c, setC] = useState<Company | null>(null);
  const [busy, setBusy] = useState(false);
  const coFuTextareaRef = useRef<HTMLTextAreaElement>(null);
  const coFuSelectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  const recordCoSelection = (el: HTMLTextAreaElement) => {
    coFuSelectionRef.current = {
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.value.length,
    };
  };

  const insertCoTagAtCursor = (tag: string) => {
    const el = coFuTextareaRef.current;
    const currentMsg = c?.follow_up_message ?? DEFAULT_FOLLOWUP_MESSAGE;
    let start = coFuSelectionRef.current.start;
    let end = coFuSelectionRef.current.end;

    if (el && typeof el.selectionStart === 'number') {
      start = el.selectionStart;
      end = el.selectionEnd;
    }

    start = Math.max(0, Math.min(start, currentMsg.length));
    end = Math.max(start, Math.min(end, currentMsg.length));

    const before = currentMsg.slice(0, start);
    const after = currentMsg.slice(end);
    const updated = `${before}${tag}${after}`;

    if (c) setC({ ...c, follow_up_message: updated });

    const nextPos = start + tag.length;
    coFuSelectionRef.current = { start: nextPos, end: nextPos };

    setTimeout(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(nextPos, nextPos);
      }
    }, 0);
  };

  useEffect(() => { backend().then((b) => b.company()).then(setC).catch(() => {}); }, []);
  if (!c) return <div class="flex justify-center py-12"><Spinner class="size-6 text-brand-700" /></div>;

  async function save() {
    if (!c) return;
    setBusy(true);
    try {
      // Only the company's own settings — suspension and the scan-limit rule belong to WeTano (D-6).
      const { name, logo_url, country, headquarters, default_language, time_zone, consent_text,
        retention_leads_months, retention_photos_months, cloud_ai_enabled, offline_pack_enabled,
        follow_up_message, follow_up_auto } = c;
      const saved = await (await backend()).saveCompany({ name, logo_url, country, headquarters, default_language, time_zone, consent_text,
        retention_leads_months, retention_photos_months, cloud_ai_enabled, offline_pack_enabled,
        follow_up_message, follow_up_auto });
      setC(saved);
      if (saved.id) {
        saveFollowUpConfig(s.person.id, {
          autoSend: Boolean(saved.follow_up_auto),
          sendWhatsApp: true,
          sendEmail: true,
          message: saved.follow_up_message || DEFAULT_FOLLOWUP_MESSAGE,
        }, saved.id);
      }
      await refreshSession();
      toast(saved.consent_version !== s.company?.consent_version ? t('Saved — consent text is now version {v}', { v: saved.consent_version }) : t('Company settings saved'), 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  }

  function onLogo(file: File | undefined) {
    if (!file) return;
    if (file.size > 200 * 1024) { toast(t('Please use a logo under 200 KB (SVG or PNG).'), 'error'); return; }
    const r = new FileReader();
    r.onload = () => setC({ ...c!, logo_url: r.result as string });
    r.readAsDataURL(file);
  }

  const Switch = ({ on, set, label, hint }: { on: boolean; set: (v: boolean) => void; label: string; hint: string }) => (
    <label class="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-line p-3">
      <span><span class="block text-sm font-semibold">{label}</span><span class="text-xs text-muted">{hint}</span></span>
      <input type="checkbox" role="switch" class="peer sr-only" checked={on} onChange={(e) => set(e.currentTarget.checked)} />
      <span class={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-brand-600' : 'bg-slate-200'}`}><span class={`absolute top-0.5 size-5 rounded-full bg-white shadow transition ${on ? 'left-5.5' : 'left-0.5'}`} /></span>
    </label>
  );

  return (
    <div class="grid gap-4 lg:grid-cols-2">
      <div class="card space-y-4 p-4">
        <Field label={t('Company name')} for="co-name"><input id="co-name" class="input" value={c.name} onInput={(e) => setC({ ...c, name: e.currentTarget.value })} /></Field>
        <div>
          <span class="label">{t('Logo')}</span>
          <div class="flex items-center gap-3">
            <span class="flex size-14 items-center justify-center overflow-hidden rounded-xl border border-line bg-subtle">{c.logo_url ? <img src={c.logo_url} alt="" class="size-full object-contain" /> : <span class="text-xs text-muted">—</span>}</span>
            <label class="btn-secondary cursor-pointer">{t('Upload logo')}<input type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" class="hidden" onChange={(e) => onLogo(e.currentTarget.files?.[0])} /></label>
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <Field label={t('Country')} for="co-country"><input id="co-country" class="input" value={c.country} onInput={(e) => setC({ ...c, country: e.currentTarget.value })} /></Field>
          <Field label={t('Default language')} for="co-lang" hint={t('Used for new people and for dictation.')}>
            <select id="co-lang" class="input" value={c.default_language} onChange={(e) => setC({ ...c, default_language: e.currentTarget.value })}>
              {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t('Headquarters')} for="co-hq" hint={t('Shown on exports and invoices.')}>
          <textarea id="co-hq" rows={2} class="input" value={c.headquarters} placeholder={t('Street, postcode, city, country')} onInput={(e) => setC({ ...c, headquarters: e.currentTarget.value })} />
        </Field>
        <Field label={t('Time zone')} for="co-tz" hint={t('Decides what counts as “today” in counters and exports.')}>
          <select id="co-tz" class="input" value={c.time_zone} onChange={(e) => setC({ ...c, time_zone: e.currentTarget.value })}>
            {TIME_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </Field>
        <Field label={t('Consent text')} for="co-consent" hint={t('Shown next to the consent checkbox. Each change creates a new version (currently v{v}); every lead stores the version it was given.', { v: c.consent_version })}>
          <textarea id="co-consent" rows={3} class="input" value={c.consent_text} onInput={(e) => setC({ ...c, consent_text: e.currentTarget.value })} />
        </Field>

        <div class="rounded-xl border border-line bg-subtle/50 p-3.5 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <span class="block text-sm font-bold text-ink">{t('Organization Follow-Up Message')}</span>
              <span class="text-xs text-muted leading-relaxed">
                {t('Template used by all team scanners to follow up with leads via WhatsApp and Email.')}
              </span>
            </div>
            <label class="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                role="switch"
                class="sr-only peer"
                checked={Boolean(c.follow_up_auto)}
                onChange={(e) => setC({ ...c, follow_up_auto: e.currentTarget.checked })}
              />
              <span class={`relative h-6 w-11 rounded-full transition-colors ${c.follow_up_auto ? 'bg-emerald-500' : 'bg-slate-200'}`}>
                <span class={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${c.follow_up_auto ? 'left-5.5' : 'left-0.5'}`} />
              </span>
            </label>
          </div>

          <Field label={t('Message Template')} for="co-fu-msg" hint={t('Placeholders: {name}, {company}, {lead_company}, {event}, {sender}')}>
            <textarea
              ref={coFuTextareaRef}
              id="co-fu-msg"
              rows={3}
              class="input text-xs leading-relaxed"
              placeholder={DEFAULT_FOLLOWUP_MESSAGE}
              value={c.follow_up_message ?? ''}
              onInput={(e) => {
                setC({ ...c, follow_up_message: e.currentTarget.value });
                recordCoSelection(e.currentTarget);
              }}
              onSelect={(e) => recordCoSelection(e.currentTarget)}
              onKeyUp={(e) => recordCoSelection(e.currentTarget)}
              onMouseUp={(e) => recordCoSelection(e.currentTarget)}
            />
            <div class="flex items-center gap-1.5 flex-wrap mt-2">
              <span class="text-[10px] text-muted">{t('Insert placeholder:')}</span>
              {['{name}', '{company}', '{lead_company}', '{event}', '{sender}'].map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertCoTagAtCursor(tag)}
                  class="px-2 py-0.5 rounded bg-subtle border border-line text-[10px] font-mono text-brand-700 hover:bg-brand-50 hover:border-brand-300 transition active:scale-95 cursor-pointer"
                  title={t('Insert {tag} at cursor position', { tag })}
                >
                  {tag}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </div>
      <div class="card space-y-4 p-4">
        <div class="grid grid-cols-2 gap-3">
          <Field label={t('Keep leads (months)')} for="co-rl"><input id="co-rl" type="number" min={1} max={120} class="input" value={c.retention_leads_months} onInput={(e) => setC({ ...c, retention_leads_months: Number(e.currentTarget.value) })} /></Field>
          <Field label={t('Keep card photos (months)')} for="co-rp"><input id="co-rp" type="number" min={1} max={120} class="input" value={c.retention_photos_months} onInput={(e) => setC({ ...c, retention_photos_months: Number(e.currentTarget.value) })} /></Field>
        </div>
        <Switch on={c.cloud_ai_enabled} set={(v) => setC({ ...c, cloud_ai_enabled: v })} label={t('Cloud AI card reading')}
          hint={t('Photos are read by AI in the EU under zero data retention. Switch off to use offline reading and typing only.')} />
        <Switch on={c.offline_pack_enabled} set={(v) => setC({ ...c, offline_pack_enabled: v })} label={t('Offline reading pack')}
          hint={t('Lets phones read name, company, email, phone and website without internet. Staff download it once (≈ 8 MB) on Wi-Fi.')} />
        <LocalOcrSetting />
        <GeminiOcrSetting />
        <button class="btn-primary w-full" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : t('Save')}</button>
      </div>
    </div>
  );
}

/** Where the company's own OCR service runs (Surya/Tesseract). Kept per device. */
function LocalOcrSetting() {
  const [url, setUrl] = useState(ocrUrl());
  const [state, setState] = useState<'idle' | 'checking' | 'ok' | 'bad' | 'no-engine'>('idle');
  const [health, setHealth] = useState<OcrHealth | null>(null);
  async function check() {
    setOcrUrl(url);
    setState('checking');
    const h = await ocrHealth(true);
    setHealth(h);
    setState(!h.ok ? 'bad' : h.engines.length ? 'ok' : 'no-engine');
  }
  return (
    <div class="rounded-xl border border-line p-3">
      <span class="label"><ScanLine class="mr-1 inline size-3.5" />{t('Local card reader (optional)')}</span>
      <p class="mb-2 text-xs text-muted">{t('If you run the WeTa Snap OCR service on your own machine, cards are read there first and the photo never leaves your network. Leave empty to use cloud reading.')}</p>
      <div class="flex gap-2">
        <input class="input" value={url} placeholder="http://192.168.1.20:8000" onInput={(e) => setUrl(e.currentTarget.value)} />
        <button class="btn-secondary shrink-0 px-3" onClick={() => void check()}>{state === 'checking' ? <Spinner class="size-4" /> : t('Test')}</button>
      </div>
      {state === 'ok' && <p class="mt-1 text-xs font-medium text-brand-800">{t('Connected ({engines}) — cards will be read on your own machine.', { engines: health?.engines.join(' + ') ?? '' })}</p>}
      {state === 'no-engine' && <p class="mt-1 text-xs font-medium text-amber-800">{t('The service answers but has no reader installed, so cards would still be read elsewhere. Install surya-ocr or Tesseract on that machine.')}</p>}
      {state === 'bad' && <p class="mt-1 text-xs font-medium text-red-700">{t('No answer. Check the address and that the service is running.')}</p>}
    </div>
  );
}

/** Google Gemini API key and model selection for online low-confidence OCR verification. */
function GeminiOcrSetting() {
  const [key, setKey] = useState(geminiApiKey());
  const [model, setModel] = useState<GeminiModelId>(geminiModel());
  const [state, setState] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [verifiedModel, setVerifiedModel] = useState('');

  async function check() {
    setGeminiApiKey(key);
    setGeminiModel(model);
    if (!key.trim()) {
      setState('idle');
      toast(t('Gemini verification disabled'), 'info');
      return;
    }
    setState('checking');
    const res = await testGeminiApiKey(key, model);
    if (res.ok) {
      setState('ok');
      setVerifiedModel(res.modelUsed || model);
      toast(t('Gemini AI connected successfully'), 'success');
    } else {
      setState('bad');
      setErrorMsg(res.error || t('Invalid API key'));
    }
  }

  function handleModelChange(newModel: GeminiModelId) {
    setModel(newModel);
    setGeminiModel(newModel);
    setState('idle');
  }

  return (
    <div class="rounded-xl border border-line p-3">
      <span class="label"><Sparkles class="mr-1 inline size-3.5 text-brand-600" />{t('Gemini AI verification (optional)')}</span>
      <p class="mb-2 text-xs text-muted">{t('When scanning online, automatically verifies and corrects business card fields whenever OCR confidence is low.')}</p>

      <div class="mb-2">
        <label class="text-[11px] font-semibold text-muted block mb-1">{t('Gemini Model')}</label>
        <select
          class="input text-xs h-9 py-1"
          value={model}
          onChange={(e) => handleModelChange(e.currentTarget.value as GeminiModelId)}
        >
          {GEMINI_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div class="flex gap-2">
        <input
          type="password"
          class="input text-sm"
          value={key}
          placeholder="AIzaSy..."
          onInput={(e) => { setKey(e.currentTarget.value); setState('idle'); }}
        />
        <button class="btn-secondary shrink-0 px-3 text-xs" onClick={() => void check()}>
          {state === 'checking' ? <Spinner class="size-4" /> : t('Test & Save')}
        </button>
      </div>
      {state === 'ok' && (
        <p class="mt-1 text-xs font-medium text-brand-700">
          {t('Connected ({model}) — Gemini AI will verify low-confidence scans when online.', { model: verifiedModel || model })}
        </p>
      )}
      {state === 'bad' && <p class="mt-1 text-xs font-medium text-red-600">{errorMsg || t('Connection failed. Please check the API key.')}</p>}
    </div>
  );
}
