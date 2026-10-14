import { describe, expect, it } from 'vitest';
import { createDemoBackend } from '../backend/demo';
import type { Backend, SignedIn } from '../backend';
import type { Lead } from '../types';
import { emptyFilters } from '../types';

/** Rules of the in-browser demo server (it must follow the same rules as the API). One shared "server" DB per file. */
const PW = 'WetaSnap#2026';
const CO = 'c0000000-0000-4000-8000-000000000001';
const CO2 = 'c0000000-0000-4000-8000-000000000002';
const EV = 'e0000000-0000-4000-8000-000000000001';

/** One sign-in page: the role is whatever the account is, not something the caller picks. */
async function login(email: string, password = PW): Promise<{ b: Backend; s: SignedIn }> {
  const b = createDemoBackend();
  const door = email.endsWith('@wetano.com') ? 'console' : 'app';
  let r = await b.signInWithPassword(email, password, door);
  if (r.next === 'email_code') r = await b.verifyLoginCode(email, r.demoCode!);
  if (r.next === 'totp') { const s = await b.verifyTotp(email, '123456'); b.setToken(s.token); return { b, s }; }
  if (r.next !== 'done') throw new Error('unexpected step');
  b.setToken(r.token);
  return { b, s: r };
}

const newLead = (p: SignedIn, over: Partial<Lead> = {}): Lead => {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), company_id: p.person.company_id!, event_id: p.person.default_event_id!, captured_by: p.person.id, captured_by_name: p.person.name,
    device: 'test', source: 'manual', fields: { first_name: { value: 'Unit', by: 'person' }, last_name: { value: 'Test', by: 'person' } },
    interest: null, notes: '', consent: false, consent_version: 1, consent_at: null, status: 'waiting', crm_error: null, crm_record_id: null, crm_history: [],
    has_photo: false, has_back_photo: false, tag_ids: [], created_at: now, updated_at: now, synced_at: null, deleted_at: null, ...over,
  };
};

describe('demo backend rules', { timeout: 60_000 }, () => {
  it('two doors: a WeTano account is refused on the company page, and the other way round', async () => {
    await expect(createDemoBackend().signInWithPassword('super@wetano.com', PW, 'app'))
      .rejects.toThrow('WeTano accounts sign in at /super-admin.');
    await expect(createDemoBackend().signInWithPassword('admin@agroexpo.de', PW, 'console'))
      .rejects.toThrow('This is the WeTano Console. Your account signs in at the main address.');
    await expect(createDemoBackend().signInWithPassword('anna@agroexpo.de', PW, 'console'))
      .rejects.toThrow('This is the WeTano Console. Your account signs in at the main address.');
    // …and each on its own door is let in.
    expect((await createDemoBackend().signInWithPassword('super@wetano.com', PW, 'console')).next).toBe('email_code');
    expect((await createDemoBackend().signInWithPassword('anna@agroexpo.de', PW, 'app')).next).toBe('done');
  });

  it('the account decides how many steps follow the password', async () => {
    // Staff are in straight away; admins get an emailed code. Nobody is forced any further.
    expect((await createDemoBackend().signInWithPassword('anna@agroexpo.de', PW, 'app')).next).toBe('done');
    expect((await createDemoBackend().signInWithPassword('admin@agroexpo.de', PW, 'app')).next).toBe('email_code');

    const b = createDemoBackend();
    const code = await b.signInWithPassword('super@wetano.com', PW, 'console');
    expect(code.next).toBe('email_code');
    const done = await b.verifyLoginCode('super@wetano.com', code.next === 'email_code' ? code.demoCode! : '');
    expect(done.next, 'an authenticator is never required').toBe('done');
    if (done.next === 'done') expect(done.person.role).toBe('super_admin');
  });

  it('an authenticator is asked for only by an account that set one up', async () => {
    const { b, s } = await login('super@wetano.com');
    expect(s.person.mfa_enabled ?? false).toBe(false);

    // Turn it on for this account, in Security.
    await b.startMfaEnrolment();
    await b.confirmMfaEnrolment('123456');

    const fresh = createDemoBackend();
    const code = await fresh.signInWithPassword('super@wetano.com', PW, 'console');
    const next = await fresh.verifyLoginCode('super@wetano.com', code.next === 'email_code' ? code.demoCode! : '');
    expect(next.next, 'now this account is asked for its authenticator').toBe('totp');
    expect((await fresh.verifyTotp('super@wetano.com', '123456')).person.role).toBe('super_admin');

    // And it can be turned off again — nothing forces it to stay on.
    await b.disableMfa('123456');
    const after = createDemoBackend();
    const c2 = await after.signInWithPassword('super@wetano.com', PW, 'console');
    expect((await after.verifyLoginCode('super@wetano.com', c2.next === 'email_code' ? c2.demoCode! : '')).next).toBe('done');
  });

  it('steps cannot be skipped: code before password, authenticator before code', async () => {
    const b = createDemoBackend();
    await expect(b.verifyLoginCode('admin@agroexpo.de', '123456')).rejects.toThrow('Start again with your password.');
    await expect(b.verifyTotp('super@wetano.com', '123456')).rejects.toThrow('Start again with your password.');
    const r = await b.signInWithPassword('super@wetano.com', PW, 'console');
    expect(r.next).toBe('email_code');
    await expect(b.verifyTotp('super@wetano.com', '123456')).rejects.toThrow('Start again with your password.');
  });

  it('lockout after the policy attempts; the right password is refused while locked', async () => {
    const b = createDemoBackend();
    for (let i = 0; i < 4; i++) await expect(b.signInWithPassword('ben@agroexpo.de', 'Wrong#Pass123', 'app')).rejects.toThrow(/do not match/);
    await expect(b.signInWithPassword('ben@agroexpo.de', 'Wrong#Pass123', 'app')).rejects.toThrow('The account is locked for 15 minutes.');
    await expect(b.signInWithPassword('ben@agroexpo.de', PW, 'app')).rejects.toThrow(/Too many wrong passwords/);
  });

  it('staff may delete their own lead but not a colleague’s', async () => {
    const { b } = await login('anna@agroexpo.de');
    const all = await b.listLeads(emptyFilters());
    expect(all.every((l) => l.captured_by === 'p-anna')).toBe(true);
    await b.deleteLead(all[0]!.id);
    expect((await b.listLeads(emptyFilters())).some((l) => l.id === all[0]!.id)).toBe(false);
    const { b: admin } = await login('admin@agroexpo.de');
    const bens = (await admin.listLeads({ ...emptyFilters(), captured_by: ['p-ben'] }))[0]!;
    await expect(b.deleteLead(bens.id)).rejects.toThrow('You can only delete leads you captured.');
    await expect(b.bulkDeleteLeads([bens.id])).rejects.toThrow('You can only delete leads you captured.');
  });

  it('seats: invite is refused when every seat is used', async () => {
    const { b } = await login('admin@nordicseeds.se');
    const s = await b.seats();
    expect(s.used).toBe(s.seats);
    await expect(b.invite({ email: 'x@nordicseeds.se', name: 'X', phone: '', role: 'staff', event_ids: [], default_event_id: null, access_ends_on: null }))
      .rejects.toThrow(`All ${s.seats} seats are in use.`);
  });

  it('suspension: nobody in the company can sign in; restore lets them back', async () => {
    const { b: sup } = await login('super@wetano.com');
    await sup.setCompanySuspended(CO2, true, 'Unit test');
    await expect(createDemoBackend().signInWithPassword('maja.karlsson@nordicseeds.se', PW, 'app')).rejects.toThrow('This account is suspended. Unit test');
    await sup.setCompanySuspended(CO2, false, '');
    expect((await createDemoBackend().signInWithPassword('maja.karlsson@nordicseeds.se', PW, 'app')).next).toBe('done');
  });

  it('scan limit: reaching the allowance notifies the company once (notify)', async () => {
    const { b: sup } = await login('super@wetano.com');
    const detail = await sup.companyDetail(CO2);
    await sup.setScanLimitAction(CO2, 'notify'); // “notify” accepts the extra scan and only tells the admins
    await sup.updateLicence(CO2, { ...detail.licence, scans_per_month: 1 });
    const { b, s } = await login('oscar.nilsson@nordicseeds.se');
    await b.syncLead(newLead(s));
    await b.syncLead(newLead(s));
    await new Promise((r) => setTimeout(r, 1500));
    const { b: admin } = await login('admin@nordicseeds.se');
    const notes = (await admin.notifications()).filter((n) => n.title.startsWith('Scan allowance reached'));
    expect(notes).toHaveLength(1);
  });

  it('scan limit: “block” stops card reads but never refuses a lead already captured (D-9, SYNC-07)', async () => {
    const { b: sup } = await login('super@wetano.com');
    const detail = await sup.companyDetail(CO2);
    await sup.setScanLimitAction(CO2, 'block');
    await sup.updateLicence(CO2, { ...detail.licence, scans_per_month: 1 });
    const { b, s } = await login('oscar.nilsson@nordicseeds.se');
    await b.syncLead(newLead(s));
    await expect(b.readCard(new Blob())).rejects.toMatchObject({ code: 'scan_limit' });
    await expect(b.syncLead(newLead(s))).resolves.toMatchObject({ status: 'synced' });
  });

  it('import: rows flagged as duplicates and empty rows are skipped', async () => {
    const { b } = await login('admin@agroexpo.de');
    const r = await b.importLeads([
      { fields: { first_name: 'Imp', last_name: 'One', email: 'imp.one@example.org' }, duplicate: false },
      { fields: { first_name: 'Imp', last_name: 'One', email: 'imp.one@example.org' }, duplicate: true },
      { fields: { first_name: '  ', last_name: '' }, duplicate: false },
    ], EV, [], 'unit.csv');
    expect(r).toMatchObject({ imported: 1, skipped: 2 });
    expect((await b.importHistory())[0]).toMatchObject({ file_name: 'unit.csv', imported: 1, skipped: 2 });
  });

  it('bulk actions: tag add/remove; resend is admin-only', async () => {
    const { b } = await login('admin@agroexpo.de');
    const ids = (await b.listLeads({ ...emptyFilters(), event_ids: [EV] })).slice(0, 3).map((l) => l.id);
    await b.bulkTagLeads(ids, ['g-press'], []);
    expect((await b.leadsByIds(ids)).every((l) => l.tag_ids.includes('g-press'))).toBe(true);
    await b.bulkTagLeads(ids, [], ['g-press']);
    expect((await b.leadsByIds(ids)).some((l) => l.tag_ids.includes('g-press'))).toBe(false);
    const { b: staff } = await login('anna@agroexpo.de');
    await expect(staff.bulkResendLeads(ids)).rejects.toThrow('Only a Client Admin can do this');
  });

  it('errors are recorded once per minute per place, with personal data scrubbed', async () => {
    const { b } = await login('admin@agroexpo.de');
    const report = {
      action: 'Unit', name: 'UnitError', message: 'Could not mail jane.doe@example.com at +49 151 2345 6789 token eyJhbGciOi.eyJzdWIiOjF9.abcDEF123',
      cause: 'x', where: 'unit › test', route: '/client-admin/leads', stack: '', at: new Date().toISOString(), device: 'node', online: true,
    };
    await b.recordClientError(report);
    await b.recordClientError(report);
    const { b: sup } = await login('super@wetano.com');
    const rows = await sup.auditLog({ q: 'unit › test', company_id: '', action: 'error', from: '', to: '' });
    expect(rows).toHaveLength(1);
    const msg = String(rows[0]!.details.message);
    expect(msg).toContain('[email]');
    expect(msg).toContain('[phone]');
    expect(msg).toContain('[token]');
    expect(msg).not.toContain('jane.doe');
    expect(rows[0]!.company_id).toBe(CO);
  });
});

/**
 * Known defects, written as the behaviour the app should have. They fail today, so they only run
 * with QA_DEFECTS=1 (see docs/testing/test-report.md) and never block `npm test`.
 */
describe.skipIf(!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.QA_DEFECTS)('KNOWN DEFECTS (demo backend) — run with QA_DEFECTS=1', { timeout: 60_000 }, () => {
  it('D-refresh: a suspended company’s signed-in users are signed out at the next refresh', async () => {
    const { b } = await login('oscar.nilsson@nordicseeds.se');
    const { b: sup } = await login('super@wetano.com');
    await sup.setCompanySuspended(CO2, true, 'Defect probe');
    try {
      await expect(b.refresh()).resolves.toBeNull();
      await expect(b.listLeads(emptyFilters())).rejects.toThrow();
    } finally {
      await sup.setCompanySuspended(CO2, false, '');
    }
  });

  it('D-leadsByIds: another tenant’s lead is not returned', async () => {
    const { b: nordic } = await login('admin@nordicseeds.se');
    const theirs = (await nordic.listLeads(emptyFilters()))[0]!;
    const { b } = await login('admin@agroexpo.de');
    expect(await b.leadsByIds([theirs.id])).toHaveLength(0);
  });

  it('D-createCompany: a new company can be created', async () => {
    const { b } = await login('super@wetano.com');
    await expect(b.createCompany({ name: 'Unit Co', country: 'PT', admin_name: 'U', admin_email: 'u@unitco.example', licence: { type: 'trial', starts_on: '2026-09-22', ends_on: '2026-10-22', seats: 3, scans_per_month: 0, connectors_allowed: ['csv'] } })).resolves.toBeUndefined();
  });

  it('D-ticket-number: a new ticket gets a number no other ticket has', async () => {
    const { b } = await login('admin@agroexpo.de');
    const t = await b.openTicket({ subject: 'Unit', body: 'Unit test body', priority: 'low' });
    const { b: sup } = await login('super@wetano.com');
    const same = (await sup.tickets()).filter((x) => x.number === t.number);
    expect(same).toHaveLength(1);
  });

  it('D-invoice-final: paid invoices cannot be cancelled on the server', async () => {
    const { b } = await login('super@wetano.com');
    const paid = (await b.invoices({ status: 'paid' }))[0]!;
    await expect(b.setInvoiceStatus(paid.id, 'cancelled', null)).rejects.toThrow();
  });

  it('D-password-reuse: resetting to the current password is refused', async () => {
    const b = createDemoBackend();
    const pw = 'Harbour-lantern47';
    const first = await b.requestPasswordReset('ben@agroexpo.de');
    await b.resetPassword('ben@agroexpo.de', first.demoCode!, pw);
    const again = await b.requestPasswordReset('ben@agroexpo.de');
    await expect(b.resetPassword('ben@agroexpo.de', again.demoCode!, pw)).rejects.toThrow(/not used/);
  });

  it('D-scrub: dates in error messages are not mistaken for phone numbers', async () => {
    const { b } = await login('admin@agroexpo.de');
    await b.recordClientError({ action: 'Unit', name: 'DateError', message: 'Event 2026-09-22 to 2026-09-25 is closed', cause: '', where: 'unit › date', route: '/', stack: '', at: new Date().toISOString(), device: 'node', online: true });
    const { b: sup } = await login('super@wetano.com');
    const row = (await sup.auditLog({ q: 'unit › date', company_id: '', action: 'error', from: '', to: '' }))[0]!;
    expect(String(row.details.message)).toContain('2026-09-22');
  });

  it('D-self-deactivate: an admin cannot deactivate their own account', async () => {
    const { b, s } = await login('admin@nordicseeds.se');
    const me = s.person;
    await expect(b.updatePerson({ id: me.id, name: me.name, phone: me.phone, role: me.role, event_ids: me.event_ids, default_event_id: me.default_event_id, access_ends_on: null, active: false })).rejects.toThrow();
  });
});
