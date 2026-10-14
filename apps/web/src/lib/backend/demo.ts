/**
 * DEMO backend — a mock server that lives in its own IndexedDB database in the browser.
 * It follows the same rules as the API backend (roles, seats, licences, idempotent sync,
 * AI never overwrites people, CRM retry) so the whole app can be clicked through with no setup.
 */
import Dexie, { type Table } from 'dexie';
import type {
  Backend, CompanyDetail, Counters, ImportRow, ImportResult, Invitation, LicenceChange, PersonRow, ReadResult, SignedIn,
} from './index';
import { DEFAULT_POLICY, checkPassword } from '../password';
import { buildDemoWorld } from './demoData';
import type {
  AppNotification, Attachment, Company, CompanySummary, Connection, ConnectorKind, CrmAttempt, DeviceSession,
  EventItem, FieldDefinition, FieldTemplate, FieldValue, ImportBatch, Invoice, Lead, LeadFilters, Licence,
  LoginEvent, Person, Plan, RecoveryCodes, Role, ScanLimitAction, SecurityPolicy, Subscription, SupportTicket, Tag,
  TicketStatus, UsageAlert, UsageRow,
} from '../types';
import { OfflineError, isOnline } from '../net';
import { applyFilters, leadsToCsv } from '../leads';
import { holdsSeat, licenceStatus } from '../licence';
import { isEmail } from '../validate';
import { nowIso, today, uuid } from '../id';
import { CONNECTOR_LABEL, defaultMapping } from '../connectors';

const label = (k: ConnectorKind) => CONNECTOR_LABEL[k];

interface Code { email: string; code: string; expires: number; attempts: number }
interface Photo { key: string; lead_id: string; blob: Blob }
interface Hist { id?: number; company_id: string; at: string; by: string; summary: string }
/** D-26: the actor's role is stored with each entry; signed-out actors are `system`. */
interface Audit { id?: number; at: string; actor: string; role?: Role | 'system'; company_id: string | null; action: string; detail: string }
/**
 * D-17: who a notification is for. Company notes default to the company's admins; staff only see
 * notes addressed to them by person, or ones marked for everyone. `dedupe_key` keeps "one per month" notes unique.
 */
type Audience = 'admins' | 'everyone';
interface Note extends AppNotification { audience?: Audience; dedupe_key?: string }
interface UsageEvent { id?: number; company_id: string; kind: string; at: string; overage?: boolean }
/** D-32: leads whose CRM pipeline was started but has not finished (a reload can interrupt it). */
interface Queued { lead_id: string; at: string }

class ServerDb extends Dexie {
  companies!: Table<Company, string>;
  licences!: Table<Licence, string>;
  history!: Table<Hist, number>;
  people!: Table<Person, string>;
  events!: Table<EventItem, string>;
  fields!: Table<FieldDefinition, string>;
  leads!: Table<Lead, string>;
  photos!: Table<Photo, string>;
  connections!: Table<Connection, string>;
  templates!: Table<FieldTemplate, string>;
  tags!: Table<Tag, string>;
  notes!: Table<Note, string>;
  plans!: Table<Plan, string>;
  subs!: Table<Subscription, string>;
  invoices!: Table<Invoice, string>;
  tickets!: Table<SupportTicket, string>;
  sessions!: Table<DeviceSession, string>;
  logins!: Table<LoginEvent, string>;
  policy!: Table<{ id: 'current' } & SecurityPolicy, string>;
  secrets!: Table<{ person_id: string; password: string; history: string[]; changed_at: string; mfa_secret: string | null; recovery: RecoveryCodes | null; failed: number; locked_until: string | null }, string>;
  imports!: Table<ImportBatch, string>;
  alerts!: Table<UsageAlert, string>;
  codes!: Table<Code, string>;
  audit!: Table<Audit, number>;
  usage!: Table<UsageEvent, number>;
  queue!: Table<Queued, string>;
  constructor() {
    super('wetasnap-demo-server-4');
    this.version(1).stores({
      companies: 'id', licences: 'id, company_id', history: '++id, company_id', people: 'id, &email, company_id',
      events: 'id, company_id', fields: 'id, company_id', leads: 'id, company_id, captured_by, event_id',
      photos: 'key, lead_id', connections: 'id, company_id', codes: 'email', audit: '++id, company_id', usage: '++id, company_id',
      templates: 'id, company_id', tags: 'id, company_id', notes: 'id, company_id, person_id',
      plans: 'id', subs: 'company_id', invoices: 'id, company_id, status', tickets: 'id, company_id, status',
      sessions: 'id, person_id', logins: 'id, email', policy: 'id', secrets: 'person_id',
      imports: 'id, company_id', alerts: 'id, company_id',
    });
    this.version(2).stores({ queue: 'lead_id' });
  }
}

const S = new ServerDb();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const DEMO_SUPER_PASSWORD = 'WetaSnap#2026';
/** Every demo account uses this password (it satisfies the default policy). */
export const DEMO_PASSWORD = 'WetaSnap#2026';

const recentErrors = new Map<string, number>();
/** Lead ids whose simulated CRM pipeline is running in this page (D-32). */
const running = new Set<string>();

/** Keep personal data out of stored error text. */
function scrub(s: string) {
  return (s ?? '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    // D-31: only phone-like strings — a leading +, or 9+ digits with optional spaces. Dates and short numbers stay.
    .replace(/\+\d[\d\s()-]{6,}\d/g, '[phone]')
    .replace(/\b\d(?: ?\d){8,}\b/g, '[phone]')
    .replace(/(eyJ[\w-]+\.[\w-]+\.[\w-]+)|(\b[a-f0-9]{32,}\b)/gi, '[token]');
}

/** Error reports are stored as JSON; everything else is a short note. */
function parseDetail(detail: string): Record<string, unknown> {
  if (detail.startsWith('{')) {
    try { return JSON.parse(detail) as Record<string, unknown>; } catch { /* fall through */ }
  }
  return detail ? { detail } : {};
}


function wrongDoorMessage(personRole: Person['role']) {
  return personRole === 'super_admin'
    ? 'WeTano accounts sign in at /super-admin.'
    : 'This is the WeTano Console. Your account signs in at the main address.';
}

/** localStorage is absent in tests and can throw in private windows. */
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  remove: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const blobToDataUrl = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

// ---------------------------------------------------------------- seed
const CO = 'c0000000-0000-4000-8000-000000000001';
const CO2 = 'c0000000-0000-4000-8000-000000000002';
const EV = 'e0000000-0000-4000-8000-000000000001';
const EV_OLD = 'e0000000-0000-4000-8000-000000000002';
const P = { super: 'p-super', admin: 'p-admin', anna: 'p-anna', ben: 'p-ben', temp: 'p-temp' };
const TPL = 't0000000-0000-4000-8000-000000000001';
const TPL_SHORT = 't0000000-0000-4000-8000-000000000002';
const TAG = { hot: 'g-hot', dist: 'g-dist', press: 'g-press', demo: 'g-demo' };
const PLAN = { growth: 'pl-growth', pro: 'pl-pro' };
const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const DEFAULT_FIELDS: [string, string, FieldDefinition['type'], boolean, string][] = [
  ['first_name', 'First name', 'text', true, ''],
  ['last_name', 'Last name', 'text', true, ''],
  ['company', 'Company', 'text', false, 'Legal company name, without the logo tagline'],
  ['job_title', 'Job title', 'text', false, ''],
  ['email', 'Email', 'email', false, ''],
  ['phone', 'Phone', 'phone', false, 'Prefer the mobile number if there are several'],
  ['website', 'Website', 'link', false, ''],
  ['country', 'Country', 'text', false, 'Infer from address or phone prefix'],
  ['product_interest', 'Product interest', 'choice', false, ''],
];

const SAMPLE_CARDS = [
  { first_name: 'Lukas', last_name: 'Schneider', company: 'Feldtechnik GmbH', job_title: 'Head of Procurement', email: 'l.schneider@feldtechnik.de', phone: '+49 151 23456789', website: 'https://feldtechnik.de', country: 'Germany' },
  { first_name: 'Camille', last_name: 'Dubois', company: 'AgriSol SAS', job_title: 'Directrice commerciale', email: 'camille.dubois@agrisol.fr', phone: '+33 6 12 34 56 78', website: 'https://agrisol.fr', country: 'France' },
  { first_name: 'Marco', last_name: 'Bianchi', company: 'Semi Verdi S.r.l.', job_title: 'Responsabile acquisti', email: 'm.bianchi@semiverdi.it', phone: '+39 347 123 4567', website: 'https://semiverdi.it', country: 'Italy' },
  { first_name: 'Lucía', last_name: 'Fernández', company: 'Cultivos Ibéricos SL', job_title: 'Export Manager', email: 'lucia@cultivosibericos.es', phone: '+34 612 34 56 78', website: 'https://cultivosibericos.es', country: 'Spain' },
  { first_name: 'Sanne', last_name: 'de Vries', company: 'GroenAgro B.V.', job_title: 'Inkoper', email: 'sanne.devries@groenagro.nl', phone: '+31 6 12345678', website: 'https://groenagro.nl', country: 'Netherlands' },
  { first_name: 'João', last_name: 'Pereira', company: 'TerraViva Lda', job_title: 'CEO', email: 'joao.pereira@terraviva.pt', phone: '+351 912 345 678', website: 'https://terraviva.pt', country: 'Portugal' },
  { first_name: 'Emily', last_name: 'Carter', company: 'Harvest Analytics Ltd', job_title: 'Product Lead', email: 'emily.carter@harvest-analytics.co.uk', phone: '+44 7700 900123', website: 'https://harvest-analytics.co.uk', country: 'United Kingdom' },
];

async function seed() {
  // Re-runnable: a database created by an older build gets the newer tables filled in.
  const [companies, tags, plans, secrets] = await Promise.all([S.companies.count(), S.tags.count(), S.plans.count(), S.secrets.count()]);
  if (companies > 2 && tags > 0 && plans > 0 && secrets > 5) return;
  const consent = 'I agree that Agro Expo Demo GmbH may contact me about its products. I can withdraw this at any time.';
  await S.companies.bulkPut([
    { id: CO, name: 'Agro Expo Demo GmbH', country: 'Germany', headquarters: 'Hansaallee 12, 30419 Hannover, Germany', default_language: 'en', time_zone: 'Europe/Berlin', suspended: false, suspended_reason: '', scan_limit_action: 'notify', logo_url: null, consent_text: consent, consent_version: 1, retention_leads_months: 24, retention_photos_months: 12, cloud_ai_enabled: true, offline_pack_enabled: false },
    { id: CO2, name: 'Nordic Seeds AB', country: 'Sweden', headquarters: 'Sveavagen 44, 111 34 Stockholm, Sweden', default_language: 'en', time_zone: 'Europe/Stockholm', suspended: false, suspended_reason: '', scan_limit_action: 'block', logo_url: null, consent_text: 'I agree to be contacted by Nordic Seeds.', consent_version: 1, retention_leads_months: 24, retention_photos_months: 12, cloud_ai_enabled: true, offline_pack_enabled: false },
  ]);
  await S.licences.bulkPut([
    { id: uuid(), company_id: CO, type: 'annual', starts_on: addDays(-120), ends_on: addDays(245), seats: 10, scans_per_month: 0, connectors_allowed: ['zoho_crm', 'zoho_bigin', 'hubspot', 'salesforce', 'webhook', 'csv'] },
    { id: uuid(), company_id: CO2, type: 'trial', starts_on: addDays(-10), ends_on: addDays(20), seats: 3, scans_per_month: 500, connectors_allowed: ['hubspot', 'webhook', 'csv'] },
  ]);
  await S.history.bulkPut([
    { company_id: CO, at: new Date(Date.now() - 120 * 86_400_000).toISOString(), by: 'WeTano', summary: 'Annual licence created · 10 seats · unlimited scans' },
    { company_id: CO2, at: new Date(Date.now() - 10 * 86_400_000).toISOString(), by: 'WeTano', summary: 'Trial licence created · 3 seats · 500 scans/month' },
  ]);
  const person = (id: string, email: string, name: string, role: Person['role'], company_id: string | null, extra: Partial<Person> = {}): Person =>
    ({ id, email, name, phone: '', role, company_id, event_ids: company_id === CO ? [EV] : [], default_event_id: company_id === CO ? EV : null, access_ends_on: null, active: true, invited: false, avatar_url: null, has_password: role === 'super_admin', mfa_enabled: false, ...extra });
  await S.people.bulkPut([
    person(P.super, 'super@wetano.com', 'WeTano Support', 'super_admin', null),
    person(P.admin, 'admin@agroexpo.de', 'Julia Hoffmann', 'client_admin', CO, { phone: '+49 511 9876543', event_ids: [EV, EV_OLD] }),
    person(P.anna, 'anna@agroexpo.de', 'Anna Weber', 'staff', CO, { phone: '+49 151 2345678', event_ids: [EV, EV_OLD] }),
    person(P.ben, 'ben@agroexpo.de', 'Ben Keller', 'staff', CO, { phone: '+49 160 5551234' }),
    person(P.temp, 'mia.hostess@gmail.com', 'Mia Braun', 'staff', CO, { access_ends_on: addDays(3), invited: true }),
    person('p-nordic', 'admin@nordicseeds.se', 'Erik Lund', 'client_admin', CO2),
  ]);
  await S.events.bulkPut([
    { id: EV, company_id: CO, name: 'AgriTech Expo 2026', starts_on: addDays(-1), ends_on: addDays(2), venue: 'Messe Hannover', booth: 'Hall 7 · B12', status: 'open', description: 'Main stand with the irrigation demo rig. Ask visitors about plot size and crop.', time_zone: 'Europe/Berlin', template_id: TPL, attachments: [] },
    { id: EV_OLD, company_id: CO, name: 'FarmFair Spring 2026', starts_on: addDays(-150), ends_on: addDays(-148), venue: 'Messe Berlin', booth: 'Hall 2 · A04', status: 'closed', description: 'Spring fair, seed range only.', time_zone: 'Europe/Berlin', template_id: TPL_SHORT, attachments: [] },
  ]);
  await S.templates.bulkPut([
    { id: TPL, company_id: CO, name: 'Standard card', description: 'Every field we collect at trade fairs', is_default: true, field_count: DEFAULT_FIELDS.length, updated_at: nowIso() },
    { id: TPL_SHORT, company_id: CO, name: 'Quick capture', description: 'Name, company and email only - for busy days', is_default: false, field_count: 4, updated_at: nowIso() },
  ]);
  await S.fields.bulkPut(DEFAULT_FIELDS.map(([key, label, type, required, ai_hint], i) => ({
    id: uuid(), company_id: CO, template_id: TPL, key, label, type, required, ai_hint, filled_by: 'ai' as const, sort_order: i,
    options: key === 'product_interest' ? ['Seeds', 'Fertiliser', 'Irrigation', 'Drones'] : [],
  })));
  await S.fields.bulkPut(DEFAULT_FIELDS.slice(0, 4).map(([key, label, type, required, ai_hint], i) => ({
    id: uuid(), company_id: CO, template_id: TPL_SHORT, key, label, type, required, ai_hint, filled_by: 'ai' as const, sort_order: i, options: [],
  })));
  await S.tags.bulkPut([
    { id: TAG.hot, company_id: CO, name: 'Buying now', colour: 'red' },
    { id: TAG.dist, company_id: CO, name: 'Distributor', colour: 'blue' },
    { id: TAG.press, company_id: CO, name: 'Press', colour: 'purple' },
    { id: TAG.demo, company_id: CO, name: 'Wants a demo', colour: 'green' },
  ]);
  await S.plans.bulkPut([
    { id: PLAN.growth, name: 'Growth', description: 'For one sales team at a few shows a year', price_month: 9900, price_year: 99000, currency: 'EUR', seats: 10, scans_per_month: 2000, connectors_allowed: ['zoho_crm', 'zoho_bigin', 'hubspot', 'webhook', 'csv'], features: ['Unlimited events', '5 CRM connectors', 'Excel/CSV export', 'Email support'], active: true },
    { id: PLAN.pro, name: 'Professional', description: 'For distributors and multi-country teams', price_month: 24900, price_year: 249000, currency: 'EUR', seats: 30, scans_per_month: 0, connectors_allowed: ['zoho_crm', 'zoho_bigin', 'hubspot', 'salesforce', 'webhook', 'csv'], features: ['Everything in Growth', 'Salesforce connector', 'Unlimited scans', 'Priority support'], active: true },
  ]);
  await S.subs.bulkPut([
    { company_id: CO, plan_id: PLAN.pro, billing_cycle: 'annual', renews_on: addDays(245), auto_renew: true },
    { company_id: CO2, plan_id: null, billing_cycle: 'monthly', renews_on: addDays(20), auto_renew: false },
  ]);
  await S.invoices.bulkPut([
    { id: uuid(), number: 'WS-2026-0007', company_id: CO, company_name: 'Agro Expo Demo GmbH', plan_id: PLAN.pro, plan_name: 'Professional', period_start: addDays(-120), period_end: addDays(245), amount: 249000, tax: 47310, currency: 'EUR', status: 'paid', issued_on: addDays(-120), due_on: addDays(-106), paid_on: addDays(-113), paid_by: 'Bank transfer', notes: '' },
    { id: uuid(), number: 'WS-2026-0011', company_id: CO2, company_name: 'Nordic Seeds AB', plan_id: PLAN.growth, plan_name: 'Growth', period_start: addDays(-40), period_end: addDays(-10), amount: 9900, tax: 1881, currency: 'EUR', status: 'overdue', issued_on: addDays(-40), due_on: addDays(-26), paid_on: null, paid_by: '', notes: 'Chased by email twice.' },
  ]);
  await S.tickets.put({
    id: uuid(), number: 'SUP-2026-0003', company_id: CO, company_name: 'Agro Expo Demo GmbH', opened_by: 'admin@agroexpo.de',
    subject: 'Zoho fields not matching', body: 'Our custom field Product interest does not arrive in Zoho. Can you check the mapping?',
    status: 'open', priority: 'normal', assigned_to: null,
    created_at: new Date(Date.now() - 26 * 3600_000).toISOString(), updated_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    messages: [
      { id: uuid(), at: new Date(Date.now() - 26 * 3600_000).toISOString(), author: 'admin@agroexpo.de', from_wetano: false, body: 'Our custom field Product interest does not arrive in Zoho. Can you check the mapping?' },
      { id: uuid(), at: new Date(Date.now() - 2 * 3600_000).toISOString(), author: 'support@wetano.com', from_wetano: true, body: 'Thanks - the Zoho field is called Product_Interest with an underscore. Please set that in Settings, CRM connection, then send a test lead.' },
    ],
  });
  await S.policy.put({ id: 'current', ...DEFAULT_POLICY });
  await S.secrets.bulkPut([
    { person_id: P.super, password: DEMO_SUPER_PASSWORD, history: [], changed_at: addDays(-40) + 'T08:00:00.000Z', mfa_secret: 'JBSWY3DPEHPK3PXP', recovery: { codes: ['4K2P-9QX7', '7RM3-2ZLB', 'QW8N-5VTC', 'H3D6-1JYK', 'ZP9Q-8BNM'], used: 1, generated_at: addDays(-40) + 'T08:05:00.000Z' }, failed: 0, locked_until: null },
  ]);
  await S.sessions.bulkPut([
    { id: 'sess-super-old', person_id: P.super, device: 'Windows \u00b7 Edge', ip: '203.0.113.24', location: 'Chennai, IN', created_at: addDays(-6) + 'T09:12:00.000Z', last_seen_at: addDays(-1) + 'T18:40:00.000Z', current: false },
    { id: 'sess-anna-phone', person_id: P.anna, device: 'Android \u00b7 Chrome', ip: '198.51.100.7', location: 'Hannover, DE', created_at: addDays(-2) + 'T07:55:00.000Z', last_seen_at: new Date(Date.now() - 20 * 60_000).toISOString(), current: false },
  ]);
  await S.logins.bulkPut([
    { id: uuid(), at: addDays(-1) + 'T18:40:00.000Z', email: 'super@wetano.com', method: 'password', ok: true, reason: '', device: 'Windows \u00b7 Edge', ip: '203.0.113.24', location: 'Chennai, IN' },
    { id: uuid(), at: addDays(-1) + 'T18:39:00.000Z', email: 'super@wetano.com', method: 'password', ok: false, reason: 'Wrong password', device: 'Windows \u00b7 Edge', ip: '203.0.113.24', location: 'Chennai, IN' },
    { id: uuid(), at: addDays(-2) + 'T07:55:00.000Z', email: 'anna@agroexpo.de', method: 'code', ok: true, reason: '', device: 'Android \u00b7 Chrome', ip: '198.51.100.7', location: 'Hannover, DE' },
  ]);
  await S.alerts.bulkPut([
    { id: 'alert-scans', company_id: null, metric: 'scans', threshold_pct: 80, active: true, last_fired_at: null },
    { id: 'alert-seats', company_id: null, metric: 'seats', threshold_pct: 90, active: true, last_fired_at: null },
  ]);
  await S.imports.bulkPut([
    { id: 'imp-demo', company_id: CO, at: addDays(-3) + 'T11:20:00.000Z', by: 'admin@agroexpo.de', file_name: 'hannover-organiser-list.xlsx', event_id: EV, event_name: 'AgriTech Expo 2026', imported: 24, skipped: 3, tag_ids: [TAG.dist] },
  ]);
  await S.audit.bulkPut([
    { at: addDays(-120) + 'T09:12:00.000Z', actor: 'super@wetano.com', role: 'super_admin', company_id: CO, action: 'company.create', detail: 'Agro Expo Demo GmbH' },
    { at: addDays(-120) + 'T09:13:00.000Z', actor: 'super@wetano.com', role: 'super_admin', company_id: CO, action: 'licence.update', detail: 'Annual - 10 seats' },
    { at: addDays(-119) + 'T11:02:00.000Z', actor: 'admin@agroexpo.de', role: 'client_admin', company_id: CO, action: 'person.invite', detail: 'anna@agroexpo.de' },
    { at: addDays(-118) + 'T08:40:00.000Z', actor: 'admin@agroexpo.de', role: 'client_admin', company_id: CO, action: 'crm.connect', detail: 'zoho_crm' },
    { at: addDays(-10) + 'T16:20:00.000Z', actor: 'super@wetano.com', role: 'super_admin', company_id: CO2, action: 'company.create', detail: 'Nordic Seeds AB' },
    { at: addDays(-2) + 'T10:05:00.000Z', actor: 'admin@agroexpo.de', role: 'client_admin', company_id: CO, action: 'lead.export', detail: '6 rows' },
    { at: addDays(-1) + 'T14:31:00.000Z', actor: 'admin@agroexpo.de', role: 'client_admin', company_id: CO, action: 'field.save', detail: 'product_interest' },
  ]);

  // ---------------------------------------------------------------- Nordic Seeds gets an event and fields too
  const EV_NORDIC = 'e0000000-0000-4000-8000-000000000003';
  await S.events.put({ id: EV_NORDIC, company_id: CO2, name: 'Elmia Lantbruk 2026', starts_on: addDays(-3), ends_on: addDays(0), venue: 'Elmia, Jönköping', booth: 'Hall B · 412', status: 'open', description: 'Seed range and grain storage.', time_zone: 'Europe/Stockholm', template_id: 'tpl-nordic', attachments: [] });
  await S.templates.put({ id: 'tpl-nordic', company_id: CO2, name: 'Standard card', description: 'Default fields', is_default: true, field_count: 8, updated_at: nowIso() });
  await S.fields.bulkPut(DEFAULT_FIELDS.slice(0, 8).map(([key, label, type, required, ai_hint], i) => ({ id: `fd-nordic-${i}`, company_id: CO2, template_id: 'tpl-nordic', key, label, type, required, ai_hint, filled_by: 'ai' as const, sort_order: i, options: [] })));
  await S.people.bulkPut([
    person('p-nordic-s1', 'maja.karlsson@nordicseeds.se', 'Maja Karlsson', 'staff', CO2, { event_ids: [EV_NORDIC], default_event_id: EV_NORDIC, phone: '+46 70 123 45 67' }),
    person('p-nordic-s2', 'oscar.nilsson@nordicseeds.se', 'Oscar Nilsson', 'staff', CO2, { event_ids: [EV_NORDIC], default_event_id: EV_NORDIC }),
  ]);
  await S.people.update('p-nordic', { event_ids: [EV_NORDIC], default_event_id: EV_NORDIC });
  await S.tags.bulkPut([
    { id: 'g-n-1', company_id: CO2, name: 'Grain', colour: 'amber' },
    { id: 'g-n-2', company_id: CO2, name: 'Dealer', colour: 'blue' },
  ]);

  // ---------------------------------------------------------------- the rest of the world
  const planPair = { growth: (await S.plans.get(PLAN.growth))!, pro: (await S.plans.get(PLAN.pro))! };
  const world = buildDemoWorld({
    plans: planPair,
    existing: [
      { companyId: CO, cc: 'DE', eventIds: [EV, EV_OLD], people: [{ id: P.anna, name: 'Anna Weber' }, { id: P.ben, name: 'Ben Keller' }, { id: P.admin, name: 'Julia Hoffmann' }], tagIds: [TAG.hot, TAG.dist, TAG.press, TAG.demo] },
      { companyId: CO2, cc: 'SE', eventIds: [EV_NORDIC], people: [{ id: 'p-nordic-s1', name: 'Maja Karlsson' }, { id: 'p-nordic-s2', name: 'Oscar Nilsson' }], tagIds: ['g-n-1', 'g-n-2'] },
    ],
    // D-23: the seeded import (“hannover-organiser-list.xlsx”) brings its own leads, stamped with its batch id.
    imports: [{ batchId: 'imp-demo', companyId: CO, cc: 'DE', eventId: EV, by: { id: P.admin, name: 'Julia Hoffmann' }, count: 24, tagIds: [TAG.dist], at: addDays(-3) + 'T11:20:00.000Z' }],
  });
  await S.transaction('rw', [S.companies, S.licences, S.people, S.events, S.templates, S.fields, S.tags, S.leads, S.subs, S.invoices, S.tickets, S.notes, S.logins, S.usage, S.audit], async () => {
    await S.companies.bulkPut(world.companies);
    await S.licences.bulkPut(world.licences);
    await S.people.bulkPut(world.people);
    await S.events.bulkPut(world.events);
    await S.templates.bulkPut(world.templates);
    await S.fields.bulkPut(world.fields);
    await S.tags.bulkPut(world.tags);
    await S.leads.bulkPut(world.leads);
    await S.subs.bulkPut(world.subs);
    await S.invoices.bulkPut(world.invoices);
    await S.tickets.bulkPut(world.tickets);
    await S.notes.bulkPut(world.notes);
    await S.logins.bulkPut(world.logins);
    await S.usage.bulkAdd(world.usage);
    await S.audit.bulkAdd(world.audit);
  });

  // ---------------------------------------------------------------- passwords for every account (password-first sign-in)
  const everyone = await S.people.toArray();
  const existingSecrets = new Set((await S.secrets.toCollection().primaryKeys()) as string[]);
  await S.secrets.bulkPut(everyone.filter((x) => !existingSecrets.has(x.id)).map((x) => ({
    person_id: x.id, password: x.invited ? '' : DEMO_PASSWORD, history: [], changed_at: addDays(-20) + 'T08:00:00.000Z',
    mfa_secret: x.mfa_enabled ? 'JBSWY3DPEHPK3PXP' : null,
    recovery: x.mfa_enabled ? { codes: ['A1B2-C3D4', 'E5F6-G7H8', 'J9K1-L2M3'], used: 0, generated_at: addDays(-20) + 'T08:00:00.000Z' } : null,
    failed: 0, locked_until: x.email === 'luca.ferrari@verdeirrigazione.it' ? new Date(Date.now() + 10 * 60_000).toISOString() : null,
  })));
  await S.people.bulkPut(everyone.map((x) => ({ ...x, has_password: !x.invited })));
  await S.notes.bulkPut([
    // WeTano-level notifications (company_id null = the Super Admin console).
    { id: 'note-wetano-1', company_id: null, person_id: null, kind: 'subscription', title: 'Invoice WS-2026-0011 is overdue', body: 'Nordic Seeds AB — 14 days past the due date. Chase or suspend.', link: '/subscriptions', remind_at: null, created_at: new Date(Date.now() - 5 * 3600_000).toISOString(), read_at: null },
    { id: 'note-wetano-2', company_id: null, person_id: null, kind: 'licence_expiring', title: 'Nordic Seeds AB trial ends in 20 days', body: 'Offer a plan before scanning stops reaching their CRM.', link: '/companies', remind_at: null, created_at: new Date(Date.now() - 28 * 3600_000).toISOString(), read_at: null },

    { id: uuid(), company_id: CO, person_id: null, kind: 'lead_failed', title: 'A lead was rejected by Zoho CRM', body: 'Lucia Fernandez - the email address was not valid. Fix it and it will be sent again.', link: '/leads?status=check', remind_at: null, created_at: new Date(Date.now() - 40 * 60_000).toISOString(), read_at: null },
    { id: uuid(), company_id: CO, person_id: null, kind: 'event_starting', title: 'AgriTech Expo 2026 is running now', body: 'Hall 7 - B12. Check that every staff member can sign in.', link: '/settings?tab=events', remind_at: null, created_at: new Date(Date.now() - 20 * 3600_000).toISOString(), read_at: null },
    { id: uuid(), company_id: CO, person_id: null, kind: 'licence_expiring', title: 'Reminder: send the show report', body: 'Export the leads from AgriTech Expo and share them with the sales team.', link: '/leads', remind_at: addDays(1) + 'T09:00:00.000Z', created_at: new Date(Date.now() - 3 * 3600_000).toISOString(), read_at: null },
  ]);
  await S.connections.put({ id: 'conn-demo', company_id: CO, kind: 'zoho_crm', status: 'connected', record_type: 'Leads', mode: 'auto', account_label: 'agroexpo · zoho.eu', mapping: { first_name: 'First_Name', last_name: 'Last_Name', company: 'Company', job_title: 'Designation', email: 'Email', phone: 'Mobile', website: 'Website', country: 'Country' } });

  // A few historic leads so S5 is not empty.
  const who = [[P.anna, 'Anna Weber'], [P.ben, 'Ben Keller'], [P.admin, 'Julia Hoffmann']] as const;
  const statuses: Lead['status'][] = ['in_crm', 'in_crm', 'in_crm', 'check', 'in_crm', 'synced', 'in_crm'];
  const leads: Lead[] = SAMPLE_CARDS.map((c, i) => {
    const [pid, pname] = who[i % 3]!;
    const at = new Date(Date.now() - (i * 47 + 20) * 60_000).toISOString();
    const status = statuses[i]!;
    const fields: Record<string, FieldValue> = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { value: v, by: 'ai' as const, confidence: 0.97 }]));
    if (status === 'check') fields.email = { value: c.email.replace('@', ' at '), by: 'ai', confidence: 0.55, reason: 'The @ sign was hard to read' };
    return {
      id: uuid(), company_id: CO, event_id: i === 6 ? EV_OLD : EV, captured_by: pid, captured_by_name: pname, device: 'Android · Chrome', source: 'camera',
      fields, interest: (['hot', 'warm', 'cold'] as const)[i % 3]!, notes: i === 0 ? 'Wants a quote for 40 ha drip irrigation.' : '',
      consent: true, consent_version: 1, consent_at: at, status,
      crm_error: status === 'check' ? 'Zoho CRM rejected the email address. Please correct it and save.' : null,
      crm_record_id: status === 'in_crm' ? `zcrm_${5000 + i}` : null,
      crm_history: status === 'check' ? [{ at, ok: false, message: 'INVALID_DATA: Email' }] : status === 'in_crm' ? [{ at, ok: true, message: 'Created lead' }] : [],
      has_photo: false, has_back_photo: false, tag_ids: i % 3 === 0 ? [TAG.dist] : i === 1 ? [TAG.demo, TAG.hot] : [],
      created_at: at, updated_at: at, synced_at: at, deleted_at: null,
    };
  });
  await S.leads.bulkPut(leads);
}

// ---------------------------------------------------------------- helpers
function netGuard() {
  if (!isOnline()) throw new OfflineError();
}

export function createDemoBackend(): Backend {
  let token: string | null = null;
  let currentSessionId: string | null = store.get('wetasnap-demo-session');
  /** Where a sign-in stands, so no step can be skipped (password → code → authenticator). */
  let pending: { email: string; stage: 'email_code' | 'totp' } | null = null;
  let pendingMfaSecret: string | null = null;
  const ready = seed();

  const sixDigits = () => String(Math.floor(100000 + Math.random() * 900000));
  /**
   * First-time setup (4 Oct 2026): every invited person gets a 6-digit code and a link to the
   * setup screen. The API emails both; the demo has no email, so the code comes back to the
   * admin who sent the invitation. It is the same `reset:` code `resetPassword` checks, and it
   * lasts 7 days here too — an invitation nobody reads in ten minutes is no use.
   */
  async function invitation(email: string, resent = false): Promise<Invitation> {
    const code = sixDigits();
    await S.codes.put({ email: 'reset:' + email, code, expires: Date.now() + 7 * 24 * 60 * 60_000, attempts: 0 });
    return {
      setup_link: `${location.origin}/signin#setup=${encodeURIComponent(email)}`,
      email_sent: true, resent, demoCode: code,
    };
  }
  const randomBase32 = () => Array.from({ length: 16 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[Math.floor(Math.random() * 32)]).join('');
  const makeRecoveryCodes = (): RecoveryCodes => ({
    codes: Array.from({ length: 6 }, () => `${randomBase32().slice(0, 4)}-${randomBase32().slice(0, 4)}`),
    used: 0, generated_at: nowIso(),
  });

  async function logLogin(email: string, method: LoginEvent['method'], ok: boolean, reason: string) {
    await S.logins.add({
      id: uuid(), at: nowIso(), email, method, ok, reason,
      device: deviceName(), ip: '198.51.100.24', location: 'This device',
    });
  }

  async function setPassword(personId: string, password: string) {
    const pol = (await S.policy.get('current')) ?? { id: 'current', ...DEFAULT_POLICY };
    const problems = checkPassword(password, pol);
    if (problems.length) throw new Error(problems[0]!);
    const sec = await S.secrets.get(personId);
    // D-30: the current password counts as used too.
    const used = sec ? [sec.password, ...sec.history].filter(Boolean).slice(0, Math.max(pol.reuse_block, 1)) : [];
    if (pol.reuse_block > 0 && used.includes(password)) throw new Error(`Please choose a password you have not used in your last ${pol.reuse_block}.`);
    await S.secrets.put({
      person_id: personId, password, history: [sec?.password, ...(sec?.history ?? [])].filter(Boolean).slice(0, 10) as string[],
      changed_at: nowIso(), mfa_secret: sec?.mfa_secret ?? null, recovery: sec?.recovery ?? null, failed: 0, locked_until: null,
    });
    await S.people.update(personId, { has_password: true, invited: false });
  }

  /** Remembers this device so it shows up in “Active sessions”. */
  async function openSession(person: Person) {
    const id = currentSessionId && (await S.sessions.get(currentSessionId))?.person_id === person.id ? currentSessionId : uuid();
    currentSessionId = id;
    store.set('wetasnap-demo-session', id);
    await S.sessions.put({
      id, person_id: person.id, device: deviceName(), ip: '198.51.100.24', location: 'This device',
      created_at: nowIso(), last_seen_at: nowIso(), current: true,
    });
    return id;
  }

  /**
   * The signed-in person, and whether their access has ended (D-8). `blocked` is the plain message;
   * `cutoff` is when access ended, so leads captured before it can still be synced (W5).
   */
  async function caller(): Promise<{ p: Person; blocked: string | null; cutoff: string | null }> {
    netGuard();
    await ready;
    const p = token ? await S.people.get(token) : undefined;
    if (!p) throw new Error('Not signed in');
    const cutoffs: (string | null)[] = [];
    let blocked: string | null = null;
    const company = p.company_id ? await S.companies.get(p.company_id) : undefined;
    if (company?.suspended) {
      blocked = suspendedMessage(company);
      cutoffs.push(await lastAudit(p.company_id, 'company.suspend'));
    }
    if (!p.active) {
      blocked ??= 'This account has been deactivated. Ask your admin if you need access again.';
      cutoffs.push(await lastAudit(p.company_id, 'person.deactivate', p.email));
    }
    if (p.access_ends_on && p.access_ends_on < today()) {
      blocked ??= 'Your access ended. Ask your admin if you need access again.';
      cutoffs.push(`${p.access_ends_on}T23:59:59.999Z`);
    }
    // The earliest cut-off wins; an unknown one (null) means nothing new is accepted.
    const cutoff = !blocked ? null : cutoffs.some((c) => c === null) ? null : (cutoffs as string[]).sort()[0] ?? null;
    return { p, blocked, cutoff };
  }
  async function lastAudit(companyId: string | null, action: string, detail?: string): Promise<string | null> {
    const rows = await S.audit.where('company_id').equals(companyId ?? '').toArray();
    const hit = rows.filter((r) => r.action === action && (detail === undefined || r.detail === detail)).map((r) => r.at).sort().pop();
    return hit ?? null;
  }
  const suspendedMessage = (c: Company) => `This account is suspended. ${c.suspended_reason || 'Please contact WeTano.'}`;
  async function me(): Promise<Person> {
    const { p, blocked } = await caller();
    if (blocked) throw new Error(blocked);
    return p;
  }
  async function admin() {
    const p = await me();
    if (p.role !== 'client_admin') throw new Error('Only a Client Admin can do this');
    return p;
  }
  /** Client Admins (their own company) or WeTano. */
  async function adminOrSuper() {
    const p = await me();
    if (p.role === 'staff') throw new Error('Only a Client Admin can do this');
    return p;
  }
  async function superAdmin() {
    const p = await me();
    if (p.role !== 'super_admin') throw new Error('Only WeTano Super Admins can do this');
    return p;
  }
  /** Loads a row by id and checks it belongs to the caller's company (D-4). */
  async function own<T extends { company_id: string | null }>(table: Table<T, string>, id: string | undefined, p: Person, what: string): Promise<T> {
    const row = id ? await table.get(id) : undefined;
    if (!row || !p.company_id || row.company_id !== p.company_id) throw new Error(`${what} not found`);
    return row;
  }
  /** Keeps only events of the caller's company; the default must be one of them. */
  async function ownEvents(p: Person, ids: string[], def: string | null) {
    const mine = new Set((await S.events.where('company_id').equals(p.company_id ?? '').toArray()).map((e) => e.id));
    const event_ids = [...new Set(ids)].filter((id) => mine.has(id));
    const default_event_id = def && mine.has(def) ? def : event_ids[0] ?? null;
    if (default_event_id && !event_ids.includes(default_event_id)) event_ids.unshift(default_event_id);
    return { event_ids, default_event_id };
  }
  /** `companyId` names the company a WeTano action was about (so it can be found per company). */
  const audit = (actor: Person, action: string, detail = '', companyId?: string | null) =>
    S.audit.add({ at: nowIso(), actor: actor.email, role: actor.role, company_id: companyId === undefined ? actor.company_id : companyId, action, detail });
  const meter = (company_id: string, kind: string, extra: Partial<UsageEvent> = {}) => S.usage.add({ company_id, kind, at: nowIso(), ...extra });

  async function licenceOf(company_id: string) {
    return (await S.licences.where('company_id').equals(company_id).first())!;
  }
  async function signedIn(p: Person): Promise<SignedIn> {
    const company = p.company_id ? (await S.companies.get(p.company_id)) ?? null : null;
    if (company?.suspended) throw new Error(suspendedMessage(company));
    return { token: p.id, person: p, company, session_id: await openSession(p) };
  }
  function canSignIn(p: Person | undefined): p is Person {
    return Boolean(p && p.active && (!p.access_ends_on || p.access_ends_on >= today()));
  }

  /** D-17: what one person may see. WeTano sees its own console notes; staff only notes meant for them. */
  function visibleTo(p: Person) {
    return (n: Note) => {
      if (p.role === 'super_admin') return n.company_id === null && (!n.person_id || n.person_id === p.id);
      if (n.company_id !== p.company_id) return false;
      if (n.person_id) return n.person_id === p.id;
      return p.role === 'client_admin' || n.audience === 'everyone';
    };
  }
  const clean = ({ audience: _a, dedupe_key: _k, ...n }: Note): AppNotification => n;

  /** Writes one note unless one with the same key exists (one per alert per company per month). */
  async function noteOnce(key: string, n: Omit<Note, 'id' | 'created_at' | 'read_at' | 'dedupe_key'>) {
    if (await S.notes.filter((x) => x.dedupe_key === key).first()) return false;
    await S.notes.add({ ...n, id: uuid(), dedupe_key: key, created_at: nowIso(), read_at: null });
    return true;
  }

  /** The month's scan allowance: the plan's, else the licence's (0 = unlimited) — the same number the Usage page shows. */
  async function scanAllowance(companyId: string) {
    const m = await metrics(companyId);
    return { limit: m.scanLimit, used: m.scans, month: today().slice(0, 7) };
  }

  /** D-9 · LIC-05: with “block”, card reads and imports stop once the month's allowance is used (matches read-card / import_leads). */
  async function refuseIfBlocked(companyId: string) {
    const co = await S.companies.get(companyId);
    if (co?.scan_limit_action !== 'block') return;
    const { limit, used, month } = await scanAllowance(companyId);
    if (limit <= 0 || used < limit) return;
    await scanLimitReached(companyId, limit, month);
    const err = new Error('This month’s scan allowance is used up. Type the card in by hand — WeTano can raise the limit.');
    err.name = 'ScanLimitReached';
    (err as Error & { code?: string }).code = 'scan_limit';
    throw err;
  }

  /** D-9 · LIC-05: one notification per month to the company's admins and WeTano, whatever the action. */
  async function scanLimitReached(companyId: string, limit: number, month: string) {
    const co = await S.companies.get(companyId);
    if (!co) return;
    const body = co.scan_limit_action === 'block'
      ? 'New scans are not accepted until WeTano raises the limit. Leads already on phones are kept there and are not lost.'
      : co.scan_limit_action === 'overage'
        ? 'Scanning continues; the extra scans will appear on the next invoice.'
        : 'Scanning continues as normal — this is a heads-up only.';
    const title = `Scan allowance reached (${limit}/month)`;
    await noteOnce(`scanlimit:${companyId}:${month}`, { company_id: companyId, person_id: null, audience: 'admins', kind: 'subscription', title, body, link: '/settings?tab=billing', remind_at: null });
    await noteOnce(`scanlimit:wetano:${companyId}:${month}`, { company_id: null, person_id: null, kind: 'subscription', title: `${co.name}: ${title.toLowerCase()}`, body: `Action: ${co.scan_limit_action}. ${body}`, link: '/usage', remind_at: null });
  }

  /** D-16: evaluate active usage alerts for one company (or all) and notify once per alert per company per month. */
  async function evaluateAlerts(companyId?: string) {
    const alerts = (await S.alerts.toArray()).filter((a) => a.active && (!companyId || !a.company_id || a.company_id === companyId));
    if (!alerts.length) return;
    const cos = companyId ? [await S.companies.get(companyId)].filter((c): c is Company => Boolean(c)) : await S.companies.toArray();
    const month = today().slice(0, 7);
    for (const co of cos) {
      const relevant = alerts.filter((a) => !a.company_id || a.company_id === co.id);
      if (!relevant.length) continue;
      const m = await metrics(co.id);
      for (const a of relevant) {
        const [used, cap, unit] = a.metric === 'scans' ? [m.scans, m.scanLimit, 'scans'] : a.metric === 'seats' ? [m.seatsUsed, m.seats, 'seats'] : [m.storageMb, STORAGE_MB, 'MB of storage'];
        if (!cap || (used / cap) * 100 < a.threshold_pct) continue;
        const title = `${co.name} is at ${Math.round((used / cap) * 100)}% of its ${a.metric === 'storage' ? 'storage' : a.metric === 'seats' ? 'licensed seats' : 'scan allowance'}`;
        const body = `${used} of ${cap} ${unit} used (alert at ${a.threshold_pct}%).`;
        const a1 = await noteOnce(`alert:${a.id}:${co.id}:${month}`, { company_id: co.id, person_id: null, audience: 'admins', kind: 'subscription', title: `You are at ${Math.round((used / cap) * 100)}% of your ${a.metric === 'storage' ? 'storage' : a.metric === 'seats' ? 'seats' : 'scan allowance'}`, body: `${body} Contact WeTano to raise the limit.`, link: '/settings?tab=billing', remind_at: null });
        const a2 = await noteOnce(`alert:${a.id}:wetano:${co.id}:${month}`, { company_id: null, person_id: null, kind: 'subscription', title, body, link: '/usage', remind_at: null });
        if (a1 || a2) await S.alerts.update(a.id, { last_fired_at: nowIso() });
      }
    }
  }
  const safeAlerts = (companyId?: string) => evaluateAlerts(companyId).catch((e) => console.warn('usage alerts', e));

  /** Same numbers as the Usage page. */
  async function metrics(companyId: string) {
    const [lic, people, usage, sub, plans] = await Promise.all([
      licenceOf(companyId), S.people.where('company_id').equals(companyId).toArray(), S.usage.where('company_id').equals(companyId).toArray(),
      S.subs.get(companyId), S.plans.toArray(),
    ]);
    const month = today().slice(0, 7);
    const plan = plans.find((x) => x.id === sub?.plan_id);
    const base = usageSeed(companyId);
    return {
      scans: base.scans + usage.filter((u) => u.kind === 'scan' && u.at.startsWith(month)).length,
      scanLimit: plan?.scans_per_month ?? lic?.scans_per_month ?? 0,
      seatsUsed: people.filter((x) => holdsSeat(x)).length,
      seats: lic?.seats ?? 0,
      storageMb: base.mb,
    };
  }

  /** Simulated server pipeline after a lead arrives: AI fill for offline captures, then CRM push. */
  function pipeline(id: string): Promise<void> {
    if (running.has(id)) return Promise.resolve();
    running.add(id);
    return S.queue.put({ lead_id: id, at: nowIso() })
      .then(() => runPipeline(id))
      .catch((e) => console.warn('demo pipeline failed; will retry on the next sync', e))
      .finally(async () => {
        running.delete(id);
        await S.queue.delete(id).catch(() => {});
      });
  }

  /** D-32: a reload mid-push leaves the lead queued — pick it up again on the next sync. */
  async function retryStranded(p: Person) {
    const cutoff = new Date(Date.now() - 30_000).toISOString();
    const stale = (await S.queue.toArray()).filter((q) => q.at < cutoff && !running.has(q.lead_id));
    if (!stale.length) return;
    const leads = (await S.leads.bulkGet(stale.map((q) => q.lead_id)));
    for (const [i, l] of leads.entries()) {
      if (!l) { await S.queue.delete(stale[i]!.lead_id); continue; }
      if (l.company_id === p.company_id && l.status === 'synced' && !l.deleted_at) void pipeline(l.id);
    }
  }

  async function runPipeline(id: string) {
    await wait(900);
    let lead = await S.leads.get(id);
    if (!lead || lead.deleted_at) return;
    const company = await S.companies.get(lead.company_id);

    // AI-04: fill only empty fields, never a value a person typed.
    const hasPhoto = lead.has_photo || (await S.photos.where('lead_id').equals(id).count()) > 0;
    if (hasPhoto && company?.cloud_ai_enabled && Object.values(lead.fields).every((f) => f.by !== 'ai')) {
      const shot = await S.photos.get(`${id}/front`);
      const read: ReadResult = shot ? await (await import('../offlineReader')).readOffline(shot.blob, 'en', { silent: true }).catch(() => ({}) as ReadResult) : {};
      const fields = { ...lead.fields };
      for (const [k, v] of Object.entries(read)) if (!fields[k]?.value?.trim()) fields[k] = { ...v, by: 'ai' };
      lead = { ...lead, fields, updated_at: nowIso() };
      await S.leads.put(lead);
      await meter(lead.company_id, 'ai_read');
    }

    const conn = await S.connections.where('company_id').equals(lead.company_id).first();
    const lic = await licenceOf(lead.company_id);
    if (!conn || conn.status !== 'connected' || conn.mode !== 'auto' || licenceStatus(lic) === 'read_only') return;
    await pushToCrm(lead, conn);
  }

  async function pushToCrm(lead: Lead, conn: Connection) {
    await wait(700);
    const email = lead.fields.email?.value ?? '';
    const last = lead.fields.last_name?.value ?? '';
    const attempt: CrmAttempt = { at: nowIso(), ok: true, message: '' };
    let patch: Partial<Lead>;
    if (email && !isEmail(email)) {
      attempt.ok = false; attempt.message = 'INVALID_DATA: Email';
      patch = { status: 'check', crm_error: `${label(conn.kind)} rejected the email address. Please correct it and save.` };
    } else if (!last && conn.kind !== 'webhook') {
      attempt.ok = false; attempt.message = 'MANDATORY_NOT_FOUND: Last_Name';
      patch = { status: 'check', crm_error: `${label(conn.kind)} needs a last name for every lead. Please add it and save.` };
    } else {
      const update = Boolean(lead.crm_record_id);
      attempt.message = update ? `Updated record ${lead.crm_record_id}` : 'Created lead';
      patch = { status: 'in_crm', crm_error: null, crm_record_id: lead.crm_record_id ?? `${conn.kind}_${Math.floor(Math.random() * 90000 + 10000)}` };
    }
    const cur = await S.leads.get(lead.id);
    if (!cur) return;
    await S.leads.put({ ...cur, ...patch, crm_history: [...cur.crm_history, attempt] });
    await meter(lead.company_id, 'crm_push');
    if (!attempt.ok) {
      // D-17: the person who captured it hears about it, with a link that exists in their portal.
      const who = await S.people.get(cur.captured_by);
      const name = [cur.fields.first_name?.value, cur.fields.last_name?.value].filter(Boolean).join(' ') || 'A lead';
      if (who && who.company_id === cur.company_id) {
        await S.notes.add({
          id: uuid(), company_id: cur.company_id, person_id: who.id, kind: 'lead_failed',
          title: `A lead was rejected by ${label(conn.kind)}`, body: `${name} — ${patch.crm_error ?? ''}`,
          link: who.role === 'staff' ? '/my-leads' : '/leads?status=check', remind_at: null, created_at: nowIso(), read_at: null,
        });
      }
    }
  }



  const scope = async (f: LeadFilters) => {
    const p = await me();
    let rows = await S.leads.where('company_id').equals(p.company_id ?? '').toArray();
    if (p.role === 'staff') rows = rows.filter((l) => l.captured_by === p.id); // LEAD-03
    return applyFilters(rows, f);
  };

  return {
    mode: 'demo',
    setToken(t) { token = t; },

    /**
     * Step 1 — email and password, at the portal for this person's role.
     * Admins continue with an emailed code; Super Admins then the authenticator.
     */
    async signInWithPassword(email, password, door) {
      netGuard(); await ready; await wait(350);
      const e = email.trim().toLowerCase();
      const person = await S.people.where('email').equals(e).first();
      const sec = person ? await S.secrets.get(person.id) : undefined;
      const pol = (await S.policy.get('current')) ?? { id: 'current', ...DEFAULT_POLICY };
      pending = null;
      if (sec?.locked_until && sec.locked_until > nowIso()) {
        await logLogin(e, 'password', false, 'Account temporarily locked');
        throw new Error('Too many wrong passwords. Try again in a few minutes, or reset your password.');
      }
      if (person && !sec?.password) {
        throw new Error('You have not set a password yet. Open the \u201cSet up password\u201d button in your invitation email, or use \u201cSet or reset password\u201d below.');
      }
      if (!person || !sec || sec.password !== password) {
        if (sec) {
          const failed = sec.failed + 1;
          const lock = failed >= pol.lockout_attempts;
          await S.secrets.update(sec.person_id, { failed: lock ? 0 : failed, locked_until: lock ? new Date(Date.now() + pol.lockout_minutes * 60_000).toISOString() : null });
          await logLogin(e, 'password', false, lock ? 'Wrong password — account locked' : 'Wrong password');
          if (lock) throw new Error(`Too many wrong passwords. The account is locked for ${pol.lockout_minutes} minutes.`);
          const left = pol.lockout_attempts - failed;
          if (left <= 2) throw new Error(`That email and password do not match. ${left} attempt${left === 1 ? '' : 's'} left before the account locks.`);
        } else {
          await logLogin(e, 'password', false, 'Unknown email');
        }
        throw new Error('That email and password do not match.');
      }
      if (!canSignIn(person)) {
        await logLogin(e, 'password', false, 'Access ended or deactivated');
        throw new Error('This account can no longer sign in. Ask your admin if you need access again.');
      }
      // D-28: a suspended company is refused right after the password — before any emailed code is sent.
      const co = person.company_id ? await S.companies.get(person.company_id) : undefined;
      if (co?.suspended) {
        await logLogin(e, 'password', false, 'Company suspended');
        throw new Error(suspendedMessage(co));
      }
      // The WeTano Console has its own address; company accounts sign in on the shared page.
      if ((person.role === 'super_admin' ? 'console' : 'app') !== door) {
        await logLogin(e, 'password', false, `Wrong door (${door})`);
        throw new Error(wrongDoorMessage(person.role));
      }
      await S.secrets.update(sec.person_id, { failed: 0, locked_until: null });
      if (person.role === 'staff') {
        await logLogin(e, 'password', true, '');
        if (person.invited) await S.people.update(person.id, { invited: false });
        return { next: 'done', ...(await signedIn({ ...person, invited: false })) };
      }
      // Admins: a 6-digit code to the same address.
      const code = sixDigits();
      await S.codes.put({ email: 'login:' + e, code, expires: Date.now() + 10 * 60_000, attempts: 0 });
      pending = { email: e, stage: 'email_code' };
      await logLogin(e, 'password', true, 'Password accepted — waiting for the emailed code');
      return { next: 'email_code', demoCode: code };
    },

    async resendLoginCode(email) {
      netGuard(); await ready; await wait(300);
      const e = email.trim().toLowerCase();
      if (pending?.email !== e || pending.stage !== 'email_code') throw new Error('Start again with your password.');
      const code = sixDigits();
      await S.codes.put({ email: 'login:' + e, code, expires: Date.now() + 10 * 60_000, attempts: 0 });
      return { demoCode: code };
    },

    /** Step 2 for admins — the emailed code. */
    async verifyLoginCode(email, code) {
      netGuard(); await ready; await wait(300);
      const e = email.trim().toLowerCase();
      if (pending?.email !== e || pending.stage !== 'email_code') throw new Error('Start again with your password.');
      const row = await S.codes.get('login:' + e);
      if (!row || row.expires < Date.now() || row.attempts >= 5) { pending = null; throw new Error('This code has expired. Sign in with your password again.'); }
      if (row.code !== code) {
        await S.codes.update('login:' + e, { attempts: row.attempts + 1 });
        await logLogin(e, 'code', false, 'Wrong emailed code');
        throw new Error(row.attempts + 1 >= 5 ? 'Too many wrong codes. Sign in with your password again.' : 'That code is not right. Please try again.');
      }
      await S.codes.delete('login:' + e);
      const person = (await S.people.where('email').equals(e).first())!;
      await logLogin(e, 'code', true, '');
      // Nobody is forced to use an authenticator: it is asked for only when this person has set
      // one up in Security (client decision, 26 Sep 2026).
      if (person.mfa_enabled) { pending = { email: e, stage: 'totp' }; return { next: 'totp' }; }
      pending = null;
      if (person.invited) await S.people.update(person.id, { invited: false });
      return { next: 'done', ...(await signedIn({ ...person, invited: false })) };
    },

    /** Step 3 — authenticator app, or one recovery code. Only reachable after the emailed code. */
    async verifyTotp(email, code) {
      netGuard(); await wait(300);
      const e = (email || pending?.email || '').trim().toLowerCase();
      if (pending?.email !== e || pending.stage !== 'totp') throw new Error('Start again with your password.');
      const person = await S.people.where('email').equals(e).first();
      if (!person) throw new Error('Not allowed');
      const sec = await S.secrets.get(person.id);
      const typed = code.replace(/[\s-]/g, '').toUpperCase();
      const match = sec?.recovery?.codes.find((c) => c.replace('-', '').toUpperCase() === typed);
      if (match && sec?.recovery) {
        await S.secrets.put({ ...sec, recovery: { ...sec.recovery, used: sec.recovery.used + 1, codes: sec.recovery.codes.filter((c) => c !== match) } });
        await logLogin(e, 'recovery', true, 'Recovery code used');
        pending = null;
        return signedIn(person);
      }
      if (!/^\d{6}$/.test(code)) {
        await logLogin(e, 'totp', false, 'Wrong authenticator code');
        throw new Error('That is not a valid code. Use the 6 digits from your app, or a recovery code.');
      }
      await logLogin(e, 'totp', true, '');
      pending = null;
      return signedIn(person);
    },

    async refresh() {
      netGuard(); await ready;
      const p = token ? await S.people.get(token) : undefined;
      if (!canSignIn(p)) return null;
      // D-8: a suspended company's devices are signed out (their unsynced leads stay on the device).
      const co = p.company_id ? await S.companies.get(p.company_id) : undefined;
      if (co?.suspended) return null;
      // A device whose session was revoked elsewhere is signed out at its next contact.
      if (currentSessionId && !(await S.sessions.get(currentSessionId))) return null;
      if (currentSessionId) await S.sessions.update(currentSessionId, { last_seen_at: nowIso() });
      return signedIn(p);
    },

    async signOut() {
      if (currentSessionId) await S.sessions.delete(currentSessionId).catch(() => {});
      store.remove('wetasnap-demo-session');
      currentSessionId = null;
      token = null;
    },

    async events() {
      const p = await me();
      return (await S.events.where('company_id').equals(p.company_id ?? '').toArray()).sort((a, b) => b.starts_on.localeCompare(a.starts_on));
    },
    /** D-10: the chosen event's template, else the person's default event's, else the company default. */
    async fields(eventId) {
      const p = await me();
      const all = await S.fields.where('company_id').equals(p.company_id ?? '').toArray();
      const load = async (id: string | null | undefined) => {
        const ev = id ? await S.events.get(id) : undefined;
        return ev && ev.company_id === p.company_id ? ev : undefined;
      };
      let ev = eventId ? await load(eventId) : undefined;
      if (eventId && !ev) throw new Error('Event not found');
      ev ??= await load(p.default_event_id);
      const tpl = ev?.template_id ?? (await S.templates.where('company_id').equals(p.company_id ?? '').filter((x) => x.is_default).first())?.id;
      return all.filter((f) => f.template_id === tpl).sort((a, b) => a.sort_order - b.sort_order);
    },

    async readCard(photo) {
      const p = await me();
      await refuseIfBlocked(p.company_id!);
      await meter(p.company_id!, 'ai_read');
      // The demo has no cloud model, so the card is read on this device (Tesseract) — the values
      // come from the photo in front of you, never from a sample. The API adds Claude on top.
      // readOffline pushes the raw text to the live popup itself.
      const { readOffline } = await import('../offlineReader');
      return readOffline(photo);
    },

    async syncLead(incoming) {
      const { p, blocked, cutoff } = await caller();
      await wait(150);
      if (!p.company_id) throw new Error('Only company accounts capture leads.');
      // D-8 / W5: after access ended or suspension, only leads captured before the cut-off are accepted.
      if (blocked && (!cutoff || incoming.created_at > cutoff)) throw new Error(blocked);
      const existing = await S.leads.get(incoming.id); // idempotency key = device id (SYNC-03)
      // D-3: never trust company_id / captured_by from the device.
      if (existing && (existing.company_id !== p.company_id || (p.role === 'staff' && existing.captured_by !== p.id))) throw new Error('Not your lead');
      const ev = await S.events.get(incoming.event_id);
      if (!ev || ev.company_id !== p.company_id) throw new Error('Event not found');
      const companyTags = new Set((await S.tags.where('company_id').equals(p.company_id).toArray()).map((x) => x.id));
      const tag_ids = (incoming.tag_ids ?? []).filter((x) => companyTags.has(x));
      let row: Lead;
      if (existing) {
        // AI-04: a device copy never wipes a server AI value unless a person typed it.
        const fields = { ...existing.fields };
        for (const [k, v] of Object.entries(incoming.fields)) if (v.by === 'person' || !fields[k]?.value) fields[k] = v;
        row = {
          ...existing, ...incoming, tag_ids, fields,
          id: existing.id, company_id: existing.company_id, captured_by: existing.captured_by, captured_by_name: existing.captured_by_name,
          import_batch_id: existing.import_batch_id ?? null, created_at: existing.created_at, deleted_at: existing.deleted_at,
          status: existing.status === 'in_crm' && !changed(existing, incoming) ? 'in_crm' : 'synced',
          crm_record_id: existing.crm_record_id, crm_history: existing.crm_history, crm_error: null, synced_at: nowIso(),
        };
      } else {
        // D-9 · LIC-05: the monthly scan allowance.
        const co = (await S.companies.get(p.company_id))!;
        const { limit, used, month } = await scanAllowance(p.company_id);
        const over = limit > 0 && used >= limit;
        if (over) await scanLimitReached(p.company_id, limit, month);
        // SYNC-07: a lead already captured on a phone is always accepted, like the server's sync_lead.
        // “Block” stops new card reads and imports instead (refuseIfBlocked).
        row = {
          ...incoming, tag_ids, company_id: p.company_id, captured_by: p.id, captured_by_name: p.name, import_batch_id: null,
          status: 'synced', crm_error: null, crm_record_id: null, crm_history: [], deleted_at: null, synced_at: nowIso(),
        };
        await meter(row.company_id, 'scan', over && co.scan_limit_action === 'overage' ? { overage: true } : {});
        if (!over && limit > 0 && used + 1 >= limit) await scanLimitReached(p.company_id, limit, month);
      }
      await S.leads.put(row);
      await meter(row.company_id, 'sync');
      if (!existing || changed(existing, incoming)) void pipeline(row.id);
      void retryStranded(p);
      if (!existing) void safeAlerts(p.company_id);
      return row;
    },

    async uploadPhoto(leadId, side, blob) {
      const { p, blocked, cutoff } = await caller();
      const lead = await S.leads.get(leadId);
      // D-2: only the caller's company, and for staff only their own leads.
      if (!lead || lead.company_id !== p.company_id || (p.role === 'staff' && lead.captured_by !== p.id)) throw new Error('Lead not found');
      if (blocked && (!cutoff || lead.created_at > cutoff)) throw new Error(blocked); // W5
      if (side !== 'front' && side !== 'back') throw new Error('Unknown photo side');
      await S.photos.put({ key: `${leadId}/${side}`, lead_id: leadId, blob });
      await S.leads.update(leadId, side === 'front' ? { has_photo: true } : { has_back_photo: true });
    },

    async leadsByIds(ids) {
      const p = await me();
      void retryStranded(p);
      return (await S.leads.bulkGet(ids)).filter((l): l is Lead =>
        Boolean(l && l.company_id === p.company_id && (p.role !== 'staff' || l.captured_by === p.id)));
    },

    async reportOutbox() { /* the demo server shares the browser with the device */ },

    async leadExists(eventId, email, phone) {
      const p = await me();
      const digits = phone.replace(/\D/g, '');
      const hit = (await S.leads.where('event_id').equals(eventId).toArray()).find((l) => l.company_id === p.company_id && !l.deleted_at &&
        ((!!email && l.fields.email?.value?.trim().toLowerCase() === email) || (digits.length > 6 && l.fields.phone?.value?.replace(/\D/g, '') === digits)));
      return hit?.created_at ?? null;
    },

    listLeads: (f) => scope(f),

    async saveLead(lead, resend) {
      const p = await me();
      const cur = await S.leads.get(lead.id);
      if (!cur || cur.company_id !== p.company_id) throw new Error('Lead not found');
      if (p.role === 'staff' && cur.captured_by !== p.id) throw new Error('Not your lead');
      if (lead.event_id !== cur.event_id) {
        const ev = await S.events.get(lead.event_id);
        if (!ev || ev.company_id !== p.company_id) throw new Error('Event not found');
      }
      const companyTags = new Set((await S.tags.where('company_id').equals(p.company_id!).toArray()).map((x) => x.id));
      const row: Lead = {
        ...cur, ...lead, tag_ids: (lead.tag_ids ?? []).filter((x) => companyTags.has(x)),
        // D-4: ownership and server-managed fields always come from the stored row.
        id: cur.id, company_id: cur.company_id, captured_by: cur.captured_by, captured_by_name: cur.captured_by_name,
        import_batch_id: cur.import_batch_id ?? null, created_at: cur.created_at, deleted_at: cur.deleted_at,
        crm_record_id: cur.crm_record_id, crm_history: cur.crm_history, synced_at: cur.synced_at,
        status: 'synced', crm_error: null, updated_at: nowIso(),
      };
      await S.leads.put(row);
      await audit(p, 'lead.edit', lead.id);
      if (resend) void pipeline(row.id);
      return row;
    },

    async deleteLead(id) {
      const p = await me();
      const lead = await S.leads.get(id);
      // Staff may soft-delete their own leads; admins any lead in the company (restorable for 30 days).
      if (!lead || lead.company_id !== p.company_id || (p.role === 'staff' && lead.captured_by !== p.id)) {
        throw new Error('You can only delete leads you captured.');
      }
      await S.leads.update(id, { deleted_at: nowIso() }); // soft delete, restorable 30 days (LEAD-07)
      await audit(p, 'lead.delete', id);
    },

    async photoUrl(leadId) {
      const p = await me();
      const lead = await S.leads.get(leadId);
      if (!lead || lead.company_id !== p.company_id || (p.role === 'staff' && lead.captured_by !== p.id)) return null; // D-2
      const ph = await S.photos.get(`${leadId}/front`);
      return ph ? URL.createObjectURL(ph.blob) : null;
    },

    async counters(eventId): Promise<Counters> {
      const p = await admin();
      const all = (await S.leads.where('company_id').equals(p.company_id!).toArray()).filter((l) => !l.deleted_at);
      const t = today();
      return {
        in_event: all.filter((l) => l.event_id === eventId).length,
        today: all.filter((l) => l.created_at.slice(0, 10) === t).length,
        waiting: 0, // devices report their outbox size on sync in the real backend
        failed: all.filter((l) => l.status === 'check').length,
      };
    },

    async exportCsv(f) {
      const p = await admin();
      const rows = await scope(f);
      const defs = await this.fields();
      await audit(p, 'lead.export', `${rows.length} rows`);
      return new Blob([leadsToCsv(rows, defs, (l) => `https://app.wetasnap.com/p/${l.id}?exp=7d`)], { type: 'text/csv;charset=utf-8' });
    },

    async people() {
      const p = await admin();
      const [list, evs, leads] = await Promise.all([
        S.people.where('company_id').equals(p.company_id!).toArray(),
        S.events.where('company_id').equals(p.company_id!).toArray(),
        S.leads.where('company_id').equals(p.company_id!).toArray(),
      ]);
      return list.map<PersonRow>((x) => ({
        ...x,
        event_name: evs.find((e) => e.id === x.default_event_id)?.name ?? null,
        lead_count: leads.filter((l) => l.captured_by === x.id && !l.deleted_at).length,
        status: !x.active ? 'deactivated' : x.access_ends_on && x.access_ends_on < today() ? 'expired' : x.invited ? 'invited' : 'active',
      })).sort((a, b) => a.name.localeCompare(b.name));
    },

    async seats() {
      const p = await me();
      const lic = await licenceOf(p.company_id!);
      const used = (await S.people.where('company_id').equals(p.company_id!).toArray()).filter((x) => holdsSeat(x)).length;
      return { used, seats: lic.seats, licence: lic, status: licenceStatus(lic) };
    },

    async invite(inp) {
      const p = await admin();
      const email = inp.email.trim().toLowerCase();
      if (!isEmail(email)) throw new Error('Please enter a valid email address.');
      if (await S.people.where('email').equals(email).first()) throw new Error('This person already has access.');
      const { used, seats } = await this.seats();
      if (used >= seats) throw new Error(`All ${seats} seats are in use. Deactivate someone or ask WeTano for more seats.`); // ADM-02
      if (inp.role !== 'staff' && inp.role !== 'client_admin') throw new Error('Choose Staff or Client Admin.');
      const { event_ids, default_event_id } = await ownEvents(p, inp.event_ids ?? (inp.default_event_id ? [inp.default_event_id] : []), inp.default_event_id);
      await S.people.add({ id: uuid(), company_id: p.company_id, email, name: inp.name.trim() || email.split('@')[0]!, phone: inp.phone ?? '', role: inp.role, event_ids, default_event_id, avatar_url: null, access_ends_on: inp.access_ends_on, active: true, invited: true });
      await audit(p, 'person.invite', email);
      void safeAlerts(p.company_id!);
      return invitation(email);
    },

    async updatePerson(u) {
      const p = await admin();
      const cur = await own(S.people, u.id, p, 'Person');
      if (u.role !== 'staff' && u.role !== 'client_admin') throw new Error('Choose Staff or Client Admin.');
      // D-18: never lock yourself (or the company) out.
      if (cur.id === p.id && !u.active) throw new Error('You cannot deactivate your own account. Ask another admin to do it.');
      if (cur.id === p.id && u.role !== 'client_admin') throw new Error('You cannot remove your own admin role. Ask another admin to do it.');
      if (cur.role === 'client_admin' && cur.active && (!u.active || u.role !== 'client_admin')) {
        const others = (await S.people.where('company_id').equals(p.company_id!).toArray())
          .filter((x) => x.id !== cur.id && x.role === 'client_admin' && canSignIn(x));
        if (!others.length) throw new Error('This is the last active admin of the company. Make someone else an admin first.');
      }
      if (!cur.active && u.active) {
        const { used, seats } = await this.seats();
        if (used >= seats) throw new Error('No free seat to reactivate this person.');
      }
      const { event_ids, default_event_id } = await ownEvents(p, u.event_ids ?? [], u.default_event_id);
      // Only the editable fields; id, company, email and security flags stay as stored.
      await S.people.put({
        ...cur, name: u.name.trim() || cur.name, phone: u.phone ?? '', role: u.role, event_ids, default_event_id,
        access_ends_on: u.access_ends_on, active: u.active,
      });
      await audit(p, cur.active && !u.active ? 'person.deactivate' : 'person.edit', cur.email);
      void safeAlerts(p.company_id!);
    },

    async saveEvent(e) {
      const p = await admin();
      if (e.id) await own(S.events, e.id, p, 'Event'); // D-4
      if (e.template_id) await own(S.templates, e.template_id, p, 'Template');
      const prev = e.id ? await S.events.get(e.id) : undefined;
      const row: EventItem = { ...e, attachments: prev?.attachments ?? e.attachments ?? [], id: e.id ?? uuid(), company_id: p.company_id! };
      await S.events.put(row);
      await audit(p, 'event.save', row.name);
      return row;
    },

    async saveField(f) {
      const p = await admin();
      if (f.id) await own(S.fields, f.id, p, 'Field'); // D-4
      await own(S.templates, f.template_id, p, 'Template');
      const key = f.key || f.label.toLowerCase().normalize('NFD').replace(/[^\w\s]/g, '').trim().replace(/\s+/g, '_');
      const row: FieldDefinition = { ...f, key, id: f.id ?? uuid(), company_id: p.company_id! };
      await S.fields.put(row);
      await audit(p, 'field.save', key);
      return row;
    },
    async deleteField(id) {
      const p = await admin();
      await own(S.fields, id, p, 'Field'); // D-4
      await S.fields.delete(id);
      await audit(p, 'field.delete', id);
    },
    async reorderFields(ids) {
      const p = await admin();
      const rows = await S.fields.bulkGet(ids);
      if (rows.some((f) => !f || f.company_id !== p.company_id)) throw new Error('Field not found'); // D-4
      await S.transaction('rw', S.fields, () => Promise.all(ids.map((id, i) => S.fields.update(id, { sort_order: i }))));
    },

    async company() {
      const p = await me();
      return (await S.companies.get(p.company_id!))!;
    },
    async saveCompany(c) {
      const p = await admin();
      const cur = (await S.companies.get(p.company_id!))!;
      // D-6: only what a Client Admin may edit; suspension, scan-limit action, id and consent version stay WeTano's/the server's.
      const EDITABLE = ['name', 'logo_url', 'country', 'headquarters', 'default_language', 'time_zone', 'consent_text',
        'retention_leads_months', 'retention_photos_months', 'cloud_ai_enabled', 'offline_pack_enabled'] as const;
      const patch: Partial<Company> = {};
      for (const k of EDITABLE) if (c[k] !== undefined) (patch as Record<string, unknown>)[k] = c[k];
      if (patch.name !== undefined && !patch.name.trim()) throw new Error('Company name is required.');
      const consentChanged = patch.consent_text !== undefined && patch.consent_text !== cur.consent_text;
      const row: Company = { ...cur, ...patch, id: cur.id, consent_version: cur.consent_version + (consentChanged ? 1 : 0) }; // versioned consent (ADM-05)
      await S.companies.put(row);
      await audit(p, 'company.save');
      return row;
    },

    async connections() {
      const p = await admin(); // D-20
      return S.connections.where('company_id').equals(p.company_id!).toArray();
    },
    async allowedConnectors() {
      const p = await admin(); // D-20
      return (await licenceOf(p.company_id!)).connectors_allowed;
    },
    async connect(kind, opts) {
      const p = await admin();
      if (!(await licenceOf(p.company_id!)).connectors_allowed.includes(kind)) throw new Error('This CRM is not included in your licence.');
      if (kind === 'webhook' && !/^https:\/\/.+/.test(opts?.webhook_url ?? '')) throw new Error('The webhook address must start with https://');
      await wait(900); // the real flow redirects to the CRM's sign-in page (OAuth)
      const existing = await S.connections.where('company_id').equals(p.company_id!).toArray();
      await S.connections.bulkDelete(existing.map((c) => c.id)); // one CRM per company (CRM-01)
      const row: Connection = {
        id: uuid(), company_id: p.company_id!, kind, status: 'connected', mode: 'auto',
        record_type: kind === 'hubspot' ? 'Contacts' : kind === 'webhook' ? 'JSON' : 'Leads',
        account_label: kind === 'webhook' ? (opts?.webhook_url ?? '') : `${p.email.split('@')[1]} · ${kind === 'zoho_crm' || kind === 'zoho_bigin' ? 'zoho.eu (auto-detected)' : 'production'}`,
        mapping: defaultMapping(kind),
      };
      await S.connections.add(row);
      await audit(p, 'crm.connect', kind);
      return row;
    },
    async saveConnection(c) {
      const p = await admin();
      const cur = await own(S.connections, c.id, p, 'Connection'); // D-4
      // Mapping, mode and record type are editable; which CRM, where it points and the company are not.
      await S.connections.put({ ...cur, mapping: c.mapping ?? cur.mapping, mode: c.mode ?? cur.mode, record_type: c.record_type || cur.record_type, company_id: p.company_id! });
      await audit(p, 'crm.save', cur.kind);
    },
    async disconnect(id) {
      const p = await admin();
      await own(S.connections, id, p, 'Connection'); // D-4
      await S.connections.delete(id);
      await audit(p, 'crm.disconnect', id);
    },
    async sendTestLead(id) {
      const p = await admin();
      await wait(1100);
      const c = await S.connections.get(id);
      return c && c.company_id === p.company_id ? { ok: true, message: `Test lead “Test WeTa Snap” created in ${label(c.kind)}.` } : { ok: false, message: 'Connection not found' };
    },

    async companies() {
      await superAdmin();
      const [cos, lics, people, usage] = await Promise.all([S.companies.toArray(), S.licences.toArray(), S.people.toArray(), S.usage.toArray()]);
      const month = today().slice(0, 7);
      return cos.map<CompanySummary>((c) => {
        const licence = lics.find((l) => l.company_id === c.id)!;
        const seed = c.id === CO ? 312 : 41;
        return {
          ...c, licence, licence_status: licenceStatus(licence),
          seats_used: people.filter((p) => p.company_id === c.id && holdsSeat(p)).length,
          scans_this_month: seed + usage.filter((u) => u.company_id === c.id && u.kind === 'scan' && u.at.startsWith(month)).length,
        };
      }).sort((a, b) => a.name.localeCompare(b.name));
    },

    async createCompany(inp) {
      const p = await superAdmin();
      const email = inp.admin_email.trim().toLowerCase();
      if (!inp.name.trim()) throw new Error('Company name is required.');
      if (!isEmail(email)) throw new Error('Please enter a valid admin email.');
      if (await S.people.where('email').equals(email).first()) throw new Error('This email already has access.');
      const id = uuid();
      await S.transaction('rw', [S.companies, S.licences, S.history, S.people, S.templates, S.fields], async () => { // D-7: templates too
        await S.companies.add({ id, name: inp.name.trim(), country: inp.country, headquarters: '', default_language: 'en', time_zone: 'UTC', suspended: false, suspended_reason: '', scan_limit_action: 'notify', logo_url: null, consent_text: `I agree that ${inp.name.trim()} may contact me about its products.`, consent_version: 1, retention_leads_months: 24, retention_photos_months: 12, cloud_ai_enabled: true, offline_pack_enabled: false });
        await S.licences.add({ ...inp.licence, id: uuid(), company_id: id });
        await S.history.add({ company_id: id, at: nowIso(), by: p.email, summary: `${cap(inp.licence.type)} licence created · ${inp.licence.seats} seats · ${inp.licence.scans_per_month || 'unlimited'} scans/month` });
        await S.people.add({ id: uuid(), company_id: id, email, name: inp.admin_name.trim() || email, phone: '', role: 'client_admin', event_ids: [], default_event_id: null, avatar_url: null, access_ends_on: null, active: true, invited: true });
        const tplId = uuid();
        await S.templates.add({ id: tplId, company_id: id, name: 'Standard card', description: 'Created with the company', is_default: true, field_count: 8, updated_at: nowIso() });
        await S.fields.bulkPut(DEFAULT_FIELDS.slice(0, 8).map(([key, label, type, required, ai_hint], i) => ({ id: uuid(), company_id: id, template_id: tplId, key, label, type, required, ai_hint, filled_by: 'ai' as const, sort_order: i, options: [] })));
      });
      await audit(p, 'company.create', inp.name, id);
      // LIC-01: the first admin is invited like anyone else — code, link, same setup screen.
      return invitation(email);
    },

    async updateLicence(companyId, l) {
      const p = await superAdmin();
      const cur = await licenceOf(companyId);
      const changes: string[] = [];
      if (cur.ends_on !== l.ends_on) changes.push(`valid till ${l.ends_on}`);
      if (cur.seats !== l.seats) changes.push(`seats ${cur.seats} → ${l.seats}`);
      if (cur.type !== l.type) changes.push(`type ${cur.type} → ${l.type}`);
      if (cur.scans_per_month !== l.scans_per_month) changes.push(`scans/month ${l.scans_per_month || 'unlimited'}`);
      if (cur.connectors_allowed.join() !== l.connectors_allowed.join()) changes.push('connectors changed');
      await S.licences.put({ ...cur, ...l });
      await S.history.add({ company_id: companyId, at: nowIso(), by: p.email, summary: changes.join(' · ') || 'No change' });
      await audit(p, 'licence.update', companyId, companyId);
    },

    // ---------------------------------------------------------------- devices, passwords, policy
    async sessions() {
      const p = await me();
      const rows = await S.sessions.where('person_id').equals(p.id).toArray();
      return rows.map((r) => ({ ...r, current: r.id === currentSessionId })).sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_at.localeCompare(a.last_seen_at));
    },
    async revokeSession(id) {
      const p = await me();
      const row = await S.sessions.get(id);
      if (!row || row.person_id !== p.id) throw new Error('That device is not on your account.');
      await S.sessions.delete(id);
      await audit(p, 'session.revoke', row.device);
    },
    async revokeOtherSessions() {
      const p = await me();
      const rows = await S.sessions.where('person_id').equals(p.id).toArray();
      await S.sessions.bulkDelete(rows.filter((r) => r.id !== currentSessionId).map((r) => r.id));
      await audit(p, 'session.revoke_others', String(rows.length - 1));
    },
    async loginHistory(personId) {
      const p = await me();
      let who = p.email;
      if (personId && personId !== p.id) {
        // D-5: WeTano any person; Client Admins only people of their company; staff only themselves.
        const target = await S.people.get(personId);
        const allowed = target && (p.role === 'super_admin' || (p.role === 'client_admin' && target.company_id === p.company_id));
        if (!target || !allowed) throw new Error('Person not found');
        who = target.email;
      }
      const rows = await S.logins.toArray();
      const mine = p.role === 'super_admin' && personId === undefined ? rows : rows.filter((r) => r.email === who);
      return mine.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
    },
    async securityPolicy() {
      await ready;
      return (await S.policy.get('current')) ?? { id: 'current', ...DEFAULT_POLICY };
    },
    async saveSecurityPolicy(pol) {
      const p = await superAdmin();
      await S.policy.put({ ...pol, id: 'current' });
      await audit(p, 'policy.save', `min ${pol.min_length}, idle ${pol.idle_timeout_minutes}m`);
      await S.notes.add({
        id: uuid(), company_id: null, person_id: null, audience: 'admins', kind: 'subscription', title: 'Security policy updated',
        body: 'Password rules and session limits changed for every account.', link: '/security', remind_at: null,
        created_at: nowIso(), read_at: null,
      });
      return pol;
    },
    async saveAvatar(file) {
      const p = await me();
      if (!file) {
        await S.people.update(p.id, { avatar_url: null });
        return null;
      }
      if (file.size > 2 * 1024 * 1024) throw new Error('Please use a picture under 2 MB.');
      const url = await blobToDataUrl(await squareThumb(file));
      await S.people.update(p.id, { avatar_url: url });
      return url;
    },
    async updateProfile(patch) {
      const p = await me();
      await S.people.update(p.id, { name: patch.name.trim() || p.name, phone: patch.phone.trim() });
      await audit(p, 'profile.save');
    },

    async requestPasswordReset(email) {
      netGuard(); await ready; await wait(500);
      const e = email.trim().toLowerCase();
      const code = sixDigits();
      await S.codes.put({ email: 'reset:' + e, code, expires: Date.now() + 10 * 60_000, attempts: 0 });
      const person = await S.people.where('email').equals(e).first();
      return person && canSignIn(person) ? { demoCode: code } : {};
    },
    async resetPassword(email, code, password) {
      netGuard(); await ready;
      const e = email.trim().toLowerCase();
      const row = await S.codes.get('reset:' + e);
      if (!row || row.code !== code || row.expires < Date.now()) throw new Error('That code is wrong or has expired.');
      const person = await S.people.where('email').equals(e).first();
      if (!person) throw new Error('That code is wrong or has expired.');
      await setPassword(person.id, password);
      await S.codes.delete('reset:' + e);
      await logLogin(e, 'password', true, 'Password reset');
    },
    async requestPasswordChange(currentPassword) {
      const p = await me();
      const sec = await S.secrets.get(p.id);
      if (!sec) throw new Error('This account does not use a password.');
      if (sec.password !== currentPassword) throw new Error('That is not your current password.');
      const code = sixDigits();
      await S.codes.put({ email: 'change:' + p.email, code, expires: Date.now() + 10 * 60_000, attempts: 0 });
      return { demoCode: code };
    },
    async confirmPasswordChange(code, password) {
      const p = await me();
      const row = await S.codes.get('change:' + p.email);
      if (!row || row.code !== code || row.expires < Date.now()) throw new Error('That code is wrong or has expired.');
      await setPassword(p.id, password);
      await S.codes.delete('change:' + p.email);
      await audit(p, 'password.change');
    },

    async startMfaEnrolment() {
      const p = await me();
      const secret = randomBase32();
      pendingMfaSecret = secret;
      return { secret, otpauth_url: `otpauth://totp/WeTa%20Snap:${encodeURIComponent(p.email)}?secret=${secret}&issuer=WeTa%20Snap` };
    },
    async confirmMfaEnrolment(code) {
      const p = await me();
      if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit code from your authenticator app.');
      const codes = makeRecoveryCodes();
      const sec = await S.secrets.get(p.id);
      await S.secrets.put({
        person_id: p.id, password: sec?.password ?? '', history: sec?.history ?? [], changed_at: sec?.changed_at ?? nowIso(),
        mfa_secret: pendingMfaSecret ?? randomBase32(), recovery: codes, failed: 0, locked_until: null,
      });
      await S.people.update(p.id, { mfa_enabled: true });
      await audit(p, 'mfa.enable');
      return codes;
    },
    async disableMfa(code) {
      const p = await me();
      if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit code from your authenticator app.');
      const sec = await S.secrets.get(p.id);
      if (sec) await S.secrets.put({ ...sec, mfa_secret: null, recovery: null });
      await S.people.update(p.id, { mfa_enabled: false });
      await audit(p, 'mfa.disable');
    },
    async recoveryCodes() {
      const p = await me();
      const sec = await S.secrets.get(p.id);
      if (!sec?.recovery) throw new Error('Set up two-factor first.');
      return sec.recovery;
    },
    async regenerateRecoveryCodes() {
      const p = await me();
      const sec = await S.secrets.get(p.id);
      const codes = makeRecoveryCodes();
      await S.secrets.put({ person_id: p.id, password: sec?.password ?? '', history: sec?.history ?? [], changed_at: sec?.changed_at ?? nowIso(), mfa_secret: sec?.mfa_secret ?? null, recovery: codes, failed: 0, locked_until: null });
      await audit(p, 'mfa.recovery_codes');
      return codes;
    },

    async recordClientError(r) {
      await ready;
      const p = token ? await S.people.get(token) : undefined;
      // Deduplicate: the same error from the same place within a minute is recorded once.
      const key = `${r.name}|${r.where}|${r.message}`.slice(0, 300);
      const last = recentErrors.get(key) ?? 0;
      if (Date.now() - last < 60_000) return;
      recentErrors.set(key, Date.now());
      await S.audit.add({
        at: r.at, actor: p?.email ?? 'signed-out user', role: p?.role ?? 'system', company_id: p?.company_id ?? null,
        action: `error.${r.name || 'Error'}`,
        detail: JSON.stringify({ action: r.action, message: scrub(r.message), cause: scrub(r.cause), where: r.where, route: r.route, device: r.device, online: r.online, stack: scrub(r.stack).slice(0, 1500) }),
      });
    },

    // ---------------------------------------------------------------- bulk actions + import history
    async bulkTagLeads(ids, add, remove) {
      const p = await me();
      const rows = (await S.leads.bulkGet(ids)).filter(Boolean) as Lead[];
      const companyTags = new Set((await S.tags.where('company_id').equals(p.company_id ?? '').toArray()).map((x) => x.id));
      const adding = add.filter((x) => companyTags.has(x));
      // Staff only tag their own leads.
      await Promise.all(rows.filter((l) => l.company_id === p.company_id && (p.role !== 'staff' || l.captured_by === p.id)).map((l) => {
        const next = [...new Set([...(l.tag_ids ?? []).filter((t) => !remove.includes(t)), ...adding])];
        return S.leads.update(l.id, { tag_ids: next, updated_at: nowIso() });
      }));
      await audit(p, 'lead.bulk_tag', `${rows.length} leads`);
    },
    async bulkDeleteLeads(ids) {
      const p = await me();
      const rows = (await S.leads.bulkGet(ids)).filter(Boolean) as Lead[];
      const allowed = rows.filter((l) => l.company_id === p.company_id && (p.role === 'client_admin' || l.captured_by === p.id));
      if (allowed.length < rows.length) throw new Error('You can only delete leads you captured.');
      await Promise.all(allowed.map((l) => S.leads.update(l.id, { deleted_at: nowIso() })));
      await audit(p, 'lead.bulk_delete', `${allowed.length} leads`);
    },
    async bulkResendLeads(ids) {
      const p = await admin();
      const rows = (await S.leads.bulkGet(ids)).filter(Boolean) as Lead[];
      for (const l of rows.filter((x) => x.company_id === p.company_id)) {
        await S.leads.update(l.id, { status: 'synced', crm_error: null });
        void pipeline(l.id);
      }
      await audit(p, 'lead.bulk_resend', `${rows.length} leads`);
    },
    async importHistory() {
      const p = await admin();
      return (await S.imports.where('company_id').equals(p.company_id!).toArray()).sort((a, b) => b.at.localeCompare(a.at));
    },

    // ---------------------------------------------------------------- company detail, suspension, usage
    async companyDetail(id): Promise<CompanyDetail> {
      await superAdmin();
      const [co, lic, people, sub, plans, usage] = await Promise.all([
        S.companies.get(id), S.licences.where('company_id').equals(id).first(), S.people.where('company_id').equals(id).toArray(),
        S.subs.get(id), S.plans.toArray(), S.usage.toArray(),
      ]);
      if (!co || !lic) throw new Error('Company not found');
      const plan = plans.find((x) => x.id === sub?.plan_id);
      const month = today().slice(0, 7);
      return {
        ...co, licence: lic, licence_status: licenceStatus(lic),
        seats_used: people.filter((x) => holdsSeat(x)).length,
        scans_this_month: (id === CO ? 312 : 41) + usage.filter((u) => u.company_id === id && u.kind === 'scan' && u.at.startsWith(month)).length,
        plan_name: plan?.name ?? 'No plan',
        billing_cycle: sub?.billing_cycle ?? 'monthly',
        admins: people.filter((x) => x.role === 'client_admin').map((x) => ({
          id: x.id, name: x.name, email: x.email, phone: x.phone, active: x.active, invited: x.invited,
          last_sign_in_at: null,
        })),
      };
    },
    async setCompanySuspended(id, suspended, reason) {
      const p = await superAdmin();
      await S.companies.update(id, { suspended, suspended_reason: suspended ? reason : '' });
      await audit(p, suspended ? 'company.suspend' : 'company.restore', reason, id);
      await S.notes.add({
        id: uuid(), company_id: id, person_id: null, kind: 'subscription',
        title: suspended ? 'Account suspended' : 'Account restored',
        body: suspended ? `WeTano suspended this account: ${reason}` : 'Your account is active again.',
        link: null, remind_at: null, created_at: nowIso(), read_at: null,
      });
    },
    async setScanLimitAction(id, action: ScanLimitAction) {
      const p = await superAdmin();
      await S.companies.update(id, { scan_limit_action: action });
      await audit(p, 'company.scan_limit_action', action, id);
    },

    async usage(month): Promise<UsageRow[]> {
      await superAdmin();
      await safeAlerts(); // D-16: the Usage page is a natural moment to check the alerts
      const [cos, lics, people, events, subs, plans] = await Promise.all([
        S.companies.toArray(), S.licences.toArray(), S.people.toArray(), S.usage.toArray(), S.subs.toArray(), S.plans.toArray(),
      ]);
      const inMonth = (kind: string, id: string) => events.filter((u) => u.company_id === id && u.kind === kind && u.at.startsWith(month)).length;
      return cos.map((c) => {
        const lic = lics.find((l) => l.company_id === c.id)!;
        const plan = plans.find((x) => x.id === subs.find((s2) => s2.company_id === c.id)?.plan_id);
        const seed = usageSeed(c.id);
        return {
          company_id: c.id, company_name: c.name, month,
          scans: seed.scans + inMonth('scan', c.id),
          scan_limit: plan?.scans_per_month ?? lic.scans_per_month,
          ai_reads: seed.ai + inMonth('ai_read', c.id),
          crm_pushes: seed.push + inMonth('crm_push', c.id),
          syncs: seed.sync + inMonth('sync', c.id),
          storage_mb: seed.mb,
          seats_used: people.filter((x) => x.company_id === c.id && holdsSeat(x)).length,
          seats: lic.seats,
          suspended: c.suspended,
          scan_limit_action: c.scan_limit_action,
        };
      }).sort((a, b) => b.scans - a.scans);
    },
    async usageAlerts() {
      await superAdmin();
      return (await S.alerts.toArray()).sort((a, b) => a.metric.localeCompare(b.metric));
    },
    async saveUsageAlert(a) {
      const p = await superAdmin();
      const prev = a.id ? await S.alerts.get(a.id) : undefined;
      const row: UsageAlert = { ...a, id: a.id ?? uuid(), last_fired_at: prev?.last_fired_at ?? null }; // D-16: editing keeps “last sent”
      await S.alerts.put(row);
      await audit(p, 'usage_alert.save', `${row.metric} ${row.threshold_pct}%`);
      return row;
    },
    async deleteUsageAlert(id) {
      const p = await superAdmin();
      await S.alerts.delete(id);
      await audit(p, 'usage_alert.delete', id);
    },

    async mySubscription() {
      const p = await admin(); // D-20
      if (!p.company_id) return null;
      const [sub, plans, people, lic, usage] = await Promise.all([
        S.subs.get(p.company_id), S.plans.toArray(), S.people.where('company_id').equals(p.company_id).toArray(),
        S.licences.where('company_id').equals(p.company_id).first(), S.usage.toArray(),
      ]);
      const month = today().slice(0, 7);
      return {
        subscription: sub ?? { company_id: p.company_id, plan_id: null, billing_cycle: 'monthly' as const, renews_on: lic?.ends_on ?? today(), auto_renew: false },
        plan: plans.find((x) => x.id === sub?.plan_id) ?? null,
        seats_used: people.filter((x) => holdsSeat(x)).length,
        scans_this_month: usageSeed(p.company_id).scans + usage.filter((u) => u.company_id === p.company_id && u.kind === 'scan' && u.at.startsWith(month)).length,
      };
    },

    async licenceHistory(companyId): Promise<LicenceChange[]> {
      await superAdmin();
      return (await S.history.where('company_id').equals(companyId).toArray()).reverse();
    },

    // ---------------------------------------------------------------- tags
    async tags() {
      const p = await me();
      return (await S.tags.where('company_id').equals(p.company_id ?? '').toArray()).sort((a, b) => a.name.localeCompare(b.name));
    },
    async saveTag(tg) {
      const p = await admin();
      if (tg.id) await own(S.tags, tg.id, p, 'Tag'); // D-4
      if (!tg.name?.trim()) throw new Error('Please give the tag a name.');
      const row: Tag = { ...tg, name: tg.name.trim(), id: tg.id ?? uuid(), company_id: p.company_id! };
      await S.tags.put(row);
      await audit(p, 'tag.save', row.name);
      return row;
    },
    async deleteTag(id) {
      const p = await admin();
      await own(S.tags, id, p, 'Tag'); // D-4
      await S.tags.delete(id);
      const leads = await S.leads.where('company_id').equals(p.company_id!).toArray();
      await Promise.all(leads.filter((l) => l.tag_ids.includes(id)).map((l) => S.leads.update(l.id, { tag_ids: l.tag_ids.filter((x) => x !== id) })));
      await audit(p, 'tag.delete', id);
    },

    // ---------------------------------------------------------------- import (ADM-08)
    async importLeads(rows: ImportRow[], eventId: string, tagIds: string[], fileName: string): Promise<ImportResult> {
      const p = await admin();
      const ev = await own(S.events, eventId, p, 'Event');
      await refuseIfBlocked(p.company_id!);
      const companyTags = new Set((await S.tags.where('company_id').equals(p.company_id!).toArray()).map((x) => x.id));
      const tags = tagIds.filter((x) => companyTags.has(x));
      await wait(600);
      let imported = 0;
      let skipped = 0;
      const now = nowIso();
      const batch_id = uuid(); // D-23: every lead of this file carries it
      // D-12: duplicates are checked here against every lead of the company at this event (not the client's list).
      const emailOf = (v: string | undefined) => (v ?? '').trim().toLowerCase();
      const phoneOf = (v: string | undefined) => { const d = (v ?? '').replace(/\D/g, ''); return d.length > 6 ? d : ''; };
      const atEvent = (await S.leads.where('event_id').equals(eventId).toArray()).filter((l) => l.company_id === p.company_id && !l.deleted_at);
      const emails = new Set(atEvent.map((l) => emailOf(l.fields.email?.value)).filter(Boolean));
      const phones = new Set(atEvent.map((l) => phoneOf(l.fields.phone?.value)).filter(Boolean));
      const created: string[] = [];
      for (const r of rows) {
        if (r.duplicate) { skipped++; continue; }
        const fields: Record<string, FieldValue> = {};
        for (const [k, v] of Object.entries(r.fields)) if (typeof v === 'string' && v.trim()) fields[k] = { value: v.trim(), by: 'person' };
        if (!Object.keys(fields).length) { skipped++; continue; }
        const em = emailOf(fields.email?.value);
        const ph = phoneOf(fields.phone?.value);
        if ((em && emails.has(em)) || (ph && phones.has(ph))) { skipped++; continue; }
        if (em) emails.add(em);
        if (ph) phones.add(ph);
        const id = uuid();
        await S.leads.add({
          id, company_id: p.company_id!, event_id: eventId, captured_by: p.id, captured_by_name: p.name,
          device: 'Import', source: 'manual', fields, interest: null, notes: '', consent: false, consent_version: 1, consent_at: null,
          status: 'synced', crm_error: null, crm_record_id: null, crm_history: [], has_photo: false, has_back_photo: false,
          tag_ids: tags, import_batch_id: batch_id, created_at: now, updated_at: now, synced_at: now, deleted_at: null,
        });
        created.push(id);
        imported++;
      }
      await S.imports.add({
        id: batch_id, company_id: p.company_id!, at: nowIso(), by: p.email, file_name: fileName || 'import',
        event_id: eventId, event_name: ev.name, imported, skipped, tag_ids: tags,
      });
      // D-13: imported leads go through the same CRM pipeline as synced ones.
      for (const id of created) void pipeline(id);
      await audit(p, 'lead.import', `${imported} imported, ${skipped} skipped`);
      await S.notes.add({
        id: uuid(), company_id: p.company_id, person_id: p.id, kind: 'import_done', title: 'Import finished',
        body: `${imported} leads imported, ${skipped} skipped.`, link: '/leads', remind_at: null, created_at: nowIso(), read_at: null,
      });
      return { imported, skipped, batch_id };
    },

    // ---------------------------------------------------------------- notifications
    async notifications() {
      const p = await me();
      const rows = await S.notes.toArray();
      return rows
        .filter(visibleTo(p)) // D-17
        .filter((n) => !n.remind_at || new Date(n.remind_at).getTime() <= Date.now() + 14 * 86_400_000)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 50)
        .map(clean);
    },
    async markNotificationsRead(ids) {
      const p = await me();
      const at = nowIso();
      const see = visibleTo(p);
      const rows = (await S.notes.bulkGet(ids)).filter((n): n is Note => Boolean(n && see(n))); // D-4
      await Promise.all(rows.map((n) => S.notes.update(n.id, { read_at: at })));
    },
    async savePushSubscription() { /* the demo has no server to push from */ },

    // ---------------------------------------------------------------- card-field templates
    async templates() {
      const p = await admin(); // D-20
      const [tpls, fields] = await Promise.all([
        S.templates.where('company_id').equals(p.company_id ?? '').toArray(),
        S.fields.where('company_id').equals(p.company_id ?? '').toArray(),
      ]);
      return tpls
        .map((t) => ({ ...t, field_count: fields.filter((f) => f.template_id === t.id).length }))
        .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name));
    },
    async saveTemplate(input) {
      const p = await admin();
      const existing = input.id ? await own(S.templates, input.id, p, 'Template') : undefined; // D-4
      if (input.copy_from) await own(S.templates, input.copy_from, p, 'Template');
      if (!input.name?.trim()) throw new Error('Please give the template a name.');
      const row: FieldTemplate = {
        id: input.id ?? uuid(), company_id: p.company_id!, name: input.name.trim(), description: input.description,
        is_default: input.is_default, field_count: existing?.field_count ?? 0, updated_at: nowIso(),
      };
      await S.templates.put(row);
      if (input.copy_from) {
        const src = await S.fields.where('company_id').equals(p.company_id!).toArray();
        await S.fields.bulkPut(src.filter((f) => f.template_id === input.copy_from).map((f) => ({ ...f, id: uuid(), template_id: row.id })));
      }
      if (row.is_default) {
        const others = (await S.templates.where('company_id').equals(p.company_id!).toArray()).filter((t) => t.id !== row.id && t.is_default);
        await Promise.all(others.map((t) => S.templates.update(t.id, { is_default: false })));
      }
      await audit(p, 'template.save', row.name);
      return row;
    },
    async deleteTemplate(id) {
      const p = await admin();
      const tpl = await own(S.templates, id, p, 'Template'); // D-4
      if (tpl.is_default) throw new Error('The default template cannot be deleted. Make another one the default first.');
      const used = (await S.events.where('company_id').equals(p.company_id!).toArray()).filter((e) => e.template_id === id);
      if (used.length) throw new Error(`This template is used by ${used.length} event(s). Change those events first.`);
      await S.fields.bulkDelete((await S.fields.where('company_id').equals(p.company_id!).toArray()).filter((f) => f.template_id === id).map((f) => f.id));
      await S.templates.delete(id);
      await audit(p, 'template.delete', tpl.name);
    },
    async templateFields(templateId) {
      const p = await admin(); // D-20
      return (await S.fields.where('company_id').equals(p.company_id ?? '').toArray())
        .filter((f) => f.template_id === templateId)
        .sort((a, b) => a.sort_order - b.sort_order);
    },

    // ---------------------------------------------------------------- event attachments
    async uploadAttachment(eventId, file) {
      const p = await admin();
      const ev = await S.events.get(eventId);
      if (!ev || ev.company_id !== p.company_id) throw new Error('Event not found');
      if (file.size > 10 * 1024 * 1024) throw new Error('Please keep attachments under 10 MB.');
      const att: Attachment = {
        id: uuid(), name: file.name, mime: file.type || 'application/octet-stream', size: file.size,
        url: await blobToDataUrl(file), uploaded_at: nowIso(),
      };
      const row = { ...ev, attachments: [...ev.attachments, att] };
      await S.events.put(row);
      await audit(p, 'event.attachment.add', file.name);
      return row;
    },
    async deleteAttachment(eventId, attachmentId) {
      const p = await admin();
      const ev = await own(S.events, eventId, p, 'Event'); // D-4
      const row = { ...ev, attachments: ev.attachments.filter((a) => a.id !== attachmentId) };
      await S.events.put(row);
      await audit(p, 'event.attachment.remove', attachmentId);
      return row;
    },

    // ---------------------------------------------------------------- subscriptions (WeTano)
    async plans() {
      await me();
      return (await S.plans.toArray()).sort((a, b) => a.price_month - b.price_month);
    },
    async savePlan(pl) {
      const p = await superAdmin();
      const row: Plan = { ...pl, id: pl.id ?? uuid() };
      await S.plans.put(row);
      await audit(p, 'plan.save', row.name);
      return row;
    },
    async deletePlan(id) {
      const p = await superAdmin();
      const plan = await S.plans.get(id);
      if (!plan) throw new Error('That plan no longer exists.');
      // Both links are cleared on delete, so a plan in use would leave a subscription without a
      // plan and invoices without one to print. Those plans are hidden instead.
      const subs = (await S.subs.toArray()).filter((x) => x.plan_id === id).length;
      if (subs) throw new Error(`Cannot delete ${plan.name}: ${subs} ${subs === 1 ? 'company is' : 'companies are'} on this plan. Move them to another plan first, or hide it instead.`);
      const invoices = (await S.invoices.toArray()).filter((x) => x.plan_id === id).length;
      if (invoices) throw new Error(`Cannot delete ${plan.name}: ${invoices} invoice${invoices === 1 ? ' was' : 's were'} billed on this plan and would lose it. Hide the plan instead.`);
      await S.plans.delete(id);
      await audit(p, 'plan.delete', plan.name);
    },
    async subscriptions() {
      await superAdmin();
      const [subs, cos, plans] = await Promise.all([S.subs.toArray(), S.companies.toArray(), S.plans.toArray()]);
      return subs.map((sub) => {
        const plan = plans.find((x) => x.id === sub.plan_id);
        const mrr = !plan ? 0 : sub.billing_cycle === 'annual' ? Math.round(plan.price_year / 12) : plan.price_month;
        return { ...sub, company_name: cos.find((c) => c.id === sub.company_id)?.name ?? '—', plan_name: plan?.name ?? 'No plan', mrr, currency: plan?.currency ?? 'EUR' };
      }).sort((a, b) => b.mrr - a.mrr);
    },
    async setSubscription(companyId, sub) {
      const p = await superAdmin();
      await S.subs.put({ ...sub, company_id: companyId });
      await audit(p, 'subscription.save', companyId, companyId);
    },
    async invoices(filter) {
      const p = await adminOrSuper(); // D-20
      let rows = await S.invoices.toArray();
      if (p.role !== 'super_admin') rows = rows.filter((i) => i.company_id === p.company_id);
      if (filter?.company_id) rows = rows.filter((i) => i.company_id === filter.company_id);
      if (filter?.status) rows = rows.filter((i) => i.status === filter.status);
      return rows.sort((a, b) => b.issued_on.localeCompare(a.issued_on));
    },
    async createInvoice(inv) {
      const p = await superAdmin();
      const [co, plan, all] = await Promise.all([S.companies.get(inv.company_id), inv.plan_id ? S.plans.get(inv.plan_id) : undefined, S.invoices.toArray()]);
      if (!co) throw new Error('Company not found');
      const year = new Date().getFullYear();
      const next = nextSequence(all.map((i) => i.number), 'WS', year); // D-14
      const row: Invoice = {
        ...inv, id: uuid(), number: `WS-${year}-${String(next).padStart(4, '0')}`,
        company_name: co?.name ?? '—', plan_name: plan?.name ?? '—',
      };
      await S.invoices.add(row);
      await audit(p, 'invoice.create', row.number, row.company_id);
      return row;
    },
    async setInvoiceStatus(id, status, paid) {
      const p = await superAdmin();
      const cur = await S.invoices.get(id);
      if (!cur) throw new Error('Invoice not found');
      // D-29: paid and cancelled invoices are final.
      if (cur.status === 'paid' || cur.status === 'cancelled') {
        if (status === cur.status) return cur;
        throw new Error(`Invoice ${cur.number} is ${cur.status} and can no longer be changed. Issue a new invoice instead.`);
      }
      const row: Invoice = { ...cur, status, paid_on: paid?.paid_on ?? (status === 'paid' ? today() : null), paid_by: paid?.paid_by ?? cur.paid_by };
      await S.invoices.put(row);
      await audit(p, 'invoice.status', `${row.number} -> ${status}`, row.company_id);
      if (status === 'sent' || status === 'paid') {
        await S.notes.add({
          id: uuid(), company_id: row.company_id, person_id: null, kind: 'subscription',
          title: status === 'paid' ? `Invoice ${row.number} marked paid` : `Invoice ${row.number} sent`,
          body: `${(row.amount + row.tax) / 100} ${row.currency} for ${row.plan_name}.`, link: null, remind_at: null,
          created_at: nowIso(), read_at: null,
        });
      }
      return row;
    },

    // ---------------------------------------------------------------- audit log (PRIV-04)
    async auditLog(f) {
      await superAdmin();
      const [rows, cos, people] = await Promise.all([S.audit.toArray(), S.companies.toArray(), S.people.toArray()]);
      // D-26: the stored role; older rows fall back to the person's current role, else `system`.
      const roleOf = (r: Audit): Role | 'system' => r.role ?? people.find((x) => x.email === r.actor)?.role ?? (r.actor.endsWith('@wetano.com') ? 'super_admin' : 'system');
      const q = f.q.trim().toLowerCase();
      return rows
        .filter((r) => !f.company_id || r.company_id === f.company_id)
        .filter((r) => !f.action || r.action.startsWith(f.action))
        .filter((r) => !f.from || r.at >= f.from)
        .filter((r) => !f.to || r.at <= f.to + 'T23:59:59.999Z')
        .filter((r) => !q || `${r.actor} ${r.action} ${r.detail}`.toLowerCase().includes(q))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 500)
        .map((r) => ({
          id: String(r.id), at: r.at, actor_email: r.actor, actor_role: roleOf(r),
          company_id: r.company_id, company_name: cos.find((c) => c.id === r.company_id)?.name ?? 'WeTano',
          action: r.action, entity: r.action.split('.')[0] ?? '', entity_id: r.action.startsWith('error.') ? null : r.detail || null,
          details: parseDetail(r.detail),
        }));
    },

    // ---------------------------------------------------------------- support
    async tickets(f) {
      const p = await adminOrSuper(); // D-20
      let rows = await S.tickets.toArray();
      if (p.role !== 'super_admin') rows = rows.filter((x) => x.company_id === p.company_id);
      if (f?.company_id) rows = rows.filter((x) => x.company_id === f.company_id);
      if (f?.status) rows = rows.filter((x) => x.status === f.status);
      return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },
    async openTicket(input) {
      const p = await adminOrSuper(); // D-20
      if (p.role === 'super_admin') throw new Error('WeTano staff answer tickets; they do not open them.');
      const co = await S.companies.get(p.company_id!);
      const year = new Date().getFullYear();
      const n = nextSequence((await S.tickets.toArray()).map((x) => x.number), 'SUP', year); // D-14
      const now = nowIso();
      const row: SupportTicket = {
        id: uuid(), number: `SUP-${year}-${String(n).padStart(4, '0')}`, company_id: p.company_id!, company_name: co?.name ?? '',
        opened_by: p.email, subject: input.subject.trim(), body: input.body.trim(), status: 'open', priority: input.priority,
        assigned_to: null, created_at: now, updated_at: now,
        messages: [{ id: uuid(), at: now, author: p.email, from_wetano: false, body: input.body.trim() }],
      };
      if (!row.subject || !row.body) throw new Error('Please fill in the subject and the message.');
      await S.tickets.add(row);
      await audit(p, 'ticket.open', row.number);
      return row;
    },
    async replyTicket(id, body) {
      const p = await adminOrSuper(); // D-20
      const cur = await S.tickets.get(id);
      if (!cur) throw new Error('Ticket not found');
      if (p.role !== 'super_admin' && cur.company_id !== p.company_id) throw new Error('Ticket not found');
      if (!body.trim()) throw new Error('Please write a message.');
      const fromWetano = p.role === 'super_admin';
      const row: SupportTicket = {
        ...cur, updated_at: nowIso(), status: fromWetano ? 'waiting' : 'open',
        messages: [...cur.messages, { id: uuid(), at: nowIso(), author: p.email, from_wetano: fromWetano, body: body.trim() }],
      };
      await S.tickets.put(row);
      if (fromWetano) {
        await S.notes.add({
          id: uuid(), company_id: cur.company_id, person_id: null, kind: 'support_reply', title: `WeTano replied to ${cur.number}`,
          body: body.trim().slice(0, 120), link: '/support', remind_at: null, created_at: nowIso(), read_at: null,
        });
      }
      await audit(p, 'ticket.reply', cur.number);
      return row;
    },
    async setTicketStatus(id, status: TicketStatus, assigned_to) {
      const p = await adminOrSuper();
      const cur = await S.tickets.get(id);
      if (!cur) throw new Error('Ticket not found');
      if (p.role === 'client_admin') {
        // D-15: a client admin may close their own company's request, nothing else.
        if (cur.company_id !== p.company_id) throw new Error('Ticket not found');
        if (status !== 'closed' || (assigned_to !== undefined && assigned_to !== cur.assigned_to)) throw new Error('Only WeTano Super Admins can do this');
      }
      const row: SupportTicket = { ...cur, status, assigned_to: assigned_to === undefined || p.role !== 'super_admin' ? cur.assigned_to : assigned_to, updated_at: nowIso() };
      await S.tickets.put(row);
      await audit(p, 'ticket.status', `${cur.number} -> ${status}`);
      return row;
    },
  };
}

function changed(a: Lead, b: Lead) {
  return JSON.stringify([a.fields, a.interest, a.notes, a.consent]) !== JSON.stringify([b.fields, b.interest, b.notes, b.consent]);
}
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Storage allowance per company used by the storage usage alert (5 GiB). */
const STORAGE_MB = 5 * 1024;
/** Demo baseline for this month's usage, so the meters are not empty (same numbers everywhere). */
function usageSeed(companyId: string) {
  return companyId === CO ? { scans: 312, ai: 298, push: 305, sync: 940, mb: 420 } : { scans: 41, ai: 39, push: 40, sync: 130, mb: 55 };
}


/** D-14: next number = highest sequence already issued for that prefix and year + 1. */
function nextSequence(numbers: string[], prefix: string, year: number) {
  const re = new RegExp(`^${prefix}-${year}-(\\d+)$`);
  return numbers.reduce((max, n) => Math.max(max, Number(re.exec(n)?.[1] ?? 0)), 0) + 1;
}

/**
 * Square 256 px thumbnail for profile pictures (D-39). Always resolves with a picture or throws a plain error:
 * a file the browser cannot decode is refused; if the canvas cannot encode (busy device, no WebP), the
 * original file is used instead of silently doing nothing.
 */
async function squareThumb(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('This picture could not be read. Please use a JPEG, PNG or WebP image.');
  }
  try {
    const side = Math.min(bmp.width, bmp.height);
    if (!side) throw new Error('This picture could not be read. Please use a JPEG, PNG or WebP image.');
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
    const encode = (type: string) => new Promise<Blob | null>((res) => {
      const timer = setTimeout(() => res(null), 5000); // toBlob can stall under load
      try {
        c.toBlob((b) => { clearTimeout(timer); res(b); }, type, 0.85);
      } catch {
        clearTimeout(timer);
        res(null);
      }
    });
    return (await encode('image/webp')) ?? (await encode('image/jpeg')) ?? file;
  } finally {
    bmp.close();
  }
}

const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac/i.test(ua) ? 'macOS' : /Windows/i.test(ua) ? 'Windows' : 'Other';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return `${os} \u00b7 ${br}`;
};
