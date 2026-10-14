import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { ACC, IDS, backendCall, serverRows, signIn } from './helpers';

type Lead = { id: string; company_id: string; captured_by: string; deleted_at: string | null; tag_ids: string[]; fields: Record<string, { value: string; by?: string }> };
const F = { q: '', event_ids: [], captured_by: [], tag_ids: [], status: '', interest: '', from: '', to: '' };

async function nordicLead(page: Page) {
  return (await serverRows<Lead>(page, 'leads', { key: 'company_id', value: IDS.nordic })).find((l) => !l.deleted_at)!;
}
async function benLead(page: Page) {
  return (await serverRows<Lead>(page, 'leads', { key: 'captured_by', value: 'p-ben' })).find((l) => !l.deleted_at)!;
}

test.describe('10 · Tenant isolation (security) — lists and screens', () => {
  test('client admin lists only ever contain their own company', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    const checks: [string, unknown[], (x: Record<string, unknown>) => boolean][] = [
      ['listLeads', [F], (x) => x.company_id === IDS.agro],
      ['people', [], (x) => x.company_id === IDS.agro],
      ['events', [], (x) => x.company_id === IDS.agro],
      ['tags', [], (x) => x.company_id === IDS.agro],
      ['templates', [], (x) => x.company_id === IDS.agro],
      ['invoices', [], (x) => x.company_id === IDS.agro],
      ['tickets', [], (x) => x.company_id === IDS.agro],
      ['importHistory', [], (x) => x.company_id === IDS.agro],
      ['connections', [], (x) => x.company_id === IDS.agro],
      ['notifications', [], (x) => x.company_id === IDS.agro],
    ];
    for (const [m, args, ok] of checks) {
      const r = await backendCall<Record<string, unknown>[]>(page, m, args);
      expect(r.ok, m).toBe(true);
      if (r.ok) {
        expect(r.value.length, `${m} returns rows`).toBeGreaterThan(0);
        expect(r.value.filter((x) => !ok(x)), `${m} leaks other companies`).toEqual([]);
      }
    }
    // Filtering by a foreign event id returns nothing.
    const r = await backendCall<Lead[]>(page, 'listLeads', [{ ...F, event_ids: [IDS.evNordic] }]);
    expect(r.ok && r.value.length).toBe(0);
  });

  test('client admin: WeTano-only calls are refused', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    for (const [m, args] of [
      ['companyDetail', [IDS.nordic]], ['companies', []], ['setCompanySuspended', [IDS.nordic, true, 'x']], ['setScanLimitAction', [IDS.agro, 'overage']],
      ['usage', ['2026-09']], ['usageAlerts', []], ['auditLog', [{ q: '', company_id: '', action: '', from: '', to: '' }]], ['subscriptions', []],
      ['updateLicence', [IDS.agro, { type: 'annual', starts_on: '2026-01-01', ends_on: '2030-01-01', seats: 999, scans_per_month: 0, connectors_allowed: [] }]],
      ['savePlan', [{ name: 'x', description: '', price_month: 0, price_year: 0, currency: 'EUR', seats: 1, scans_per_month: 0, connectors_allowed: [], features: [], active: true }]],
      ['saveSecurityPolicy', [{ min_length: 1 }]], ['licenceHistory', [IDS.nordic]],
    ] as [string, unknown[]][]) {
      const r = await backendCall(page, m, args);
      expect(r, m).toEqual({ ok: false, error: 'Only WeTano Super Admins can do this' });
    }
  });

  test('staff: admin calls are refused; lists show only their own leads', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    for (const m of ['people', 'counters', 'importHistory']) {
      const r = await backendCall(page, m, m === 'counters' ? [IDS.evAgri] : []);
      expect(r, m).toEqual({ ok: false, error: 'Only a Client Admin can do this' });
    }
    const r = await backendCall<Lead[]>(page, 'listLeads', [F]);
    expect(r.ok && r.value.every((l) => l.captured_by === 'p-anna')).toBe(true);
    const del = await backendCall(page, 'deleteLead', [(await benLead(page)).id]);
    expect(del).toEqual({ ok: false, error: 'You can only delete leads you captured.' });
    const bulk = await backendCall(page, 'bulkDeleteLeads', [[(await benLead(page)).id]]);
    expect(bulk.ok).toBe(false);
  });

  test('staff cannot reach admin or console screens by URL; the console never appears for other roles', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    for (const p of ['/leads', '/team', '/settings', '/companies', '/leads', '/audit']) {
      await page.goto(p);
      await expect(page).toHaveURL(/\/scan$/);
      await expect(page.getByRole('link', { name: 'Companies' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Team' })).toHaveCount(0);
    }
    await page.goto('/');
    await expect(page).toHaveURL(/\/scan$/);
  });

  test('client admin: console URLs and another company’s data never render', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    for (const p of ['/companies', '/subscriptions', '/companies', '/audit']) {
      await page.goto(p);
      await expect(page).toHaveURL(/\/leads$/);
    }
    await page.goto('/team');
    await expect(page.locator('main')).not.toContainText('nordicseeds.se');
    await page.goto('/settings?tab=billing');
    await expect(page.locator('main')).not.toContainText('Nordic Seeds');
  });
});

test.describe('10 · Tenant isolation (security) — direct calls that must be refused', () => {
  test('admin: leadsByIds must not return another company’s lead', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    const l = await nordicLead(page);
    const r = await backendCall<Lead[]>(page, 'leadsByIds', [[l.id]]);
    expect(r.ok && r.value.length, 'leadsByIds leaked a Nordic Seeds lead').toBe(0);
  });

  test('staff: leadsByIds must not return a colleague’s lead', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    const l = await benLead(page);
    const r = await backendCall<Lead[]>(page, 'leadsByIds', [[l.id]]);
    expect(r.ok && r.value.length, 'staff read Ben’s lead').toBe(0);
  });

  test('admin: deleteLead / saveLead / bulk actions on another company’s lead are refused', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    const l = await nordicLead(page);
    expect((await backendCall(page, 'deleteLead', [l.id])).ok).toBe(false);
    expect((await backendCall(page, 'saveLead', [{ ...l, notes: 'x' }, false])).ok).toBe(false);
    await backendCall(page, 'bulkDeleteLeads', [[l.id]]);
    await backendCall(page, 'bulkTagLeads', [[l.id], ['g-hot'], []]);
    const after = (await serverRows<Lead>(page, 'leads')).find((x) => x.id === l.id)!;
    expect(after.deleted_at).toBeNull();
    expect(after.tag_ids).not.toContain('g-hot');
  });

  test('admin: syncLead with another company’s lead id must not overwrite or move it', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    const l = await nordicLead(page);
    await backendCall(page, 'syncLead', [{ ...l, company_id: IDS.agro, captured_by: 'p-admin', fields: { ...l.fields, last_name: { value: 'HIJACKED', by: 'person' } } }]);
    const after = (await serverRows<Lead>(page, 'leads')).find((x) => x.id === l.id)!;
    expect(after.company_id, 'lead moved to another tenant').toBe(IDS.nordic);
    expect(after.fields.last_name?.value).not.toBe('HIJACKED');
  });

  test('staff: syncLead cannot take over a colleague’s lead', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    const l = await benLead(page);
    await backendCall(page, 'syncLead', [{ ...l, captured_by: 'p-anna', fields: { ...l.fields, notes: { value: 'mine now', by: 'person' } } }]);
    const after = (await serverRows<Lead>(page, 'leads')).find((x) => x.id === l.id)!;
    expect(after.captured_by, 'Ben’s lead now belongs to Anna').toBe('p-ben');
  });

  test('admin: cannot delete another company’s tag', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await backendCall(page, 'deleteTag', ['g-n-1']);
    expect((await serverRows(page, 'tags')).some((t) => (t as { id: string }).id === 'g-n-1'), 'Nordic tag deleted').toBe(true);
  });

  test('admin: cannot overwrite another company’s event / template / field by id', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await backendCall(page, 'saveEvent', [{ id: IDS.evNordic, name: 'HIJACK', starts_on: '2026-01-01', ends_on: '2026-01-02', venue: '', booth: '', status: 'open', description: '', time_zone: 'UTC', template_id: null, attachments: [] }]);
    await backendCall(page, 'saveTemplate', [{ id: 'tpl-nordic', name: 'HIJACK', description: '', is_default: false }]);
    await backendCall(page, 'deleteField', ['fd-nordic-0']);
    const ev = (await serverRows<{ id: string; company_id: string; name: string }>(page, 'events')).find((e) => e.id === IDS.evNordic)!;
    const tpl = (await serverRows<{ id: string; company_id: string }>(page, 'templates')).find((e) => e.id === 'tpl-nordic')!;
    const fd = (await serverRows<{ id: string }>(page, 'fields')).find((e) => e.id === 'fd-nordic-0');
    expect.soft(ev.company_id, 'event moved to Agro Expo').toBe(IDS.nordic);
    expect.soft(ev.name).toBe('Elmia Lantbruk 2026');
    expect.soft(tpl.company_id, 'template moved to Agro Expo').toBe(IDS.nordic);
    expect.soft(fd, 'Nordic field deleted').toBeTruthy();
  });

  test('admin: cannot change another company’s CRM connection', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await backendCall(page, 'saveConnection', [{ id: 'conn-evil', company_id: IDS.nordic, kind: 'webhook', status: 'connected', record_type: 'JSON', mode: 'auto', account_label: 'https://attacker.example', mapping: {} }]);
    const conns = await serverRows<{ company_id: string }>(page, 'connections', { key: 'company_id', value: IDS.nordic });
    expect(conns, 'a webhook was added to Nordic Seeds by another tenant').toHaveLength(0);
  });

  test('admin: cannot read another company’s sign-in history', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    const r = await backendCall<{ email: string }[]>(page, 'loginHistory', ['p-3-1']); // Terra staff
    const leaked = r.ok ? r.value.filter((x) => !x.email.endsWith('@agroexpo.de')) : [];
    expect(leaked, 'sign-in history of another company').toEqual([]);
  });

  test('admin: cannot lift a suspension or change the scan-limit rule through saveCompany', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await backendCall(page, 'saveCompany', [{ scan_limit_action: 'block', suspended_reason: 'self-set' }]);
    const co = (await serverRows<{ id: string; scan_limit_action: string; suspended_reason: string }>(page, 'companies')).find((c) => c.id === IDS.agro)!;
    expect(co.scan_limit_action, 'scan-limit action is WeTano-controlled').toBe('notify');
    expect(co.suspended_reason).toBe('');
  });

  test('admin: cannot mark another company’s notifications as read', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await backendCall(page, 'markNotificationsRead', [['note-wetano-1']]);
    const n = (await serverRows<{ id: string; read_at: string | null }>(page, 'notes')).find((x) => x.id === 'note-wetano-1')!;
    expect(n.read_at, 'WeTano notification marked read by a client admin').toBeNull();
  });

  test('staff: company billing and support data is not readable', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    for (const m of ['invoices', 'mySubscription', 'tickets', 'connections']) {
      const r = await backendCall<unknown>(page, m, []);
      const leaked = r.ok && (Array.isArray(r.value) ? r.value.length > 0 : r.value !== null);
      expect.soft(leaked, `staff can read ${m}`).toBe(false);
    }
  });
});
