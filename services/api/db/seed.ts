/**
 * Development data: two client companies, a WeTano account, events, card fields, tags, people and
 * a handful of leads — enough to open every screen and see something real.
 *
 *   npm run seed            adds what is missing (safe to run again)
 *   npm run seed -- --fresh empties the tables first
 *
 * Every account uses the password below. It is a development convenience and nothing else: the
 * script refuses to run when NODE_ENV is production.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { hashPassword } from '../src/common/crypto';
import { loadEnv } from '../src/common/env';

/** The one password every seeded account gets. DEV_DEMO_PASSWORD keeps it and the sign-in
 *  page's demo panel in step; it is a development convenience and nothing else. */
const PASSWORD = loadEnv().DEV_DEMO_PASSWORD || 'WetaSnap#2026';

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function main() {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') throw new Error('The seed does not run in production.');
  const fresh = process.argv.includes('--fresh');

  const db = new Client({ connectionString: env.SERVICE_DATABASE_URL });
  await db.connect();
  const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await db.query<T>(text, params)).rows;

  if (fresh) {
    await q(`truncate companies, people, plans, audit_log, jobs, notifications restart identity cascade`);
    console.log('  cleared');
  }

  const already = await q<{ n: string }>('select count(*)::text as n from companies');
  if (Number(already[0]?.n ?? 0) > 0 && !fresh) {
    console.log('  already seeded (run with --fresh to start over)');
    await db.end();
    return;
  }

  const hash = await hashPassword(PASSWORD);

  // ---------------------------------------------------------------- plans
  const plans = await q<{ id: string; name: string }>(
    `insert into plans (name, description, price_month, price_year, currency, seats, scans_per_month, connectors_allowed, features)
     values ('Starter', 'One booth, one show', 4900, 49000, 'EUR', 3, 500, '{webhook,csv}', '{"Local card reading","CSV export"}'),
            ('Growth', 'A team on the road', 14900, 149000, 'EUR', 10, 2000, '{webhook,csv,hubspot}', '{"CRM connection","Shared tags","Import"}'),
            ('Scale', 'Several teams, several halls', 39900, 399000, 'EUR', 50, 0, '{webhook,csv,hubspot,salesforce,zoho_crm}', '{"Unlimited scans","All connectors","Priority support"}')
     returning id, name`);
  const growth = plans.find((p) => p.name === 'Growth')!;

  // ---------------------------------------------------------------- WeTano
  const wetano = await q<{ id: string }>(
    `insert into people (company_id, email, name, phone, role, active, invited, has_password)
     values (null, 'super@wetano.test', 'WeTano Support', '+33 4 72 00 00 01', 'super_admin', true, false, true)
     returning id`);
  await q(`insert into person_credentials (person_id, password_hash, password_set_at) values ($1, $2, now())`,
    [wetano[0]!.id, hash]);

  // ---------------------------------------------------------------- companies
  for (const company of [
    {
      name: 'Agro Expo Demo GmbH', country: 'Germany', tz: 'Europe/Berlin', seats: 10, scans: 2000,
      admin: { email: 'anna.admin@agroexpo.test', name: 'Anna Admin', phone: '+49 511 9999 0001' },
      staff: [
        { email: 'sam.staff@agroexpo.test', name: 'Sam Staff', phone: '+49 511 9999 0002' },
        { email: 'jonas.weber@agroexpo.test', name: 'Jonas Weber', phone: '' },
      ],
      event: { name: 'AgriTech Expo 2026', venue: 'Messe Hannover', booth: 'Hall 12 · B34' },
    },
    {
      name: 'Nordic Seeds AB', country: 'Sweden', tz: 'Europe/Stockholm', seats: 3, scans: 500,
      admin: { email: 'erik.lund@nordicseeds.test', name: 'Erik Lund', phone: '+46 8 123 456' },
      staff: [{ email: 'maja.karlsson@nordicseeds.test', name: 'Maja Karlsson', phone: '' }],
      event: { name: 'Nordic Farm Days', venue: 'Stockholmsmässan', booth: 'A14' },
    },
  ]) {
    const [company0] = await q<{ id: string }>(
      `insert into companies (name, country, time_zone, headquarters) values ($1, $2, $3, $4) returning id`,
      [company.name, company.country, company.tz, `${company.country} head office`]);
    const companyId = company0!.id;

    await q(`insert into licences (company_id, type, starts_on, ends_on, seats, scans_per_month, connectors_allowed)
             values ($1, 'annual', $2, $3, $4, $5, '{webhook,csv}')`,
      [companyId, day(-60), day(305), company.seats, company.scans]);
    await q(`insert into subscriptions (company_id, plan_id, billing_cycle, renews_on) values ($1, $2, 'annual', $3)`,
      [companyId, growth.id, day(305)]);

    const [template0] = await q<{ id: string }>(
      `insert into field_templates (company_id, name, description, is_default)
       values ($1, 'Standard card', 'Created with the company', true) returning id`, [companyId]);
    const templateId = template0!.id;
    const fields: [string, string, string, boolean][] = [
      ['full_name', 'Full name', 'text', true],
      ['job_title', 'Job title', 'text', false],
      ['company', 'Company', 'text', true],
      ['email', 'Email', 'email', true],
      ['phone', 'Phone', 'phone', false],
      ['mobile', 'Mobile', 'phone', false],
      ['website', 'Website', 'link', false],
      ['country', 'Country', 'text', false],
    ];
    for (const [i, [key, label, type, required]] of fields.entries()) {
      await q(`insert into field_definitions (company_id, template_id, key, label, type, required, sort_order)
               values ($1, $2, $3, $4, $5::field_type, $6, $7)`,
        [companyId, templateId, key, label, type, required, i]);
    }

    const [event0] = await q<{ id: string }>(
      `insert into events (company_id, name, starts_on, ends_on, venue, booth, status, time_zone, template_id)
       values ($1, $2, $3, $4, $5, $6, 'open', $7, $8) returning id`,
      [companyId, company.event.name, day(-1), day(2), company.event.venue, company.event.booth, company.tz, templateId]);
    const eventId = event0!.id;

    for (const [name, colour] of [['Distributor', 'blue'], ['Follow up', 'amber'], ['Existing customer', 'green']] as const) {
      await q(`insert into tags (company_id, name, colour) values ($1, $2, $3::tag_colour)`, [companyId, name, colour]);
    }

    const people = [
      { ...company.admin, role: 'client_admin' as const },
      ...company.staff.map((s) => ({ ...s, role: 'staff' as const })),
    ];
    const ids: string[] = [];
    for (const person of people) {
      const [row] = await q<{ id: string }>(
        `insert into people (company_id, email, name, phone, role, default_event_id, active, invited, has_password)
         values ($1, $2, $3, $4, $5::app_role, $6, true, false, true) returning id`,
        [companyId, person.email, person.name, person.phone, person.role, eventId]);
      const id = row!.id;
      await q(`insert into person_credentials (person_id, password_hash, password_set_at) values ($1, $2, now())`, [id, hash]);
      await q(`insert into person_events (person_id, event_id, company_id) values ($1, $2, $3)`, [id, eventId, companyId]);
      ids.push(id);
    }

    // A few leads, so the lists, counters and exports have something to show.
    const visitors = [
      ['Lena Fischer', 'Head of Purchasing', 'Fischer Landtechnik', 'lena.fischer@fischer-landtechnik.test', '+49 171 2345678', 'hot'],
      ['Tomás Silva', 'Farm Manager', 'Quinta do Vale', 'tomas@quintadovale.test', '+351 912 345 678', 'warm'],
      ['Ingrid Olsen', 'Technical Buyer', 'Olsen Agro', 'ingrid@olsenagro.test', '+47 900 11 222', 'warm'],
      ['Pierre Dubois', 'Director', 'Dubois Semences', 'p.dubois@dubois-semences.test', '+33 6 12 34 56 78', 'cold'],
    ];
    for (const [i, [name, title, org, email, phone, interest]] of visitors.entries()) {
      await q(
        `insert into leads (id, company_id, event_id, captured_by, captured_by_name, device, source, fields,
                            interest, notes, consent, consent_at, status, created_at, synced_at)
         values ($1, $2, $3, $4, $5, 'Android · Chrome', 'camera', $6, $7::interest_level, $8, true, now(),
                 $9::lead_status, now() - make_interval(hours => $10), now())`,
        [randomUUID(), companyId, eventId, ids[i % ids.length], people[i % people.length]!.name,
          {
            full_name: { value: name, by: 'ai', confidence: 0.96 },
            job_title: { value: title, by: 'ai', confidence: 0.9 },
            company: { value: org, by: 'ai', confidence: 0.94 },
            email: { value: email, by: 'ai', confidence: 0.97 },
            phone: { value: phone, by: 'ai', confidence: 0.9 },
          },
          interest, i === 0 ? 'Wants a quote for 12 units before the end of the quarter.' : '',
          i === 3 ? 'check' : 'synced', i * 3]);
    }
    console.log(`  ${company.name}: ${people.length} people, ${visitors.length} leads`);
  }

  await db.end();
  console.log(`\n  Seeded. Every account signs in with   ${PASSWORD}\n`);
  console.log('    WeTano Console   super@wetano.test');
  console.log('    Company admin    anna.admin@agroexpo.test   ·   erik.lund@nordicseeds.test');
  console.log('    Booth staff      sam.staff@agroexpo.test    ·   maja.karlsson@nordicseeds.test\n');
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
