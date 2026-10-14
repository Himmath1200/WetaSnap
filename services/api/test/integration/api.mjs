/**
 * Integration test: the API as the app actually calls it, against a real PostgreSQL.
 *
 *   npm run dev      (one terminal)        npm run worker   (another)
 *   npm run smoke
 *
 * It signs in as each kind of account, captures a lead, walks the first-time setup, and checks
 * that one company cannot see another's data. Codes are read from the development maildir
 * (<STORAGE_DIR>/mail), which is where MAIL_DRIVER=log puts every message.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILDIR = resolve(process.env.STORAGE_DIR ?? join(import.meta.dirname, '..', '..', 'storage'), 'mail');

/** The newest message to this address, or the newest of all. */
function lastMail(to) {
  let files;
  try {
    files = readdirSync(MAILDIR);
  } catch {
    throw new Error(`No development maildir at ${MAILDIR} — start the API with MAIL_DRIVER=log first.`);
  }
  files = files
    .filter((f) => f.endsWith('.json') && (!to || f.includes(to.replace(/[^\w.@-]/g, '_'))))
    .sort();
  const file = files.at(-1);
  return file ? JSON.parse(readFileSync(join(MAILDIR, file), 'utf8')) : null;
}

const codeFrom = (mail, pattern) => mail?.text?.match(pattern)?.[1] ?? null;
let failures = 0;

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

function check(name, ok, detail) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
  if (!ok) failures += 1;
}

const health = await call('/health');
check('health', health.status === 200 && health.body.ok, health.body);

// ---------------------------------------------------------------- staff sign-in (one step)
const staff = await call('/v1/auth/password', {
  method: 'POST',
  body: { email: 'sam.staff@agroexpo.test', password: 'WetaSnap#2026', door: 'app', device: 'Smoke · Node' },
});
check('staff signs in in one step', staff.status === 201 && staff.body.next === 'done', staff.body);
const staffToken = staff.body.token;

// wrong door
const wrongDoor = await call('/v1/auth/password', {
  method: 'POST',
  body: { email: 'sam.staff@agroexpo.test', password: 'WetaSnap#2026', door: 'console' },
});
check('company account refused at the console door', wrongDoor.status === 403 && /WeTano Console/.test(wrongDoor.body.error), wrongDoor.body);

// wrong password
const wrongPassword = await call('/v1/auth/password', {
  method: 'POST', body: { email: 'sam.staff@agroexpo.test', password: 'not-the-password', door: 'app' },
});
check('wrong password is refused', wrongPassword.status === 401, wrongPassword.body);

// ---------------------------------------------------------------- what staff may see
const me = await call('/v1/auth/me', { token: staffToken });
check('me returns the person and company', me.body?.person?.email === 'sam.staff@agroexpo.test' && !!me.body.company, me.body);

const events = await call('/v1/events', { token: staffToken });
check('events', Array.isArray(events.body) && events.body.length === 1, events.body);

const fields = await call(`/v1/fields?event_id=${events.body[0].id}`, { token: staffToken });
check('card fields for the event', Array.isArray(fields.body) && fields.body.length === 8, fields.body?.length);

const leads = await call('/v1/leads/search', { method: 'POST', token: staffToken, body: {} });
const ownOnly = Array.isArray(leads.body) && leads.body.every((l) => l.captured_by === me.body.person.id);
check('LEAD-03: staff see only their own leads', ownOnly && leads.body.length > 0, leads.body?.length);

const team = await call('/v1/team', { token: staffToken });
check('staff may not open the team screen', team.status === 403, team.body);

const adminArea = await call('/v1/admin/companies', { token: staffToken });
check('staff may not open the console', adminArea.status === 403, adminArea.body);

// ---------------------------------------------------------------- syncing a lead
const leadId = crypto.randomUUID();
const synced = await call('/v1/leads/sync', {
  method: 'POST', token: staffToken,
  body: {
    id: leadId, event_id: events.body[0].id, source: 'camera', device: 'Smoke · Node',
    fields: {
      full_name: { value: 'Smoke Tester', by: 'ai', confidence: 0.9 },
      email: { value: 'smoke@tester.test', by: 'ai', confidence: 0.95 },
      company: { value: 'Smoke Ltd', by: 'ai', confidence: 0.9 },
      phone: { value: '+49 171 0000001', by: 'ai', confidence: 0.8 },
    },
    interest: 'hot', notes: 'Met at the stand.', consent: true, consent_at: new Date().toISOString(),
    status: 'synced', tag_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  },
});
check('sync a lead', synced.status === 201 && synced.body.id === leadId, synced.body);

// idempotent: the same lead again
const again = await call('/v1/leads/sync', {
  method: 'POST', token: staffToken,
  body: { ...synced.body, notes: 'Met at the stand.', updated_at: new Date().toISOString() },
});
const count = await call('/v1/leads/search', { method: 'POST', token: staffToken, body: {} });
check('SYNC-03: syncing twice keeps one lead',
  again.status === 201 && count.body.filter((l) => l.id === leadId).length === 1, count.body?.length);

const exists = await call(`/v1/leads/exists?event_id=${events.body[0].id}&email=smoke@tester.test`, { token: staffToken });
check('LEAD-05: duplicate check finds it', !!exists.body.at, exists.body);

const counters = await call(`/v1/leads/counters?event_id=${events.body[0].id}`, { token: staffToken });
check('counters', counters.body.in_event > 0, counters.body);

// ---------------------------------------------------------------- admin sign-in (two steps)
const admin1 = await call('/v1/auth/password', {
  method: 'POST', body: { email: 'anna.admin@agroexpo.test', password: 'WetaSnap#2026', door: 'app' },
});
check('admin sign-in asks for the emailed code', admin1.body.next === 'email_code' && !!admin1.body.token, admin1.body);
const adminPending = admin1.body.token;

const blockedBeforeCode = await call('/v1/leads/search', { method: 'POST', token: adminPending, body: {} });
check('a half-finished sign-in cannot read data', blockedBeforeCode.status === 401, blockedBeforeCode.body);

const code = codeFrom(lastMail('anna.admin@agroexpo.test'), /sign-in code is:\s*(\d{6})/);
check('the code was emailed', !!code, code);

const admin2 = await call('/v1/auth/code/verify', { method: 'POST', token: adminPending, body: { code } });
check('admin finishes with the code', admin2.body.next === 'done', admin2.body);
const adminToken = admin2.body.token || adminPending;

const adminLeads = await call('/v1/leads/search', { method: 'POST', token: adminToken, body: {} });
check('an admin sees the whole company', adminLeads.body.length > leads.body.length, { admin: adminLeads.body.length, staff: leads.body.length });

const seats = await call('/v1/team/seats', { token: adminToken });
check('seats', seats.body.seats === 10 && seats.body.used === 3, seats.body);

// ---------------------------------------------------------------- the first-time setup
const invited = `smoke.${Date.now()}@agroexpo.test`;
const invite = await call('/v1/team/invite', {
  method: 'POST', token: adminToken,
  body: { email: invited, name: 'Smoke Invitee', role: 'staff', event_ids: [events.body[0].id] },
});
check('invite', invite.status === 201 && /\/signin#setup=/.test(invite.body.setup_link), invite.body);

const setupCode = codeFrom(lastMail(invited), /Your code is:\s*(\d{6})/);
check('the invitation carries a code', !!setupCode, setupCode);

const beforeSetup = await call('/v1/auth/password', {
  method: 'POST', body: { email: invited, password: 'Whatever#2026', door: 'app' },
});
check('an invited person cannot sign in before setting a password',
  beforeSetup.status === 401 && /not set a password/.test(beforeSetup.body.error), beforeSetup.body);

const weak = await call('/v1/auth/password/reset', {
  method: 'POST', body: { email: invited, code: setupCode, password: 'short' },
});
check('the password policy is enforced', weak.status === 400, weak.body);

const setup = await call('/v1/auth/password/reset', {
  method: 'POST', body: { email: invited, code: setupCode, password: 'SmokeStarts#2026' },
});
check('setting the first password', setup.status === 201 && setup.body.ok, setup.body);

const afterSetup = await call('/v1/auth/password', {
  method: 'POST', body: { email: invited, password: 'SmokeStarts#2026', door: 'app' },
});
check('the new account signs in', afterSetup.body.next === 'done', afterSetup.body);

const reused = await call('/v1/auth/password/forgot', { method: 'POST', body: { email: invited } });
check('forgot password answers the same for anyone', reused.status === 201, reused.body);

// ---------------------------------------------------------------- WeTano console
const super1 = await call('/v1/auth/password', {
  method: 'POST', body: { email: 'super@wetano.test', password: 'WetaSnap#2026', door: 'console' },
});
const superCode = codeFrom(lastMail('super@wetano.test'), /sign-in code is:\s*(\d{6})/);
const super2 = await call('/v1/auth/code/verify', { method: 'POST', token: super1.body.token, body: { code: superCode } });
check('WeTano signs in at its own door', super2.body.next === 'done', super2.body);
const superToken = super1.body.token;

const companies = await call('/v1/admin/companies', { token: superToken });
check('the console lists every company', companies.body.length === 2, companies.body?.length);

const usage = await call('/v1/admin/usage', { token: superToken });
check('usage', Array.isArray(usage.body) && usage.body.length === 2, usage.body?.length);

const audit = await call('/v1/admin/audit', { token: superToken });
check('the audit log recorded the sign-ins', audit.body.some((a) => a.action === 'auth.sign_in'), audit.body?.length);

const plans = await call('/v1/admin/plans', { token: superToken });
check('plans', plans.body.length === 3, plans.body?.length);

const inUse = plans.body.find((p) => p.name === 'Growth');
const refused = await call(`/v1/admin/plans/${inUse.id}`, { method: 'DELETE', token: superToken });
check('SUB-01: a plan in use cannot be deleted', refused.status === 409 && /companies are on this plan/.test(refused.body.error), refused.body);

const spare = plans.body.find((p) => p.name === 'Scale');
const deleted = await call(`/v1/admin/plans/${spare.id}`, { method: 'DELETE', token: superToken });
check('a plan nothing uses can be deleted', deleted.status === 200, deleted.body);

// ---------------------------------------------------------------- tenancy
const nordic = await call('/v1/auth/password', {
  method: 'POST', body: { email: 'maja.karlsson@nordicseeds.test', password: 'WetaSnap#2026', door: 'app' },
});
const nordicLeads = await call('/v1/leads/search', { method: 'POST', token: nordic.body.token, body: {} });
const noLeak = nordicLeads.body.every((l) => l.company_id === nordic.body.person.company_id);
check('another company sees none of the first one', noLeak, nordicLeads.body?.length);

const stealing = await call('/v1/leads/sync', {
  method: 'POST', token: nordic.body.token,
  body: {
    id: crypto.randomUUID(), event_id: events.body[0].id, source: 'manual',
    fields: { full_name: { value: 'Nope', by: 'person' } },
  },
});
check('a lead cannot be captured for another company’s event', stealing.status >= 400, stealing.body);

// ---------------------------------------------------------------- sign out
const out = await call('/v1/auth/signout', { method: 'POST', token: staffToken });
const afterOut = await call('/v1/leads/search', { method: 'POST', token: staffToken, body: {} });
check('signing out ends the session', out.status === 201 && afterOut.status === 401, afterOut.body);

console.log(`\n${failures ? `  ${failures} check(s) failed` : '  all checks passed'}\n`);
process.exit(failures ? 1 : 0);
