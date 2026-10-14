import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { ACC, backendCall, expectToast, invitationCode, nav, signIn, signOut, submitPassword, uniq } from './helpers';

const trs = (page: Page) => page.locator('main table tbody tr');
const row = (page: Page, name: string) => trs(page).filter({ hasText: name });
const filterBtn = (page: Page) => page.getByRole('button', { name: 'Filter people' });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Filter people' });
const dialog = (page: Page, title: string | RegExp) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title }) });

async function openTeam(page: Page, email = ACC.admin) {
  await signIn(page, 'client-admin', email);
  await nav(page, 'Team');
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
  await expect(trs(page).first()).toBeVisible();
}

async function addOpenEvent(page: Page, name: string) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await backendCall(page, 'saveEvent', [{ name, starts_on: today, ends_on: today, venue: 'QA Hall', booth: 'Q2', status: 'open', description: '', time_zone: 'Europe/Berlin', template_id: null, attachments: [] }]);
  expect(r.ok).toBe(true);
  await page.evaluate(async () => { const p = '/src/lib/session.ts'; const m = await import(/* @vite-ignore */ p); await m.pullConfig(); });
}

test.describe('5 · Team', () => {
  test('lists the company’s people with seats used', async ({ page }) => {
    await openTeam(page);
    await expect(trs(page)).toHaveCount(4);
    for (const n of ['Julia Hoffmann', 'Anna Weber', 'Ben Keller', 'Mia Braun']) await expect(row(page, n)).toBeVisible();
    await expect(page.getByText('4 of 10 seats used')).toBeVisible();
    await expect(row(page, 'Mia Braun')).toContainText('invited');
    await expect(row(page, 'Mia Braun')).toContainText('Access until');
  });

  test('filters: role, status, events (with removable chips)', async ({ page }) => {
    await openTeam(page);
    await filterBtn(page).click();
    await panel(page).getByRole('button', { name: 'Admin', exact: true }).click();
    await expect(trs(page)).toHaveCount(1);
    await expect(row(page, 'Julia Hoffmann')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Admin', exact: true }).click();
    await panel(page).getByRole('button', { name: 'invited', exact: true }).click();
    await expect(trs(page)).toHaveCount(1);
    await expect(row(page, 'Mia Braun')).toBeVisible();
    await panel(page).getByRole('button', { name: 'invited', exact: true }).click();
    await panel(page).getByRole('button', { name: 'FarmFair Spring 2026' }).click();
    await page.keyboard.press('Escape');
    await expect(trs(page)).toHaveCount(2); // Julia and Anna work both shows
    await expect(page.getByRole('button', { name: 'Remove filter FarmFair Spring 2026' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove filter FarmFair Spring 2026' }).click();
    await expect(trs(page)).toHaveCount(4);
    await page.getByPlaceholder('Search people').fill('ben');
    await expect(trs(page)).toHaveCount(1);
  });

  test('sorting by name, role, leads captured and status', async ({ page }) => {
    await openTeam(page);
    const names = async () => (await trs(page).locator('td:first-child p.font-semibold').allInnerTexts());
    expect(await names()).toEqual(['Anna Weber', 'Ben Keller', 'Julia Hoffmann', 'Mia Braun']);
    const h = (c: string) => page.locator('main table thead th').filter({ hasText: c }).getByRole('button');
    await h('Name').click();
    expect(await names()).toEqual(['Mia Braun', 'Julia Hoffmann', 'Ben Keller', 'Anna Weber']);
    await h('Role').click();
    expect((await names()).at(-1)).toBe('Julia Hoffmann'); // staff first, admin last
    await h('Leads captured').click();
    const counts = (await trs(page).locator('td:nth-child(4)').allInnerTexts()).map(Number);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    await h('Status').click();
    expect((await names())[0]).toBe('Mia Braun'); // invited ranks below active
  });

  test('invite within the seats', async ({ page }) => {
    await openTeam(page);
    const email = `${uniq('new')}@agroexpo.de`;
    await page.getByRole('button', { name: 'Invite person' }).click();
    const dlg = dialog(page, 'Invite person');
    await dlg.locator('#p-email').fill('not-an-email');
    await dlg.getByRole('button', { name: 'Send invite' }).click();
    await expect(dlg.getByText('Please enter a valid email address.')).toBeVisible();
    await dlg.locator('#p-email').fill(ACC.ben);
    await dlg.getByRole('button', { name: 'Send invite' }).click();
    await expect(dlg.getByText('This person already has access.')).toBeVisible();
    await dlg.locator('#p-email').fill(email);
    await dlg.locator('#p-name').fill('Quinn Tester');
    await dlg.locator('#p-phone').fill('+49 170 5550000');
    await dlg.getByRole('button', { name: 'Send invite' }).click();
    await expectToast(page, `Invitation sent to ${email}`);
    // AUTH-08: what the invitation holds — the setup code and the link to the setup screen.
    const sent = dialog(page, 'Invitation sent');
    await expect(sent.getByText(`Invitation emailed to ${email}`)).toBeVisible();
    expect(await invitationCode(sent)).toMatch(/^\d{6}$/);
    await expect(sent.getByRole('textbox', { name: 'Setup link' })).toHaveValue(new RegExp(`/signin#setup=${encodeURIComponent(email).replace('.', '\\.')}$`));
    await sent.getByRole('button', { name: 'Done' }).click();
    await expect(sent).toHaveCount(0);
    await expect(row(page, 'Quinn Tester')).toContainText('invited');
    await expect(row(page, 'Quinn Tester')).toContainText('+49 170 5550000');
    await expect(page.getByText('5 of 10 seats used')).toBeVisible();
  });

  test('invite is blocked when every seat is used (Nordic Seeds, 3 of 3)', async ({ page }) => {
    await openTeam(page, ACC.nordicAdmin);
    await expect(page.getByText('3 of 3 seats used')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite person' })).toBeDisabled();
    await expect(page.getByText('All seats are in use. Deactivate someone or ask WeTano for more seats.')).toBeVisible();
    const r = await backendCall(page, 'invite', [{ email: 'extra@nordicseeds.se', name: 'Extra', phone: '', role: 'staff', event_ids: [], default_event_id: null, access_ends_on: null }]);
    expect(r).toEqual({ ok: false, error: 'All 3 seats are in use. Deactivate someone or ask WeTano for more seats.' });
  });

  test('reactivating is refused when no seat is free', async ({ page }) => {
    await openTeam(page, ACC.nordicAdmin);
    await row(page, 'Oscar Nilsson').getByRole('button', { name: 'Edit' }).click();
    await dialog(page, /Edit Oscar/).getByRole('button', { name: 'Deactivate' }).click();
    await expectToast(page, 'Oscar Nilsson can no longer sign in');
    await expect(page.getByText('2 of 3 seats used')).toBeVisible();
    await page.getByRole('button', { name: 'Invite person' }).click();
    await dialog(page, 'Invite person').locator('#p-email').fill(`${uniq('fill')}@nordicseeds.se`);
    await dialog(page, 'Invite person').getByRole('button', { name: 'Send invite' }).click();
    await dialog(page, 'Invitation sent').getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('3 of 3 seats used')).toBeVisible();
    await row(page, 'Oscar Nilsson').getByRole('button', { name: 'Edit' }).click();
    const dlg = dialog(page, /Edit Oscar/);
    await dlg.getByRole('button', { name: 'Reactivate' }).click();
    await expect(dlg.getByText('No free seat to reactivate this person.')).toBeVisible();
  });

  test('edit a person: mobile number and several events', async ({ page }) => {
    await openTeam(page);
    await addOpenEvent(page, 'QA Second Show');
    await row(page, 'Ben Keller').getByRole('button', { name: 'Edit' }).click();
    const dlg = dialog(page, 'Edit Ben Keller');
    await expect(dlg.locator('#p-email')).toBeDisabled();
    await dlg.locator('#p-phone').fill('+49 160 9990000');
    await dlg.getByRole('button', { name: /QA Second Show/ }).click();
    await expect(dlg.getByText('Default', { exact: true })).toHaveCount(1);
    await dlg.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'Saved');
    await expect(row(page, 'Ben Keller')).toContainText('+49 160 9990000');
    await expect(row(page, 'Ben Keller')).toContainText('2 events');
  });

  test('deactivate then reactivate; a deactivated person cannot sign in', async ({ page }) => {
    await openTeam(page);
    await row(page, 'Ben Keller').getByRole('button', { name: 'Edit' }).click();
    await dialog(page, 'Edit Ben Keller').getByRole('button', { name: 'Deactivate' }).click();
    await expectToast(page, 'Ben Keller can no longer sign in');
    await expect(row(page, 'Ben Keller')).toContainText('deactivated');
    await expect(page.getByText('3 of 10 seats used')).toBeVisible();

    await signOut(page);
    await submitPassword(page, 'staff', ACC.ben);
    await expect(page.getByRole('alert')).toHaveText('This account can no longer sign in. Ask your admin if you need access again.');

    await openTeam(page);
    await row(page, 'Ben Keller').getByRole('button', { name: 'Edit' }).click();
    await dialog(page, 'Edit Ben Keller').getByRole('button', { name: 'Reactivate' }).click();
    await expectToast(page, 'Saved');
    await expect(row(page, 'Ben Keller')).toContainText('active');
  });

  test('temporary staff: an end date is required and shown', async ({ page }) => {
    await openTeam(page);
    await page.getByRole('button', { name: 'Invite person' }).click();
    const dlg = dialog(page, 'Invite person');
    await dlg.locator('#p-email').fill(`${uniq('temp')}@agroexpo.de`);
    await dlg.locator('#p-name').fill('Tara Temp');
    await dlg.getByText('Temporary staff — access ends on a date').click();
    await dlg.getByRole('button', { name: 'Send invite' }).click();
    await expect(dlg.getByText('Choose the date their access ends.')).toBeVisible();
    const end = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await dlg.locator('#p-end').fill(end);
    await dlg.getByRole('button', { name: 'Send invite' }).click();
    await dialog(page, 'Invitation sent').getByRole('button', { name: 'Done' }).click();
    const [y, m, d] = end.split('-').map(Number);
    await expect(row(page, 'Tara Temp')).toContainText(new RegExp(`Access until 0?${d}/0?${m}/${y}`));
  });

  test('an admin cannot deactivate or demote their own account (lock-out guard)', async ({ page }) => {
    await openTeam(page);
    await row(page, 'Julia Hoffmann').getByRole('button', { name: 'Edit' }).click();
    const dlg = dialog(page, 'Edit Julia Hoffmann');
    // The admin would otherwise lock the company out of its own portal (D-18): no Deactivate, no role change, and it says why.
    await expect(dlg.getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
    await expect(dlg.getByRole('button', { name: /^Staff/ })).toBeDisabled();
    await expect(dlg.getByText(/cannot deactivate it or change its role/)).toBeVisible();
  });
});
