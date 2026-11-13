const { Client } = require('pg');

async function seedCleanAccounts() {
  const c = new Client({
    host: '2a05:d014:7c9:4e02:5433:3dfb:73fa:894a',
    port: 5432,
    user: 'postgres',
    password: 'Sai123Himmath',
    database: 'postgres',
    ssl: { rejectUnauthorized: false }
  });

  await c.connect();
  console.log('Connecting to Supabase to set up clean 5 demo accounts...');

  const scryptHash = 'scrypt$32768$8$1$YnEBZwwwlo05GtkJIgEgaQ$Ij61a3s36pEjCKUjOxYA5FmV5aM9MGDFT5SIePIHxS0';

  // 1. WeTano Support (Super Admin)
  const superId = '00000000-0000-0000-0000-000000000001';
  await c.query(`
    insert into people (id, company_id, email, name, phone, role, active, has_password)
    values ($1, null, 'super@wetano.com', 'WeTano Support', '', 'super_admin', true, true)
    on conflict (email) do update set name = 'WeTano Support', active = true, has_password = true;
  `, [superId]);
  await c.query(`
    insert into person_credentials (person_id, password_hash, history, changed_at, failed, locked_until)
    values ($1, $2, '{}', now(), 0, null)
    on conflict (person_id) do update set password_hash = excluded.password_hash, failed = 0, locked_until = null;
  `, [superId, scryptHash]);
  console.log('1. WeTano Support OK');

  // 2. Company Admin (Julia Hoffmann)
  const coId = 'c1111111-1111-1111-1111-111111111111';
  const adminId = 'a1111111-1111-1111-1111-111111111111';
  const evId = 'e1111111-1111-1111-1111-111111111111';

  await c.query(`
    insert into people (id, company_id, email, name, phone, role, active, has_password, default_event_id)
    values ($1, $2, 'admin@agroexpo.de', 'Julia Hoffmann', '+49 511 9876543', 'client_admin', true, true, $3)
    on conflict (email) do update set name = 'Julia Hoffmann', company_id = $2, role = 'client_admin', active = true, has_password = true, default_event_id = $3;
  `, [adminId, coId, evId]);
  await c.query(`
    insert into person_credentials (person_id, password_hash, history, changed_at, failed, locked_until)
    values ($1, $2, '{}', now(), 0, null)
    on conflict (person_id) do update set password_hash = excluded.password_hash, failed = 0, locked_until = null;
  `, [adminId, scryptHash]);
  console.log('2. Company Admin (admin@agroexpo.de) OK');

  // 3. Scanner (Anna Weber)
  const annaId = 'b1111111-1111-1111-1111-111111111111';
  await c.query(`
    insert into people (id, company_id, email, name, phone, role, active, has_password, default_event_id)
    values ($1, $2, 'anna@agroexpo.de', 'Anna Weber', '+49 151 2345678', 'staff', true, true, $3)
    on conflict (email) do update set name = 'Anna Weber', company_id = $2, role = 'staff', active = true, has_password = true, default_event_id = $3;
  `, [annaId, coId, evId]);
  await c.query(`
    insert into person_credentials (person_id, password_hash, history, changed_at, failed, locked_until)
    values ($1, $2, '{}', now(), 0, null)
    on conflict (person_id) do update set password_hash = excluded.password_hash, failed = 0, locked_until = null;
  `, [annaId, scryptHash]);
  console.log('3. Scanner (anna@agroexpo.de) OK');

  // 4. Organizer (Marcus Ray - TechFest 2026)
  const orgRow = await c.query(`select id from people where email = 'organizer@techfest.org' or role = 'organizer' limit 1`);
  const orgId = orgRow.rows[0]?.id || 'd7f24ca1-7add-4a6d-ba84-8bb9f5be07a9';
  const orgEventId = '9128d2c2-61ce-460f-be1e-62c2a9a318d6';

  await c.query(`
    insert into events (id, company_id, name, starts_on, ends_on, venue, booth, status, description, organizer_id, max_logins)
    values ($1, null, 'TechFest Global 2026', current_date - interval '1 day', current_date + interval '10 days', 'Convention Center Hall A', 'Main Stage', 'open', 'Organizer event', $2, 20)
    on conflict (id) do update set name = 'TechFest Global 2026', starts_on = current_date - interval '1 day', ends_on = current_date + interval '10 days', organizer_id = $2;
  `, [orgEventId, orgId]);

  await c.query(`
    update people set email = 'organizer@techfest.org', name = 'Marcus Ray', role = 'organizer', referral_code = 'ORG-TECH26',
                      default_event_id = $2, active = true, has_password = true,
                      event_ends_on = current_date + interval '10 days', access_ends_on = current_date + interval '10 days'
    where id = $1;
  `, [orgId, orgEventId]);

  await c.query(`
    insert into person_credentials (person_id, password_hash, history, changed_at, failed, locked_until)
    values ($1, $2, '{}', now(), 0, null)
    on conflict (person_id) do update set password_hash = excluded.password_hash, failed = 0, locked_until = null;
  `, [orgId, scryptHash]);

  await c.query(`
    insert into person_events (person_id, event_id) values ($1, $2) on conflict do nothing;
  `, [orgId, orgEventId]);
  console.log('4. Organiser (organizer@techfest.org) OK');

  // 5. Event Attendee (Event Attendee under Marcus Ray)
  const attRow = await c.query(`select id from people where email = 'attendee@techfest.org' limit 1`);
  let attendeeId = attRow.rows[0]?.id;
  if (!attendeeId) {
    const newAtt = await c.query(`
      insert into people (company_id, organizer_id, email, name, phone, role, default_event_id, event_ends_on, access_ends_on, active, invited, has_password, mfa_enabled)
      values (null, $1, 'attendee@techfest.org', 'Event Attendee', '+1 555-0199', 'staff', $2, current_date + interval '10 days', current_date + interval '10 days', true, false, true, false)
      returning id;
    `, [orgId, orgEventId]);
    attendeeId = newAtt.rows[0].id;
  } else {
    await c.query(`
      update people set name = 'Event Attendee', organizer_id = $1, role = 'staff', default_event_id = $2,
                        active = true, has_password = true,
                        event_ends_on = current_date + interval '10 days', access_ends_on = current_date + interval '10 days'
      where id = $3;
    `, [orgId, orgEventId, attendeeId]);
  }

  await c.query(`
    insert into person_credentials (person_id, password_hash, history, changed_at, failed, locked_until)
    values ($1, $2, '{}', now(), 0, null)
    on conflict (person_id) do update set password_hash = excluded.password_hash, failed = 0, locked_until = null;
  `, [attendeeId, scryptHash]);

  await c.query(`
    insert into person_events (person_id, event_id) values ($1, $2) on conflict do nothing;
  `, [attendeeId, orgEventId]);
  console.log('5. Event Attendee (attendee@techfest.org) OK');

  await c.end();
  console.log('\nAll 5 demo accounts seeded and ready in Supabase!');
}

seedCleanAccounts().catch(console.error);
