/**
 * Bulk demo data — six client companies with people, events, fields, tags, a couple of hundred
 * leads, a year of invoices, support threads, notifications, sign-in history and usage.
 * Deterministic (seeded random), so every demo looks the same and tests can rely on it.
 */
import type {
  AppNotification, Company, EventItem, FieldDefinition, FieldTemplate, FieldValue, Invoice, Lead, LeadStatus,
  Licence, LoginEvent, Person, Plan, Subscription, SupportTicket, Tag, TagColour,
} from '../types';

export interface DemoWorld {
  companies: Company[];
  licences: Licence[];
  people: Person[];
  events: EventItem[];
  templates: FieldTemplate[];
  fields: FieldDefinition[];
  tags: Tag[];
  leads: Lead[];
  subs: Subscription[];
  invoices: Invoice[];
  tickets: SupportTicket[];
  notes: AppNotification[];
  logins: LoginEvent[];
  usage: { company_id: string; kind: string; at: string }[];
  audit: { at: string; actor: string; role?: Person['role'] | 'system'; company_id: string | null; action: string; detail: string }[];
}

/** A past Excel/CSV import whose leads are seeded too (D-23: every imported lead carries its batch id). */
export interface SeedImport {
  batchId: string; companyId: string; cc: string; eventId: string;
  by: { id: string; name: string }; count: number; tagIds: string[]; at: string;
}

// ---------------------------------------------------------------- deterministic helpers
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(20260922);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(R() * xs.length)]!;
const chance = (p: number) => R() < p;
const between = (lo: number, hi: number) => Math.floor(lo + R() * (hi - lo + 1));
const idFor = (prefix: string, i: number) => `${prefix}-${String(i).padStart(4, '0')}`;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const at = (daysAgo: number, hour = between(8, 18), min = between(0, 59)) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setHours(hour, min, between(0, 59), 0);
  return d.toISOString();
};
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '.');

// ---------------------------------------------------------------- the client companies
interface CompanySpec {
  id: string; name: string; country: string; cc: string; domain: string; tz: string; hq: string;
  plan: 'growth' | 'pro' | null; cycle: 'monthly' | 'annual'; licenceType: Licence['type'];
  ends: number; seats: number; scans: number; suspended?: string; action: Company['scan_limit_action'];
  admins: [string, string][]; staff: [string, string][]; phonePrefix: string;
  events: [string, string, string, number, number][]; // name, venue, booth, start offset, length
}

export const COMPANY_SPECS: CompanySpec[] = [
  {
    id: 'c0000000-0000-4000-8000-000000000003', name: 'Terra Maquinaria SL', country: 'Spain', cc: 'ES', domain: 'terramaquinaria.es',
    tz: 'Europe/Madrid', hq: 'Calle de la Industria 18, 50016 Zaragoza, Spain', plan: 'growth', cycle: 'monthly', licenceType: 'monthly',
    ends: 24, seats: 10, scans: 2000, action: 'overage', phonePrefix: '+34 6',
    admins: [['Carmen', 'Ruiz']], staff: [['Javier', 'Moreno'], ['Lucía', 'Navarro'], ['Pablo', 'Iglesias'], ['Marta', 'Gil']],
    events: [['FIMA Zaragoza 2026', 'Feria de Zaragoza', 'Pabellón 5 · C21', -2, 5], ['Expoliva Jaén', 'IFEJA Jaén', 'Stand 112', 40, 4]],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000004', name: 'Verde Irrigazione S.r.l.', country: 'Italy', cc: 'IT', domain: 'verdeirrigazione.it',
    tz: 'Europe/Rome', hq: 'Via dell’Agricoltura 7, 40127 Bologna, Italy', plan: 'growth', cycle: 'annual', licenceType: 'annual',
    ends: -3, seats: 6, scans: 2000, action: 'block', phonePrefix: '+39 3',
    admins: [['Giulia', 'Romano']], staff: [['Luca', 'Ferrari'], ['Sara', 'Colombo'], ['Matteo', 'Ricci']],
    events: [['EIMA International 2026', 'BolognaFiere', 'Padiglione 30 · B14', -60, 5], ['Macfrut Rimini', 'Rimini Expo Centre', 'Hall A2 · 045', -120, 3]],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000005', name: 'Polder Tech B.V.', country: 'Netherlands', cc: 'NL', domain: 'poldertech.nl',
    tz: 'Europe/Amsterdam', hq: 'Agroweg 3, 2685 Poeldijk, Netherlands', plan: 'pro', cycle: 'annual', licenceType: 'annual',
    ends: 180, seats: 20, scans: 0, action: 'notify', phonePrefix: '+31 6',
    suspended: 'Two invoices unpaid for more than 60 days.',
    admins: [['Daan', 'Bakker'], ['Emma', 'Visser']], staff: [['Lars', 'de Jong'], ['Fleur', 'Mulder'], ['Sem', 'Bos']],
    events: [['GreenTech Amsterdam', 'RAI Amsterdam', 'Hall 8 · 08.412', -95, 3]],
  },
  {
    id: 'c0000000-0000-4000-8000-000000000006', name: 'Kisan Agro Inputs Pvt Ltd', country: 'India', cc: 'IN', domain: 'kisanagro.in',
    tz: 'Asia/Kolkata', hq: 'Plot 14, SIPCOT Industrial Park, Hosur 635126, Tamil Nadu, India', plan: 'pro', cycle: 'annual', licenceType: 'annual',
    ends: 300, seats: 25, scans: 0, action: 'notify', phonePrefix: '+91 9',
    admins: [['Priya', 'Raman'], ['Arjun', 'Menon']],
    staff: [['Karthik', 'Subramanian'], ['Divya', 'Krishnan'], ['Rahul', 'Nair'], ['Meena', 'Iyer'], ['Suresh', 'Pillai'], ['Anitha', 'Rao']],
    events: [['Agri Intex Coimbatore 2026', 'CODISSIA Trade Fair Complex', 'Hall C · 17', -1, 4], ['Kisan Expo Pune', 'Moshi Exhibition Centre', 'Pavilion 2 · 88', -70, 5], ['AgroVision Nagpur', 'Reshimbagh Ground', 'Stall 204', 55, 4]],
  },
];

// ---------------------------------------------------------------- visitor pools (the cards)
const VISITORS: Record<string, { first: string[]; last: string[]; firms: string[]; titles: string[]; country: string; phone: string; tld: string }> = {
  DE: { first: ['Lukas', 'Sophie', 'Maximilian', 'Hannah', 'Felix', 'Lea', 'Jonas', 'Mia', 'Paul', 'Laura', 'Tobias', 'Katharina'], last: ['Schneider', 'Fischer', 'Weber', 'Wagner', 'Becker', 'Hoffmann', 'Schäfer', 'Koch', 'Richter', 'Wolf', 'Neumann', 'Braun'], firms: ['Feldtechnik GmbH', 'AgrarWerk AG', 'Nordsaat GmbH', 'BioBoden KG', 'Hofmann Landtechnik', 'SaatGut Plus GmbH'], titles: ['Einkaufsleiter', 'Geschäftsführer', 'Head of Procurement', 'Vertriebsleiter', 'Agronom'], country: 'Germany', phone: '+49 15', tld: 'de' },
  FR: { first: ['Camille', 'Louis', 'Chloé', 'Hugo', 'Manon', 'Lucas', 'Inès', 'Théo'], last: ['Dubois', 'Martin', 'Bernard', 'Lefèvre', 'Moreau', 'Laurent', 'Girard', 'Roux'], firms: ['AgriSol SAS', 'Semences de France', 'Terroir Tech SARL', 'CoopAgri Bretagne'], titles: ['Directrice commerciale', 'Responsable achats', 'Ingénieur agronome', 'Gérant'], country: 'France', phone: '+33 6', tld: 'fr' },
  ES: { first: ['Lucía', 'Alejandro', 'Sofía', 'Daniel', 'Carmen', 'Hugo', 'Elena', 'Álvaro'], last: ['Fernández', 'García', 'Martínez', 'López', 'Sánchez', 'Romero', 'Torres', 'Díaz'], firms: ['Cultivos Ibéricos SL', 'AgroLevante SA', 'Riegos del Sur SL', 'Olivar Moderno SL'], titles: ['Export Manager', 'Director de compras', 'Jefe de producción', 'Gerente'], country: 'Spain', phone: '+34 6', tld: 'es' },
  IT: { first: ['Marco', 'Giulia', 'Alessandro', 'Chiara', 'Francesco', 'Martina', 'Lorenzo', 'Elena'], last: ['Bianchi', 'Rossi', 'Esposito', 'Conti', 'Greco', 'Bruno', 'Galli', 'Marino'], firms: ['Semi Verdi S.r.l.', 'AgriPiemonte S.p.A.', 'Oliveto Toscano', 'Serre Italia S.r.l.'], titles: ['Responsabile acquisti', 'Direttore tecnico', 'Agronomo', 'Titolare'], country: 'Italy', phone: '+39 3', tld: 'it' },
  NL: { first: ['Sanne', 'Daan', 'Lotte', 'Bram', 'Fleur', 'Thijs', 'Anouk', 'Ruben'], last: ['de Vries', 'Jansen', 'van Dijk', 'Bakker', 'Visser', 'Smit', 'Meijer', 'de Boer'], firms: ['GroenAgro B.V.', 'Kas Innovatie B.V.', 'Tulp & Teelt', 'AquaFarm Holland'], titles: ['Inkoper', 'Directeur', 'Teeltadviseur', 'Operations Manager'], country: 'Netherlands', phone: '+31 6', tld: 'nl' },
  PT: { first: ['João', 'Ana', 'Pedro', 'Beatriz', 'Tiago', 'Inês'], last: ['Pereira', 'Silva', 'Santos', 'Oliveira', 'Costa', 'Rodrigues'], firms: ['TerraViva Lda', 'AgroAlentejo SA', 'Vinhas do Douro Lda'], titles: ['CEO', 'Diretor comercial', 'Engenheiro agrónomo'], country: 'Portugal', phone: '+351 91', tld: 'pt' },
  GB: { first: ['Emily', 'James', 'Olivia', 'Harry', 'Amelia', 'George'], last: ['Carter', 'Hughes', 'Walker', 'Wright', 'Robinson', 'Evans'], firms: ['Harvest Analytics Ltd', 'Albion Seeds Ltd', 'FieldFirst UK', 'Greenline Agritech'], titles: ['Product Lead', 'Farm Manager', 'Procurement Director', 'Agronomist'], country: 'United Kingdom', phone: '+44 77', tld: 'co.uk' },
  IN: { first: ['Ramesh', 'Lakshmi', 'Vijay', 'Kavitha', 'Senthil', 'Deepa', 'Ganesh', 'Revathi', 'Mohan', 'Sangeetha', 'Prakash', 'Nandini'], last: ['Kumar', 'Sundaram', 'Reddy', 'Natarajan', 'Patel', 'Sharma', 'Venkatesh', 'Murugan', 'Gowda', 'Joshi'], firms: ['Green Valley Farms', 'Sri Lakshmi Agro Traders', 'Cauvery Fertilisers', 'Deccan Seeds Co.', 'Tamil Nadu Farmers Coop', 'AgriStar Distributors'], titles: ['Proprietor', 'Purchase Manager', 'Dealer', 'Farm Owner', 'Area Sales Manager'], country: 'India', phone: '+91 9', tld: 'in' },
  SE: { first: ['Erik', 'Elsa', 'Oscar', 'Maja', 'Lucas', 'Alva'], last: ['Andersson', 'Johansson', 'Karlsson', 'Nilsson', 'Eriksson', 'Larsson'], firms: ['Skåne Lantbruk AB', 'Nordic Grain AB', 'Gröna Fält AB'], titles: ['Inköpschef', 'VD', 'Växtodlingsrådgivare'], country: 'Sweden', phone: '+46 70', tld: 'se' },
};

/** Which visitor nationalities turn up at each company's shows. */
const MIX: Record<string, string[]> = {
  DE: ['DE', 'DE', 'DE', 'FR', 'NL', 'IT', 'ES', 'PT', 'GB'],
  SE: ['SE', 'SE', 'DE', 'NL', 'GB'],
  ES: ['ES', 'ES', 'ES', 'PT', 'FR', 'IT'],
  IT: ['IT', 'IT', 'IT', 'FR', 'DE', 'ES'],
  NL: ['NL', 'NL', 'DE', 'GB', 'FR'],
  IN: ['IN', 'IN', 'IN', 'IN', 'IN', 'GB'],
};

const NOTES = [
  'Wants a quote for 40 ha drip irrigation.', 'Distributor for three regions — send the dealer price list.',
  'Visiting our factory next month.', 'Interested in the drone spraying demo.', 'Comparing us with two competitors.',
  'Call back after the harvest.', 'Needs Hindi and Tamil product leaflets.', 'Asked about financing options.',
  'Existing customer — reorder of seeds.', 'Press: writing an article on water saving.', '', '', '', '',
];
const PRODUCTS = ['Seeds', 'Fertiliser', 'Irrigation', 'Drones'];
const STATUSES: LeadStatus[] = ['in_crm', 'in_crm', 'in_crm', 'in_crm', 'in_crm', 'synced', 'synced', 'check', 'waiting'];

const DEFAULT_FIELDS: [string, string, FieldDefinition['type'], boolean][] = [
  ['first_name', 'First name', 'text', true], ['last_name', 'Last name', 'text', true], ['company', 'Company', 'text', false],
  ['job_title', 'Job title', 'text', false], ['email', 'Email', 'email', false], ['phone', 'Phone', 'phone', false],
  ['website', 'Website', 'link', false], ['country', 'Country', 'text', false],
  ['address', 'Address', 'text', false],
  ['phone2', 'Second phone', 'phone', false], ['phone3', 'Third phone', 'phone', false],
];
const TAG_SETS: [string, TagColour][][] = [
  [['Hot prospect', 'red'], ['Dealer', 'blue'], ['Follow up', 'amber'], ['Existing customer', 'green']],
  [['Distributor', 'blue'], ['Demo booked', 'green'], ['Price sensitive', 'amber'], ['Press', 'purple']],
];

// ---------------------------------------------------------------- the generator
export function buildDemoWorld(ctx: {
  existing: { companyId: string; cc: string; eventIds: string[]; people: { id: string; name: string }[]; tagIds: string[] }[];
  plans: Record<'growth' | 'pro', Plan>;
  imports?: SeedImport[];
}): DemoWorld {
  const w: DemoWorld = { companies: [], licences: [], people: [], events: [], templates: [], fields: [], tags: [], leads: [], subs: [], invoices: [], tickets: [], notes: [], logins: [], usage: [], audit: [] };
  let leadNo = 0;
  let invoiceNo = 20;

  const targets: { companyId: string; cc: string; eventIds: string[]; people: { id: string; name: string }[]; tagIds: string[]; domain: string; count: number }[] = [];

  // New companies with everything they need.
  COMPANY_SPECS.forEach((c, ci) => {
    const plan = c.plan ? ctx.plans[c.plan] : null;
    w.companies.push({
      id: c.id, name: c.name, country: c.country, headquarters: c.hq, default_language: 'en', time_zone: c.tz,
      logo_url: null, consent_text: `I agree that ${c.name} may contact me about its products. I can withdraw this at any time.`,
      consent_version: 1, retention_leads_months: 24, retention_photos_months: 12, cloud_ai_enabled: true, offline_pack_enabled: c.cc === 'IN',
      suspended: Boolean(c.suspended), suspended_reason: c.suspended ?? '', scan_limit_action: c.action,
    });
    w.licences.push({
      id: idFor('lic', ci + 3), company_id: c.id, type: c.licenceType, starts_on: day(c.ends - (c.licenceType === 'annual' ? 365 : 30)),
      ends_on: day(c.ends), seats: c.seats, scans_per_month: c.scans,
      connectors_allowed: plan?.connectors_allowed ?? ['zoho_crm', 'hubspot', 'webhook', 'csv'],
    });
    w.subs.push({ company_id: c.id, plan_id: plan?.id ?? null, billing_cycle: c.cycle, renews_on: day(c.ends), auto_renew: !c.suspended && c.ends > 0 });

    const eventIds: string[] = [];
    c.events.forEach(([name, venue, booth, start, len], ei) => {
      const id = `e-${ci + 3}-${ei + 1}`;
      eventIds.push(id);
      w.events.push({
        id, company_id: c.id, name, venue, booth, starts_on: day(start), ends_on: day(start + len - 1),
        status: start + len < -1 ? 'closed' : 'open', description: `${name}: our main stand. Qualify every visitor on crop and acreage.`,
        time_zone: c.tz, template_id: `tpl-${ci + 3}`, attachments: [],
      });
    });

    w.templates.push({ id: `tpl-${ci + 3}`, company_id: c.id, name: 'Standard card', description: 'Default fields', is_default: true, field_count: DEFAULT_FIELDS.length + 1, updated_at: at(30) });
    DEFAULT_FIELDS.forEach(([key, label, type, required], i) => {
      w.fields.push({ id: `fd-${ci + 3}-${i}`, company_id: c.id, template_id: `tpl-${ci + 3}`, key, label, type, required, ai_hint: '', filled_by: 'ai', sort_order: i, options: [] });
    });
    w.fields.push({ id: `fd-${ci + 3}-p`, company_id: c.id, template_id: `tpl-${ci + 3}`, key: 'product_interest', label: 'Product interest', type: 'choice', required: false, ai_hint: '', filled_by: 'staff', sort_order: 99, options: PRODUCTS });

    const tagIds: string[] = [];
    TAG_SETS[ci % 2]!.forEach(([name, colour], ti) => {
      const id = `tag-${ci + 3}-${ti}`;
      tagIds.push(id);
      w.tags.push({ id, company_id: c.id, name, colour });
    });

    const people: { id: string; name: string }[] = [];
    const addPerson = (first: string, last: string, role: Person['role'], pi: number) => {
      const id = `p-${ci + 3}-${pi}`;
      const email = `${slug(first)}.${slug(last)}@${c.domain}`.replace(/\.+/g, '.');
      const temp = role === 'staff' && pi === 5;
      w.people.push({
        id, company_id: c.id, email, name: `${first} ${last}`, phone: `${c.phonePrefix}${between(10000000, 99999999)}`.replace(/(\d{3})(\d{3})(\d+)$/, '$1 $2 $3'),
        role, event_ids: eventIds.slice(0, role === 'client_admin' ? eventIds.length : between(1, eventIds.length)),
        default_event_id: eventIds[0] ?? null, access_ends_on: temp ? day(between(-5, 6)) : null,
        active: !(role === 'staff' && pi === 4 && ci === 1), invited: role === 'staff' && pi === 3 && ci === 0,
        avatar_url: null, has_password: true, mfa_enabled: false,
      });
      if (role === 'staff') people.push({ id, name: `${first} ${last}` });
    };
    c.admins.forEach(([f, l], i) => addPerson(f, l, 'client_admin', i));
    c.staff.forEach(([f, l], i) => addPerson(f, l, 'staff', i + 1));

    targets.push({ companyId: c.id, cc: c.cc, eventIds, people, tagIds, domain: c.domain, count: c.cc === 'IN' ? 60 : between(22, 34) });
  });

  // More leads for the two existing companies too.
  for (const e of ctx.existing) targets.push({ ...e, domain: '', count: e.cc === 'DE' ? 48 : 16 });

  // ---------------------------------------------------------------- leads
  for (const tg of targets) {
    for (let i = 0; i < tg.count; i++) {
      const cc = pick(MIX[tg.cc] ?? [tg.cc]);
      const pool = VISITORS[cc]!;
      const first = pick(pool.first);
      const last = pick(pool.last);
      const firm = pick(pool.firms);
      const firmDomain = `${slug(firm).replace(/\.(gmbh|ag|sas|sarl|sl|sa|srl|spa|bv|ltd|lda|kg|ab|co)$/g, '').replace(/\./g, '')}.${pool.tld}`;
      const status = pick(STATUSES);
      const ago = between(0, 58);
      const created = at(ago);
      const captured = pick(tg.people.length ? tg.people : [{ id: 'unknown', name: 'Unknown' }]);
      const badEmail = status === 'check';
      const fields: Record<string, FieldValue> = {
        first_name: { value: first, by: 'ai', confidence: 0.97 },
        last_name: { value: last, by: 'ai', confidence: 0.96 },
        company: { value: firm, by: 'ai', confidence: 0.94 },
        job_title: { value: pick(pool.titles), by: 'ai', confidence: chance(0.2) ? 0.62 : 0.91, ...(chance(0.2) ? { reason: 'Partly hidden by glare' } : {}) },
        email: { value: badEmail ? `${slug(first)} at ${firmDomain}` : `${slug(first)}.${slug(last)}@${firmDomain}`, by: 'ai', confidence: badEmail ? 0.52 : 0.95, ...(badEmail ? { reason: 'The @ sign was hard to read' } : {}) },
        phone: { value: `${pool.phone}${between(1000000, 9999999)}`.replace(/(\+\d+ \d+)(\d{3})(\d+)$/, '$1 $2 $3'), by: 'ai', confidence: 0.9 },
        website: { value: `https://${firmDomain}`, by: 'ai', confidence: 0.93 },
        country: { value: pool.country, by: 'ai', confidence: 0.88 },
      };
      if (chance(0.5)) fields.product_interest = { value: pick(PRODUCTS), by: 'person' };
      const tagIds = tg.tagIds.filter(() => chance(0.22));
      const history = status === 'in_crm' ? [{ at: created, ok: true, message: 'Created lead' }]
        : status === 'check' ? [{ at: created, ok: false, message: 'INVALID_DATA: Email' }] : [];
      w.leads.push({
        id: idFor('lead', ++leadNo), company_id: tg.companyId, event_id: pick(tg.eventIds), captured_by: captured.id, captured_by_name: captured.name,
        device: pick(['Android · Chrome', 'iOS · Safari', 'Windows · Chrome', 'Android · Chrome']),
        source: pick(['camera', 'camera', 'camera', 'upload', 'manual'] as const), fields,
        interest: pick(['hot', 'warm', 'warm', 'cold', null] as const), notes: pick(NOTES), consent: chance(0.85), consent_version: 1,
        consent_at: created, status, crm_error: status === 'check' ? 'The CRM rejected the email address. Please correct it and save.' : null,
        crm_record_id: status === 'in_crm' ? `crm_${80000 + leadNo}` : null, crm_history: history,
        has_photo: false, has_back_photo: false, tag_ids: tagIds, created_at: created, updated_at: created,
        synced_at: status === 'waiting' ? null : created, deleted_at: chance(0.03) ? at(between(0, 5)) : null,
      });
      w.usage.push({ company_id: tg.companyId, kind: 'scan', at: created });
      if (status !== 'waiting') w.usage.push({ company_id: tg.companyId, kind: 'sync', at: created });
    }
  }

  // ---------------------------------------------------------------- invoices (a year for each paying company)
  const billed = [
    ...COMPANY_SPECS.filter((c) => c.plan).map((c) => ({ id: c.id, name: c.name, plan: ctx.plans[c.plan!], cycle: c.cycle, suspended: Boolean(c.suspended) })),
    { id: 'c0000000-0000-4000-8000-000000000001', name: 'Agro Expo Demo GmbH', plan: ctx.plans.pro, cycle: 'annual' as const, suspended: false },
  ];
  for (const b of billed) {
    const periods = b.cycle === 'annual' ? [300, 665] : [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
    periods.forEach((ago, pi) => {
      const amount = b.cycle === 'annual' ? b.plan.price_year : b.plan.price_month;
      const issued = day(-ago);
      const due = day(-ago + 14);
      const status: Invoice['status'] = b.suspended && pi < 2 ? 'overdue'
        : ago === 0 ? 'sent' : ago < 14 ? 'sent' : chance(0.08) ? 'cancelled' : 'paid';
      w.invoices.push({
        id: `inv-${++invoiceNo}`, number: `WS-${new Date(Date.now() - ago * 86_400_000).getFullYear()}-${String(invoiceNo).padStart(4, '0')}`,
        company_id: b.id, company_name: b.name, plan_id: b.plan.id, plan_name: b.plan.name,
        period_start: issued, period_end: day(-ago + (b.cycle === 'annual' ? 365 : 30)), amount, tax: Math.round(amount * 0.19),
        currency: b.plan.currency, status, issued_on: issued, due_on: due,
        paid_on: status === 'paid' ? day(-ago + between(2, 12)) : null, paid_by: status === 'paid' ? pick(['Bank transfer', 'SEPA direct debit', 'UPI']) : '', notes: status === 'overdue' ? 'Reminder sent twice.' : '',
      });
    });
  }

  // ---------------------------------------------------------------- support tickets
  const TICKETS: [string, string, SupportTicket['priority'], SupportTicket['status'], string[]][] = [
    ['CRM push failing since this morning', 'All leads from the Coimbatore show are stuck in “Check”.', 'urgent', 'open', ['We are looking at it — HubSpot returned a rate-limit error for your portal.']],
    ['How do I add a temporary hostess?', 'We have two students helping at the booth for three days.', 'low', 'resolved', ['Invite them as Staff and tick “Temporary staff — access ends on a date”.', 'Perfect, thank you!']],
    ['Invoice address is wrong', 'The invoice still shows our old Bologna address.', 'normal', 'waiting', ['Could you send us the new VAT number as well?']],
    ['Account suspended — please restore', 'We paid both invoices yesterday, the transfer reference is PT-7781.', 'high', 'open', []],
    ['Offline pack download stuck at 60%', 'On two Android phones the reading pack never finishes.', 'normal', 'open', ['Please try on Wi-Fi and keep the app open until it finishes.']],
    ['Can we export only hot leads?', 'Management wants a list of hot leads per event.', 'low', 'closed', ['Yes — filter Interest: Hot and the event, then Export.']],
    ['Card fields for a second brand', 'We exhibit two brands and need different fields.', 'normal', 'waiting', ['Create a second template in Settings → Card fields and choose it on the event.']],
  ];
  const ticketCompanies = [...COMPANY_SPECS.map((c) => ({ id: c.id, name: c.name, admin: w.people.find((p) => p.company_id === c.id && p.role === 'client_admin')!.email }))];
  TICKETS.forEach(([subject, body, priority, status, replies], i) => {
    const co = ticketCompanies[i % ticketCompanies.length]!;
    const created = at(between(1, 25));
    const messages = [{ id: `tm-${i}-0`, at: created, author: co.admin, from_wetano: false, body }];
    replies.forEach((r, ri) => messages.push({ id: `tm-${i}-${ri + 1}`, at: at(between(0, 1)), author: ri % 2 === 0 ? 'support@wetano.com' : co.admin, from_wetano: ri % 2 === 0, body: r }));
    w.tickets.push({
      id: `tk-${i + 10}`, number: `SUP-2026-${String(i + 10).padStart(4, '0')}`, company_id: co.id, company_name: co.name, opened_by: co.admin,
      subject, body, status, priority, assigned_to: status === 'open' && i % 2 === 0 ? 'support@wetano.com' : null,
      created_at: created, updated_at: messages[messages.length - 1]!.at, messages,
    });
  });

  // ---------------------------------------------------------------- notifications
  for (const c of COMPANY_SPECS) {
    w.notes.push({ id: `n-${c.id}-1`, company_id: c.id, person_id: null, kind: 'event_starting', title: `${c.events[0]![0]} is coming up`, body: 'Check that every staff member can sign in before the doors open.', link: '/settings?tab=events', remind_at: null, created_at: at(2), read_at: null });
    if (c.ends < 30) w.notes.push({ id: `n-${c.id}-2`, company_id: c.id, person_id: null, kind: c.ends < 0 ? 'licence_expired' : 'licence_expiring', title: c.ends < 0 ? 'Your licence has ended' : `Your licence ends in ${c.ends} days`, body: 'Contact WeTano to renew so leads keep reaching your CRM.', link: '/settings?tab=billing', remind_at: null, created_at: at(1), read_at: null });
    w.notes.push({ id: `n-${c.id}-3`, company_id: c.id, person_id: null, kind: 'lead_failed', title: 'Leads need a fix', body: 'Some leads were rejected by the CRM. Open them, correct the email and save.', link: '/leads?status=check', remind_at: null, created_at: at(0, 9), read_at: chance(0.5) ? at(0, 10) : null });
  }
  w.notes.push(
    { id: 'n-w-1', company_id: null, person_id: null, kind: 'subscription', title: 'Polder Tech B.V. is suspended', body: 'Two invoices over 60 days. Restore once the payment arrives.', link: '/companies', remind_at: null, created_at: at(1), read_at: null },
    { id: 'n-w-2', company_id: null, person_id: null, kind: 'licence_expired', title: 'Verde Irrigazione — licence ended 3 days ago', body: 'Grace period runs for 4 more days, then the account becomes read-only.', link: '/companies', remind_at: null, created_at: at(0, 8), read_at: null },
    { id: 'n-w-3', company_id: null, person_id: null, kind: 'support_reply', title: 'Urgent ticket from Kisan Agro Inputs', body: 'CRM push failing since this morning.', link: '/support', remind_at: null, created_at: at(0, 11), read_at: null },
    { id: 'n-w-4', company_id: null, person_id: null, kind: 'subscription', title: 'Reminder: monthly invoice run', body: 'Issue the October invoices for monthly plans.', link: '/subscriptions', remind_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), created_at: at(0), read_at: null },
  );

  // ---------------------------------------------------------------- sign-in history, including failures and a lockout
  const allPeople = w.people;
  for (let i = 0; i < 40; i++) {
    const p = pick(allPeople);
    const ok = chance(0.8);
    w.logins.push({
      id: `lg-${i}`, at: at(between(0, 20)), email: p.email, method: 'password', ok, reason: ok ? '' : pick(['Wrong password', 'Wrong emailed code', 'Wrong portal (staff)']),
      device: pick(['Android · Chrome', 'iOS · Safari', 'Windows · Edge', 'macOS · Safari']), ip: `198.51.100.${between(2, 250)}`,
      location: pick(['Hosur, IN', 'Zaragoza, ES', 'Bologna, IT', 'Poeldijk, NL', 'Chennai, IN', 'Hannover, DE']),
    });
  }
  for (let i = 0; i < 5; i++) {
    w.logins.push({ id: `lg-lock-${i}`, at: at(3, 14, 10 + i), email: 'luca.ferrari@verdeirrigazione.it', method: 'password', ok: false, reason: i === 4 ? 'Wrong password — account locked' : 'Wrong password', device: 'Android · Chrome', ip: '203.0.113.77', location: 'Unknown' });
  }

  // ---------------------------------------------------------------- audit trail, including recorded app errors
  w.audit.push(
    ...COMPANY_SPECS.map((c) => ({ at: at(between(100, 300)), actor: 'super@wetano.com', role: 'super_admin' as const, company_id: c.id, action: 'company.create', detail: c.name })),
    { at: at(1), actor: 'super@wetano.com', role: 'super_admin', company_id: COMPANY_SPECS[2]!.id, action: 'company.suspend', detail: 'Two invoices unpaid for more than 60 days.' },
    { at: at(0, 9, 12), actor: 'priya.raman@kisanagro.in', role: 'client_admin', company_id: COMPANY_SPECS[3]!.id, action: 'error.ActionFailed', detail: JSON.stringify({ action: 'Resend leads to the CRM', message: 'HubSpot returned 429 Too Many Requests', cause: 'HTTP 429 · rate limit for portal 4420913', where: 'client admin › leads', route: '/client-admin/leads', online: true }) },
    { at: at(2, 16, 40), actor: 'javier.moreno@terramaquinaria.es', role: 'staff', company_id: COMPANY_SPECS[0]!.id, action: 'error.NetworkError', detail: JSON.stringify({ action: 'Upload a card photo', message: 'Failed to fetch', cause: 'The network request did not reach the server (no connection, blocked, or the server is down).', where: 'staff › scan', route: '/staff/scan', online: false }) },
    { at: at(5, 11, 3), actor: 'giulia.romano@verdeirrigazione.it', role: 'client_admin', company_id: COMPANY_SPECS[1]!.id, action: 'error.TypeError', detail: JSON.stringify({ action: 'Export leads', message: "Cannot read properties of undefined (reading 'value')", cause: 'A value the code expected was missing — a bug in the app.', where: 'Leads › exportLeads', route: '/client-admin/leads', online: true }) },
  );

  // ---------------------------------------------------------------- seeded imports (drawn last, so the rest of the world stays identical)
  let importNo = 0;
  for (const imp of ctx.imports ?? []) {
    for (let i = 0; i < imp.count; i++) {
      const pool = VISITORS[pick(MIX[imp.cc] ?? [imp.cc])]!;
      const first = pick(pool.first);
      const last = pick(pool.last);
      const firm = pick(pool.firms);
      const firmDomain = `${slug(firm).replace(/\.(gmbh|ag|sas|sarl|sl|sa|srl|spa|bv|ltd|lda|kg|ab|co)$/g, '').replace(/\./g, '')}.${pool.tld}`;
      const fields: Record<string, FieldValue> = {
        first_name: { value: first, by: 'person' },
        last_name: { value: last, by: 'person' },
        company: { value: firm, by: 'person' },
        email: { value: `${slug(first)}.${slug(last)}.${++importNo}@${firmDomain}`, by: 'person' },
        country: { value: pool.country, by: 'person' },
      };
      w.leads.push({
        id: idFor('lead-imp', importNo), company_id: imp.companyId, event_id: imp.eventId, captured_by: imp.by.id, captured_by_name: imp.by.name,
        device: 'Import', source: 'manual', fields, interest: null, notes: '', consent: false, consent_version: 1, consent_at: null,
        status: 'in_crm', crm_error: null, crm_record_id: `crm_imp_${importNo}`, crm_history: [{ at: imp.at, ok: true, message: 'Created lead' }],
        has_photo: false, has_back_photo: false, tag_ids: imp.tagIds, import_batch_id: imp.batchId,
        created_at: imp.at, updated_at: imp.at, synced_at: imp.at, deleted_at: null,
      });
    }
  }

  return w;
}
