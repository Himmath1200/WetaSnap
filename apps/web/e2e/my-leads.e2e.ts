import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { ACC, backendCall, deviceRows, expectToast, nav, serverRows, signIn, softNav } from './helpers';

type Lead = { id: string; status: string; event_id: string; interest: string | null; captured_by: string; tag_ids: string[]; deleted_at: string | null; fields: Record<string, { value: string }> };

const rows = (page: Page) => page.locator('main section li button');
const filterBtn = (page: Page) => page.getByRole('button', { name: 'Filter leads' });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Filter leads' });

async function openMyLeads(page: Page) {
  await signIn(page, 'staff', ACC.anna);
  await nav(page, 'My leads');
  await expect(page.getByRole('heading', { name: 'My leads' })).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
  // Wait until the server copy of this person's leads has been brought down.
  await expect.poll(async () => (await deviceRows(page, 'leads')).length).toBeGreaterThan(10);
}

async function openLead(page: Page, name: string) {
  await rows(page).filter({ hasText: name }).first().click();
  const sheet = page.getByRole('dialog').filter({ hasText: name });
  await expect(sheet).toBeVisible();
  return sheet;
}

test.describe('3 · My leads (staff)', () => {
  test('shows only the signed-in person’s leads (never a colleague’s)', async ({ page }) => {
    await openMyLeads(page);
    const device = await deviceRows<Lead>(page, 'leads');
    expect(device.every((l) => l.captured_by === 'p-anna')).toBe(true);
    const server = await backendCall<Lead[]>(page, 'listLeads', [{ q: '', event_ids: [], captured_by: [], tag_ids: [], status: '', interest: '', from: '', to: '' }]);
    expect(server.ok).toBe(true);
    if (server.ok) expect(server.value.every((l) => l.captured_by === 'p-anna')).toBe(true);
    const all = await serverRows<Lead>(page, 'leads', { key: 'captured_by', value: 'p-anna' });
    const visible = all.filter((l) => !l.deleted_at).length;
    await expect(page.locator('main h1 + p')).toContainText(`${visible} leads`);
  });

  test('search matches name, company and email; no-match message', async ({ page }) => {
    await openMyLeads(page);
    const search = page.getByRole('searchbox', { name: 'Search leads' });
    await search.fill('feldtechnik');
    await expect(rows(page).filter({ hasText: 'Lukas Schneider' }).first()).toBeVisible();
    // Search covers every field (email, website, notes …), not only what the row shows.
    const device = (await deviceRows<Lead & { notes: string }>(page, 'leads')).filter((l) => !l.deleted_at);
    const hits = device.filter((l) => [...Object.values(l.fields).map((f) => f.value), l.notes].join(' ').toLowerCase().includes('feldtechnik'));
    await expect(rows(page)).toHaveCount(hits.length);
    await search.fill('zzqqxx');
    await expect(page.getByText('No leads match')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(rows(page).first()).toBeVisible();
  });

  test('every filter: events (multi), tags, status, interest, dates; chips remove filters', async ({ page }) => {
    await openMyLeads(page);
    const device = (await deviceRows<Lead>(page, 'leads')).filter((l) => !l.deleted_at);

    await filterBtn(page).click();
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('button', { name: /FarmFair Spring 2026/ }).click();
    await panel(page).getByRole('button', { name: 'Show results' }).click();
    await expect(filterBtn(page)).toContainText('1');
    const farm = device.filter((l) => l.event_id === 'e0000000-0000-4000-8000-000000000002').length;
    await expect(rows(page)).toHaveCount(farm);

    // Multi-select: both events.
    await filterBtn(page).click();
    await panel(page).getByRole('button', { name: /AgriTech Expo 2026/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Remove filter AgriTech Expo 2026' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove filter FarmFair Spring 2026' })).toBeVisible();
    await expect(rows(page)).toHaveCount(device.length);
    await page.getByRole('button', { name: 'Clear all' }).click();

    // Tags.
    await filterBtn(page).click();
    await panel(page).getByRole('button', { name: 'Distributor' }).click();
    await page.keyboard.press('Escape');
    const dist = device.filter((l) => l.tag_ids.includes('g-dist')).length;
    await expect(rows(page)).toHaveCount(dist);
    for (const t of await rows(page).allInnerTexts()) expect(t).toContain('Distributor');
    await page.getByRole('button', { name: 'Remove filter Distributor' }).click();

    // Status.
    await filterBtn(page).click();
    await panel(page).getByRole('button', { name: 'Check', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(rows(page)).toHaveCount(device.filter((l) => l.status === 'check').length);
    await page.getByRole('button', { name: 'Remove filter Check' }).click();

    // Interest.
    await filterBtn(page).click();
    await panel(page).getByRole('button', { name: 'Hot', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(rows(page)).toHaveCount(device.filter((l) => l.interest === 'hot').length);
    await page.getByRole('button', { name: 'Remove filter Hot' }).click();

    // Dates.
    for (const [label, days] of [['Today', 0], ['Last 7 days', 6], ['Last 30 days', 29]] as const) {
      await filterBtn(page).click();
      await panel(page).getByRole('button', { name: label, exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: `Remove filter ${label}` })).toBeVisible();
      const expected = await page.evaluate(({ days }) => {
        const from = new Date(new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00').getTime();
        return from;
      }, { days });
      const n = (await deviceRows<Lead & { created_at: string }>(page, 'leads')).filter((l) => !l.deleted_at && new Date(l.created_at).getTime() >= expected && (days > 0 || new Date(l.created_at).getTime() <= new Date(new Date().toISOString().slice(0, 10) + 'T23:59:59.999').getTime())).length;
      if (n === 0) await expect(page.getByText('No leads match')).toBeVisible();
      else await expect(rows(page)).toHaveCount(n);
      await page.getByRole('button', { name: `Remove filter ${label}` }).click();
    }
    await expect(filterBtn(page)).not.toContainText(/\d/);
  });

  test('"n need a fix" filters to leads the CRM rejected', async ({ page }) => {
    await openMyLeads(page);
    const fix = page.getByRole('button', { name: /need a fix/ });
    await expect(fix).toBeVisible();
    const n = Number((await fix.innerText()).match(/\d+/)![0]);
    await fix.click();
    await expect(rows(page)).toHaveCount(n);
    for (const t of await rows(page).allInnerTexts()) expect(t).toContain('Check');
  });

  test('preview opens read-only; tap-to-call / mail / web links have the right href', async ({ page }) => {
    await openMyLeads(page);
    const sheet = await openLead(page, 'Lukas Schneider');
    await expect(sheet.getByRole('textbox')).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(sheet.locator('a[href^="tel:"]')).toHaveAttribute('href', 'tel:+4915123456789');
    await expect(sheet.locator('a[href^="mailto:"]')).toHaveAttribute('href', 'mailto:l.schneider@feldtechnik.de');
    const web = sheet.locator('a[href^="https://feldtechnik"]');
    await expect(web).toHaveAttribute('href', 'https://feldtechnik.de');
    await expect(web).toHaveAttribute('target', '_blank');
    await expect(sheet.getByText('Captured by')).toBeVisible();
    await expect(sheet.getByText('Delivery history')).toHaveCount(0); // admin-only section
  });

  test('Edit → Save updates the lead and the preview shows the new value', async ({ page }) => {
    await openMyLeads(page);
    const sheet = await openLead(page, 'Lukas Schneider');
    await sheet.getByRole('button', { name: 'Edit' }).click();
    await expect(sheet.locator('#detail-job_title')).toBeVisible();
    await sheet.locator('#detail-job_title').fill('Chief Buyer QA');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'Saved — the lead will be re-sent as an update');
    const local = (await deviceRows<Lead>(page, 'leads')).find((l) => l.fields.last_name?.value === 'Schneider' && l.fields.first_name?.value === 'Lukas' && l.fields.job_title?.value === 'Chief Buyer QA');
    expect(local, 'saved on the device').toBeTruthy();
    // Back in preview mode, the sheet should show what was just saved.
    await expect(sheet.getByText('Chief Buyer QA'), 'preview shows the saved value without reopening').toBeVisible();
  });

  test('Save to device downloads a .vcf contact card', async ({ page }) => {
    await openMyLeads(page);
    const sheet = await openLead(page, 'Lukas Schneider');
    const [dl] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: 'Save to device' }).click()]);
    expect(dl.suggestedFilename()).toMatch(/\.vcf$/);
    const text = readFileSync(await dl.path(), 'utf8');
    expect(text).toContain('BEGIN:VCARD');
    expect(text).toContain('FN:Lukas Schneider');
    expect(text).toContain('EMAIL;TYPE=WORK:l.schneider@feldtechnik.de');
    expect(text).toContain('TEL;TYPE=CELL:+49 151 23456789');
  });

  test('staff can delete their own lead; it disappears and is soft-deleted on the server', async ({ page }) => {
    await openMyLeads(page);
    const before = await rows(page).count();
    const sheet = await openLead(page, 'Lukas Schneider');
    await sheet.getByRole('button', { name: 'Delete lead' }).click();
    const dlg = page.getByRole('dialog').filter({ hasText: 'Delete this lead?' });
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toBeHidden();
    await sheet.getByRole('button', { name: 'Delete lead' }).click();
    await page.getByRole('dialog').filter({ hasText: 'Delete this lead?' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expectToast(page, 'Lead deleted. Your admin can restore it for 30 days.');
    await expect(rows(page)).toHaveCount(before - 1);
    await expect(rows(page).filter({ hasText: 'Lukas Schneider' })).toHaveCount(0);
    const srv = (await serverRows<Lead>(page, 'leads')).find((l) => l.fields.email?.value === 'l.schneider@feldtechnik.de')!;
    expect(srv.deleted_at).not.toBeNull();
  });

  test('a lead that never left the phone is removed from the device only', async ({ page }) => {
    await openMyLeads(page);
    await softNav(page, '/scan');
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    // Offline so it stays on the device.
    await page.evaluate(async () => { const p = '/src/lib/net.ts'; const m = await import(/* @vite-ignore */ p); m.net.set((s: object) => ({ ...s, simulatedOffline: true })); });
    await page.locator('#scan-first_name').fill('Local');
    await page.locator('#scan-last_name').fill('Only');
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Lead saved');
    await nav(page, 'My leads');
    const sheet = await openLead(page, 'Local Only');
    await sheet.getByRole('button', { name: 'Delete lead' }).click();
    await page.getByRole('dialog').filter({ hasText: 'Delete this lead?' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expectToast(page, 'Lead deleted from this device.');
    expect((await deviceRows<Lead>(page, 'leads')).filter((l) => l.fields.last_name?.value === 'Only')).toHaveLength(0);
  });
});
