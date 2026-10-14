import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import {
  ACC, IDS, PW, backendCall, demoCode, expectToast, fillCode, invitationCode, nav, openMenu, serverRows, signIn, signOut, softNav,
  submitPassword, syncNow, uniq,
} from './helpers';

const trs = (page: Page) => page.locator('main table tbody tr');
const row = (page: Page, text: string | RegExp) => trs(page).filter({ hasText: text });
const sheetWith = (page: Page, text: string | RegExp) => page.getByRole('dialog').filter({ hasText: text });
const dialog = (page: Page, title: string | RegExp) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title }) });

/** The WeTano Console lives under its own address, so every screen here carries that prefix. */
const console_ = (path: string) => (path.startsWith('/super-admin') ? path : `/super-admin${path}`);

async function asSuper(page: Page, path = '/companies') {
  await signIn(page, 'super-admin', ACC.super);
  if (path !== '/companies') await softNav(page, console_(path));
  await expect(page.locator('main h1')).toBeVisible();
}

async function download(page: Page, click: () => Promise<void>) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: dl.suggestedFilename(), buf: readFileSync(await dl.path()) };
}

// ------------------------------------------------------------------------------------------------ Companies
test.describe('7a · Super Admin · Companies', () => {
  test('list shows plan · cycle, licence type, seats, status', async ({ page }) => {
    await asSuper(page);
    await expect(trs(page)).toHaveCount(6);
    const expectations: [string, string][] = [
      ['Agro Expo Demo GmbH', 'Professional · Annual'], ['Nordic Seeds AB', 'No plan'], ['Terra Maquinaria SL', 'Growth · Monthly'],
      ['Verde Irrigazione S.r.l.', 'Growth · Annual'], ['Polder Tech B.V.', 'Professional · Annual'], ['Kisan Agro Inputs Pvt Ltd', 'Professional · Annual'],
    ];
    for (const [co, plan] of expectations) await expect(row(page, co).locator('td').nth(1)).toContainText(plan);
    await expect(row(page, 'Agro Expo Demo GmbH')).toContainText('4 / 10');
    await expect(row(page, 'Polder Tech B.V.')).toContainText('Suspended');
    await expect(row(page, 'Verde Irrigazione S.r.l.')).toContainText('Grace period');
  });

  test('status filter (incl. Suspended), search and sorting', async ({ page }) => {
    await asSuper(page);
    const filter = page.getByRole('button', { name: 'Filter companies' });
    const pick = async (label: string) => {
      await filter.click();
      await page.getByRole('dialog', { name: 'Filter companies' }).getByRole('button', { name: label, exact: true }).click();
      await page.keyboard.press('Escape');
    };
    await pick('Suspended');
    await expect(trs(page)).toHaveCount(1);
    await expect(row(page, 'Polder Tech B.V.')).toBeVisible();
    await pick('Suspended'); // untick
    await pick('Grace period');
    await expect(trs(page)).toHaveCount(1);
    await expect(row(page, 'Verde')).toBeVisible();
    await pick('Grace period');
    await pick('Expires soon');
    await expect(trs(page)).toHaveCount(2);
    await page.getByRole('button', { name: 'Remove filter' }).click();
    await page.getByRole('searchbox', { name: 'Search companies' }).fill('kisan');
    await expect(trs(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear search' }).click();
    const names = () => trs(page).locator('td:first-child p.font-semibold').allInnerTexts();
    const n1 = await names();
    expect(n1).toEqual([...n1].sort((a, b) => a.localeCompare(b)));
    await page.locator('main thead th').filter({ hasText: 'Company' }).getByRole('button').click();
    await expect(page.locator('main thead th').filter({ hasText: 'Company' })).toHaveAttribute('aria-sort', 'descending');
    expect(await names()).toEqual([...n1].reverse());
    await page.locator('main thead th').filter({ hasText: 'Seats used' }).getByRole('button').click();
    const seats = (await trs(page).locator('td:nth-child(3)').allInnerTexts()).map((s) => Number(s.split('/')[0]));
    expect(seats).toEqual([...seats].sort((a, b) => a - b));
  });

  test('new company with a plan appears with that plan; validation', async ({ page }) => {
    await asSuper(page);
    await page.getByRole('button', { name: 'New company' }).click();
    const sh = sheetWith(page, 'New company');
    await sh.getByRole('button', { name: 'Create & send invite' }).click();
    await expect(sh.getByText('Company name and country are required.')).toBeVisible();
    const name = uniq('QA Farms ');
    await sh.locator('#nc-name').fill(name);
    await sh.locator('#nc-country').fill('Portugal');
    await sh.locator('#nc-an').fill('Rita QA');
    await sh.locator('#nc-ae').fill('rita-at-example');
    await sh.getByRole('button', { name: 'Create & send invite' }).click();
    await expect(sh.getByText('Please enter a valid admin email.')).toBeVisible();
    await sh.locator('#nc-ae').fill(ACC.admin);
    await sh.getByRole('combobox', { name: 'Plan' }).selectOption({ label: 'Growth' });
    await expect(sh.locator('#l-seats')).toHaveValue('10');
    await expect(sh.locator('#l-scans')).toHaveValue('2000');
    await sh.getByRole('button', { name: 'Create & send invite' }).click();
    await expect(sh.getByText('This email already has access.')).toBeVisible();
    const email = `${uniq('rita')}@qafarms.example`;
    await sh.locator('#nc-ae').fill(email);
    await sh.getByRole('button', { name: 'Create & send invite' }).click();
    const err = sh.locator('p.text-red-700');
    await expect(err, 'no error after a valid, new admin email').toHaveCount(0, { timeout: 4_000 });
    await expectToast(page, `${name} created — invitation sent to ${email}`);
    // The new admin is invited like anyone else: a setup code and a link to the setup screen.
    const sent = sheetWith(page, `${name} created`);
    await expect(sent.getByText(`Invitation emailed to ${email}`)).toBeVisible();
    expect(await invitationCode(sent)).toMatch(/^\d{6}$/);
    await expect(sent.getByRole('textbox', { name: 'Setup link' })).toHaveValue(new RegExp(`/signin#setup=${encodeURIComponent(email)}$`));
    await sent.getByRole('button', { name: 'Done' }).click();
    await expect(row(page, name).locator('td').nth(1)).toContainText('Growth · Monthly');
    await expect(row(page, name)).toContainText('Trial');
  });

  test('company detail: plan above the licence type; admins with mailto / tel', async ({ page }) => {
    await asSuper(page);
    await row(page, 'Agro Expo Demo GmbH').getByRole('button', { name: 'Open' }).click();
    const sh = sheetWith(page, 'Company admins');
    const header = sh.locator('header').filter({ hasText: 'licence' }).first();
    await expect(header.locator('p').nth(0)).toHaveText('Professional · Annual');
    await expect(header.locator('p').nth(1)).toHaveText(/annual licence/i);
    await expect(sh.locator('a[href="mailto:admin@agroexpo.de"]')).toBeVisible();
    await expect(sh.locator('a[href="tel:+49 511 9876543"]')).toBeVisible();
    await expect(sh.getByText('Licence history')).toBeVisible();
    await expect(sh.getByText('Annual licence created · 10 seats · unlimited scans')).toBeVisible();
  });

  test('scan-limit action is saved per company', async ({ page }) => {
    await asSuper(page);
    await row(page, 'Agro Expo Demo GmbH').getByRole('button', { name: 'Open' }).click();
    const sh = sheetWith(page, 'When the scan allowance runs out');
    const overage = sh.getByRole('button', { name: /Allow overage/ });
    await expect(sh.getByRole('button', { name: /Notify the company admin only/ })).toHaveAttribute('aria-pressed', 'true');
    await overage.click();
    await expectToast(page, 'Saved — Allow overage — extra scans appear on the invoice');
    await expect(overage).toHaveAttribute('aria-pressed', 'true');
    const co = (await serverRows<{ id: string; scan_limit_action: string }>(page, 'companies')).find((c) => c.id === IDS.agro)!;
    expect(co.scan_limit_action).toBe('overage');
  });

  test('suspend → the company’s admin and staff can no longer sign in → restore', async ({ page }) => {
    await asSuper(page);
    await row(page, 'Nordic Seeds AB').getByRole('button', { name: 'Open' }).click();
    const sh = sheetWith(page, 'Company admins');
    await sh.getByRole('button', { name: 'Suspend company' }).click();
    const dlg = dialog(page, 'Suspend company');
    await expect(dlg.getByRole('button', { name: 'Suspend company' })).toBeDisabled();
    await dlg.locator('#sus-reason').fill('Unpaid QA invoice.');
    await dlg.getByRole('button', { name: 'Suspend company' }).click();
    await expectToast(page, 'Nordic Seeds AB is suspended');
    await expect(sh.getByText('Suspended: Unpaid QA invoice.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(row(page, 'Nordic Seeds AB')).toContainText('Suspended');
    await signOut(page);

    // Admin: refused (after the emailed code).
    await submitPassword(page, 'client-admin', ACC.nordicAdmin);
    // D-28: refused at the password step, before any code is emailed.
    await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveText('This account is suspended. Unpaid QA invoice.');
    // Staff: refused at the password step.
    await submitPassword(page, 'staff', 'maja.karlsson@nordicseeds.se');
    await expect(page.getByRole('alert')).toHaveText('This account is suspended. Unpaid QA invoice.');

    await asSuper(page);
    await row(page, 'Nordic Seeds AB').getByRole('button', { name: 'Open' }).click();
    await sheetWith(page, 'Company admins').getByRole('button', { name: 'Restore company' }).click();
    await dialog(page, 'Restore company').getByRole('button', { name: 'Restore company' }).click();
    await expectToast(page, 'Nordic Seeds AB is active again');
    await page.keyboard.press('Escape');
    await signOut(page);
    await signIn(page, 'client-admin', ACC.nordicAdmin);
  });

  test('suspended company: the admin is refused before an email code is sent', async ({ page }) => {
    await submitPassword(page, 'client-admin', ACC.suspendedAdmin);
    await expect(page.getByRole('alert')).toContainText('suspended', { timeout: 5_000 });
    await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
  });

  test('licence: edit seats and "+1 year" are saved to the history', async ({ page }) => {
    await asSuper(page);
    await row(page, 'Nordic Seeds AB').getByRole('button', { name: 'Open' }).click();
    const sh = sheetWith(page, 'Company admins');
    await sh.locator('#l-seats').fill('5');
    await sh.getByRole('button', { name: '+1 year' }).click();
    await sh.getByRole('button', { name: 'Save licence' }).click();
    await expectToast(page, 'Licence updated');
    await expect(row(page, 'Nordic Seeds AB')).toContainText('3 / 5');
    await row(page, 'Nordic Seeds AB').getByRole('button', { name: 'Open' }).click();
    await expect(sheetWith(page, 'Licence history').getByText(/seats 3 → 5/)).toBeVisible();
  });

  test('scan allowance "Block new scans" actually blocks new scans at the limit', async ({ page }) => {
    await asSuper(page);
    await row(page, 'Nordic Seeds AB').getByRole('button', { name: 'Open' }).click();
    const sh = sheetWith(page, 'Company admins');
    await expect(sh.getByRole('button', { name: /Block new scans/ })).toHaveAttribute('aria-pressed', 'true');
    await sh.locator('#l-scans').fill('1');
    await sh.getByRole('button', { name: 'Save licence' }).click();
    await expectToast(page, 'Licence updated');
    await signOut(page);
    await signIn(page, 'staff', 'maja.karlsson@nordicseeds.se');
    const last = uniq('Blocked');
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.locator('#scan-first_name').fill('Bo');
    await page.locator('#scan-last_name').fill(last);
    await page.getByRole('button', { name: 'Save lead' }).click();
    await syncNow(page);
    await page.waitForTimeout(2_000);
    // SYNC-07: a lead already captured on a phone is never refused — “block” stops card reading and imports instead.
    const accepted = (await serverRows<{ fields: Record<string, { value: string }> }>(page, 'leads')).filter((l) => l.fields.last_name?.value === last);
    expect(accepted, 'a lead typed in by hand is kept even over the limit').toHaveLength(1);
    const read = await backendCall(page, 'readCard', [null]);
    expect(read.ok, 'with "block" and the allowance used up, reading a card must be refused').toBe(false);
    if (!read.ok) expect(read.error).toMatch(/allowance is used up/);
  });
});

// ------------------------------------------------------------------------------------------------ Subscriptions
test.describe('7b · Super Admin · Subscriptions', () => {
  test('plans: delete is refused while a company is on the plan, and hides it instead', async ({ page }) => {
    await asSuper(page, '/subscriptions');
    const growth = page.locator('article').filter({ hasText: 'Growth' }).first();
    await growth.getByRole('button', { name: /^Delete plan/ }).click();
    const dlg = page.getByRole('dialog').filter({ hasText: 'Delete this plan?' });
    await dlg.getByRole('button', { name: 'Delete plan' }).click();
    await expect(dlg.getByRole('alert'), 'it says which companies are on it').toContainText(/companies are on this plan|company is on this plan/);

    // The offer that does work: hide it.
    await dlg.getByRole('button', { name: 'Hide it instead' }).click();
    await expectToast(page, /is hidden/);
    await expect(page.locator('article').filter({ hasText: 'Growth' }).first().getByText('Hidden')).toBeVisible();
  });

  test('plans: a plan nothing uses can be deleted', async ({ page }) => {
    await asSuper(page, '/subscriptions');
    const name = uniq('Plan');
    await page.getByRole('button', { name: 'New plan' }).click();
    const sheet = page.getByRole('dialog').filter({ hasText: /New plan|Edit plan/ });
    await sheet.locator('#p-name').fill(name);
    await sheet.getByRole('button', { name: 'Save plan' }).click();
    await expectToast(page, 'Plan created');

    const card = page.locator('article').filter({ hasText: name }).first();
    await card.getByRole('button', { name: /^Delete plan/ }).click();
    await page.getByRole('dialog').filter({ hasText: 'Delete this plan?' }).getByRole('button', { name: 'Delete plan' }).click();
    await expectToast(page, /deleted/);
    await expect(page.locator('article').filter({ hasText: name })).toHaveCount(0);
  });

  test('plans: create (validation), edit, hide', async ({ page }) => {
    await asSuper(page, '/subscriptions');
    await expect(page.getByRole('tab', { name: 'Plans', selected: true })).toBeVisible();
    await expect(page.locator('main article')).toHaveCount(2);
    await page.getByRole('button', { name: 'New plan' }).click();
    const sh = sheetWith(page, 'Save plan');
    await sh.getByRole('button', { name: 'Save plan' }).click();
    await expect(sh.getByText('The plan needs a name.')).toBeVisible();
    const name = uniq('Starter ');
    await sh.locator('#p-name').fill(name);
    await sh.locator('#p-cur').fill('EU');
    await sh.getByRole('button', { name: 'Save plan' }).click();
    await expect(sh.getByText('Use a 3-letter currency code, e.g. EUR.')).toBeVisible();
    await sh.locator('#p-cur').fill('eur');
    await sh.locator('#p-month').fill('49,50');
    await sh.locator('#p-year').fill('495');
    await sh.locator('#p-seats').fill('3');
    await sh.locator('#p-scans').fill('300');
    await sh.locator('#p-feat').fill('Email support\nOne event at a time');
    await sh.getByRole('button', { name: 'Save plan' }).click();
    await expectToast(page, 'Plan created');
    const card = page.locator('main article').filter({ hasText: name });
    await expect(card).toContainText('€49.50');
    await expect(card).toContainText('One event at a time');
    await card.getByRole('button', { name: 'Edit plan' }).click();
    const edit = sheetWith(page, 'Save plan');
    await edit.locator('#p-month').fill('59');
    await edit.getByRole('switch').first().uncheck({ force: true });
    await edit.getByRole('button', { name: 'Save plan' }).click();
    await expectToast(page, 'Plan created');
    await expect(card).toContainText('€59.00');
    await expect(card).toContainText('Hidden');
    // A hidden plan cannot be picked for a new company.
    await softNav(page, console_('/companies'));
    await page.getByRole('button', { name: 'New company' }).click();
    await expect(sheetWith(page, 'New company').getByRole('combobox', { name: 'Plan' }).locator('option', { hasText: name })).toHaveCount(0);
  });

  test('subscriptions: search, filter, sort, change a plan, export Excel', async ({ page }) => {
    await asSuper(page, '/subscriptions');
    await page.getByRole('tab', { name: 'Subscriptions' }).click();
    await expect(trs(page)).toHaveCount(6);
    await page.getByRole('searchbox', { name: 'Search subscriptions' }).fill('terra');
    await expect(trs(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await page.getByRole('button', { name: 'Filter subscriptions' }).click();
    const panel = page.getByRole('dialog', { name: 'Filter subscriptions' });
    await panel.getByRole('button', { name: 'Monthly', exact: true }).click();
    await panel.getByRole('button', { name: 'Show results' }).click();
    await expect(trs(page)).toHaveCount(2); // Terra (monthly) + Nordic (no plan, monthly)
    await page.getByRole('button', { name: 'Remove filter Monthly' }).click();
    await expect(trs(page)).toHaveCount(6);
    const mrrHeader = page.locator('main thead th').filter({ hasText: 'MRR' });
    await expect(mrrHeader).toHaveAttribute('aria-sort', 'descending');
    await mrrHeader.getByRole('button').click();
    await expect(mrrHeader).toHaveAttribute('aria-sort', 'ascending');
    await expect(trs(page).first()).toContainText('Nordic Seeds AB');
    const f = await download(page, () => page.getByRole('button', { name: 'Export to Excel' }).click());
    expect(f.name).toMatch(/^wetano-subscriptions-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(f.buf.subarray(0, 2).toString()).toBe('PK');
    expect(f.buf.length).toBeGreaterThan(3000);
    await row(page, 'Nordic Seeds AB').click();
    const sh = sheetWith(page, 'Save subscription');
    await sh.getByRole('combobox', { name: 'Plan' }).selectOption({ label: 'Growth' });
    await sh.getByRole('button', { name: 'Save subscription' }).click();
    await expectToast(page, 'Subscription updated');
    await expect(row(page, 'Nordic Seeds AB')).toContainText('Growth');
  });

  test('invoices: search, status filter, download PDF, export Excel', async ({ page }) => {
    await asSuper(page, '/subscriptions');
    await page.getByRole('tab', { name: 'Invoices' }).click();
    await expect(trs(page).first()).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search invoices' }).fill('WS-2026-0011');
    await expect(trs(page)).toHaveCount(1);
    await expect(trs(page).first()).toContainText('Nordic Seeds AB');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await page.getByRole('combobox', { name: 'Invoice status' }).selectOption('overdue');
    for (const t of await trs(page).allInnerTexts()) expect(t).toContain('Overdue');
    await page.getByRole('combobox', { name: 'Invoice status' }).selectOption({ label: 'Suspended' });
    for (const t of await trs(page).allInnerTexts()) expect(t).toContain('Polder Tech');
    await page.getByRole('combobox', { name: 'Invoice status' }).selectOption('');
    const pdf = await download(page, () => trs(page).first().getByRole('button', { name: /Download invoice/ }).click());
    expect(pdf.name).toMatch(/^WS-\d{4}-\d{4}\.pdf$/);
    expect(pdf.buf.subarray(0, 4).toString()).toBe('%PDF');
    const xl = await download(page, () => page.getByRole('button', { name: 'Export to Excel' }).click());
    expect(xl.name).toMatch(/^wetano-invoices-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(xl.buf.length).toBeGreaterThan(5000);
  });

  test('invoices: bulk mark paid and bulk cancel ask for confirmation', async ({ page }) => {
    await asSuper(page, '/subscriptions');
    await page.getByRole('tab', { name: 'Invoices' }).click();
    await page.getByRole('combobox', { name: 'Invoice status' }).selectOption('overdue');
    const n = await trs(page).count();
    expect(n).toBeGreaterThan(2);
    await trs(page).nth(0).getByRole('checkbox').click();
    await trs(page).nth(1).getByRole('checkbox').click();
    await expect(page.getByText('2 selected')).toBeVisible();
    await page.getByRole('button', { name: 'Mark as paid' }).click();
    const paid = dialog(page, 'Mark as paid');
    await paid.locator('#bpd-by').fill('Bank transfer');
    await paid.getByRole('button', { name: 'Mark as paid' }).click();
    await expectToast(page, '2 invoices marked paid');
    await expect(trs(page)).toHaveCount(n - 2);

    const m = await trs(page).count();
    await page.locator('main thead').getByRole('checkbox', { name: 'Select all invoices' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const cancel = dialog(page, 'Cancel invoices?');
    await expect(cancel).toContainText(m === 1 ? '1 invoice will be cancelled.' : `${m} invoices will be cancelled.`);
    await cancel.getByRole('button', { name: 'Keep them' }).click();
    await expect(trs(page)).toHaveCount(m);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog(page, 'Cancel invoices?').getByRole('button', { name: 'Cancel invoices' }).click();
    await expectToast(page, m === 1 ? '1 invoice marked cancelled' : `${m} invoices marked cancelled`);
    await expect(page.getByText('No invoices match')).toBeVisible();
  });

  test('invoice sheet: mark paid; cancel asks first; new invoice gets a unique number', async ({ page }) => {
    await asSuper(page, '/subscriptions');
    await page.getByRole('tab', { name: 'Invoices' }).click();
    await page.getByRole('combobox', { name: 'Invoice status' }).selectOption('sent');
    const number = (await trs(page).first().locator('td').nth(1).innerText()).trim();
    await trs(page).first().click();
    const sh = sheetWith(page, 'Download invoice (PDF)');
    await sh.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog(page, `Cancel invoice ${number}?`).getByRole('button', { name: 'Keep it' }).click();
    await sh.getByRole('button', { name: 'Mark as paid' }).click();
    await dialog(page, 'Mark as paid').getByRole('button', { name: 'Mark as paid' }).click();
    await expectToast(page, `Invoice ${number} is now paid`);
    await expect(sh).toContainText('Paid on');
    await page.keyboard.press('Escape');

    const before = (await serverRows<{ number: string }>(page, 'invoices')).map((i) => i.number);
    expect(before.filter((x, i) => before.indexOf(x) !== i), 'seeded invoice numbers are unique').toEqual([]);
    await page.getByRole('button', { name: 'New invoice' }).click();
    const ni = sheetWith(page, 'Create invoice');
    await ni.getByRole('button', { name: 'Create invoice' }).click();
    await expect(ni.getByText('Pick a company.')).toBeVisible();
    await ni.getByRole('combobox', { name: 'Company' }).selectOption({ label: 'Nordic Seeds AB' });
    await ni.getByRole('combobox', { name: 'Plan' }).selectOption({ label: 'Growth' });
    await expect(ni.locator('#i-amt')).toHaveValue('99.00');
    await ni.getByRole('button', { name: 'Create invoice' }).click();
    await expectToast(page, /Invoice WS-\d{4}-\d{4} created/);
    const all = await serverRows<{ number: string }>(page, 'invoices');
    const nums = all.map((i) => i.number);
    const dups = nums.filter((x, i) => nums.indexOf(x) !== i);
    expect(dups, 'invoice numbers must be unique').toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ Usage
test.describe('7c · Super Admin · Usage', () => {
  test('month picker, meters, status filter', async ({ page }) => {
    await asSuper(page, '/usage');
    await expect(trs(page)).toHaveCount(6);
    await expect(page.locator('main [role=progressbar]').first()).toBeVisible();
    const filter = page.getByRole('button', { name: 'Filter usage' });
    const panel = page.getByRole('dialog', { name: 'Filter usage' });
    await filter.click();
    await panel.getByRole('button', { name: 'Suspended', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(trs(page)).toHaveCount(1);
    await expect(trs(page).first()).toContainText('Polder Tech B.V.');
    await filter.click();
    await panel.getByRole('button', { name: 'Clear all' }).click();
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2);
    const prev = d.toISOString().slice(0, 7);
    await panel.getByLabel('Month', { exact: true }).fill(prev);
    await page.keyboard.press('Escape');
    await expect(page.getByText(new RegExp(`6 companies in ${new Date(`${prev}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long' })}`))).toBeVisible();
  });

  test('usage alerts: create (validation), edit, remove', async ({ page }) => {
    await asSuper(page, '/usage');
    await page.getByRole('tab', { name: 'Usage alerts' }).click();
    const items = page.locator('main ul > li');
    await expect(items).toHaveCount(2);
    await page.getByRole('button', { name: 'New alert' }).click();
    const sh = sheetWith(page, 'Save alert');
    await sh.getByRole('combobox', { name: 'Company' }).selectOption({ label: 'Kisan Agro Inputs Pvt Ltd' });
    await sh.getByRole('button', { name: 'Storage' }).click();
    await sh.locator('#ua-pct').fill('0');
    await sh.getByRole('button', { name: 'Save alert' }).click();
    await expect(sh.getByText('Use a threshold between 1 and 200 per cent.')).toBeVisible();
    await sh.locator('#ua-pct').fill('150');
    await sh.getByRole('button', { name: 'Save alert' }).click();
    await expectToast(page, 'Alert added');
    await expect(items).toHaveCount(3);
    const mine = items.filter({ hasText: 'Kisan Agro Inputs Pvt Ltd at 150% of its storage' });
    await mine.getByRole('button', { name: 'Edit' }).click();
    await sheetWith(page, 'Save alert').locator('#ua-pct').fill('120');
    await sheetWith(page, 'Save alert').getByRole('button', { name: 'Save alert' }).click();
    await expectToast(page, 'Alert saved');
    await items.filter({ hasText: '120%' }).getByRole('button', { name: 'Remove alert' }).click();
    await dialog(page, 'Remove alert').getByRole('button', { name: 'Remove alert' }).click();
    await expectToast(page, 'Alert removed');
    await expect(items).toHaveCount(2);
  });

  test('usage alerts fire: Nordic Seeds uses 3 of 3 seats (≥ 90% seats alert) → WeTano is notified', async ({ page }) => {
    await asSuper(page, '/usage');
    await page.getByRole('tab', { name: 'Usage alerts' }).click();
    await expect(page.locator('main ul > li').filter({ hasText: '90% of its licensed seats' })).toContainText('last sent', { timeout: 5_000 });
  });
});

// ------------------------------------------------------------------------------------------------ Audit log
test.describe('7d · Super Admin · Audit log', () => {
  test('search, company filter, Errors only shows action / message / where', async ({ page }) => {
    await asSuper(page, '/audit');
    const items = page.locator('main ol > li');
    await expect(items.first()).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search the audit log' }).fill('company.create');
    await expect(items.first()).toContainText('Company create');
    const n = await items.count();
    expect(n).toBeGreaterThanOrEqual(6);
    await page.getByRole('searchbox', { name: 'Search the audit log' }).fill('');
    // Let the 200 ms search debounce settle first: a filter picked inside that window is lost (see report).
    await expect(items).not.toHaveCount(n);
    await page.waitForTimeout(500);
    await page.locator('main button[aria-haspopup=dialog]').click();
    const panel = page.getByRole('dialog', { name: 'Filter the audit log' });
    await panel.getByRole('button', { name: 'Errors only' }).click();
    await panel.getByRole('button', { name: 'Show results' }).click();
    await expect(items).toHaveCount(3);
    const kisan = items.filter({ hasText: 'HubSpot returned 429 Too Many Requests' });
    await expect(kisan).toContainText('Error · ActionFailed — Resend leads to the CRM');
    await expect(kisan).toContainText('Where: client admin › leads');
    await kisan.getByRole('button').click();
    const sh = sheetWith(page, 'Details');
    await expect(sh).toContainText('HTTP 429 · rate limit for portal 4420913');
    await expect(sh).toContainText('/leads');
  });

  test('a real app error is recorded with its cause and route, once per minute', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await nav(page, 'Settings');
    await page.getByRole('tab', { name: 'Tags' }).click();
    await page.getByRole('button', { name: 'Add' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'The tag needs a name.');
    await page.getByRole('button', { name: 'Save', exact: true }).click(); // same error again within a minute
    await signOut(page);
    await asSuper(page, '/audit');
    await page.getByRole('searchbox', { name: 'Search the audit log' }).fill('The tag needs a name');
    const items = page.locator('main ol > li');
    await expect(items).toHaveCount(1); // de-duplicated
    await expect(items.first()).toContainText('admin@agroexpo.de');
    await expect(items.first()).toContainText('Error · ActionFailed');
    await expect(items.first()).toContainText('Where: client admin › settings');
    await items.first().getByRole('button').click();
    const sh = sheetWith(page, 'Details');
    await expect(sh).toContainText('The server or a rule refused the action (see the message).');
    await expect(sh).toContainText('/settings');
    await expect(sh).toContainText('Agro Expo Demo GmbH');
  });

  test('a filter picked right after typing in the search box is kept', async ({ page }) => {
    await asSuper(page, '/audit');
    await expect(page.locator('main ol > li').first()).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search the audit log' }).fill('e');
    await page.locator('main button[aria-haspopup=dialog]').click();
    await page.getByRole('dialog', { name: 'Filter the audit log' }).getByRole('button', { name: 'Errors only' }).click();
    await page.waitForTimeout(800);
    await expect(page.getByRole('dialog', { name: 'Filter the audit log' }).getByRole('button', { name: 'Errors only' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('export downloads the list as CSV', async ({ page }) => {
    await asSuper(page, '/audit');
    await expect(page.locator('main ol > li').first()).toBeVisible();
    const f = await download(page, () => page.getByRole('button', { name: 'Export', exact: true }).click());
    expect(f.name).toMatch(/^wetasnap-audit-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(f.buf.toString('utf8')).toContain('"When","Who","Role","Company","Action"');
  });

  test('staff actions are labelled with the Staff role (not Client Admin)', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await nav(page, 'My leads');
    await page.locator('main section li button').filter({ hasText: 'Lukas Schneider' }).first().click();
    await page.getByRole('button', { name: 'Delete lead' }).click();
    await page.getByRole('dialog').filter({ hasText: 'Delete this lead?' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expectToast(page, /Lead deleted/);
    await signOut(page);
    await asSuper(page, '/audit');
    await page.getByRole('searchbox', { name: 'Search the audit log' }).fill('anna@agroexpo.de lead');
    await page.getByRole('searchbox', { name: 'Search the audit log' }).fill('lead.delete');
    const item = page.locator('main ol > li').filter({ hasText: 'anna@agroexpo.de' }).first();
    await expect(item).toBeVisible();
    await expect(item).toContainText('Staff');
  });
});

// ------------------------------------------------------------------------------------------------ Security
test.describe('7e · Security', () => {
  test('policy save persists', async ({ page }) => {
    await asSuper(page, '/security');
    await page.locator('#sp-len').fill('14');
    await expect(page.getByText(/A password like .+ would be accepted\./)).toBeVisible();
    await page.getByRole('button', { name: 'Save security rules' }).click();
    await expectToast(page, 'Security rules saved');
    await page.reload();
    await expect(page.locator('#sp-len')).toHaveValue('14');
  });

  test('change password: wrong current, code, policy errors, success, sign in with it', async ({ page }) => {
    await asSuper(page, '/security');
    await page.getByRole('tab', { name: 'This account' }).click();
    await page.locator('#cp-cur').fill('Wrong#Current1');
    await page.getByRole('button', { name: 'Send confirmation code' }).click();
    await expect(page.getByText('That is not your current password.')).toBeVisible();
    await page.locator('#cp-cur').fill(PW);
    await page.getByRole('button', { name: 'Send confirmation code' }).click();
    const code = (await page.getByText(/Demo mode — your code is \d{6}/).innerText()).match(/\d{6}/)![0];
    await page.locator('#cp-code').fill(code);
    await page.locator('#cp-new').fill('weak');
    await expect(page.getByText('Use at least 12 characters.')).toBeVisible();
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.locator('main p.text-red-700')).toHaveText('Use at least 12 characters.');
    await page.locator('#cp-new').fill('Lighthouse-harbour-92');
    await expect(page.getByText('This password meets every rule.')).toBeVisible();
    await page.getByRole('button', { name: 'Change password' }).click();
    await expectToast(page, 'Password changed');
    await signOut(page);
    await signIn(page, 'super-admin', ACC.super, 'Lighthouse-harbour-92');
  });

  test('MFA enrolment for a client admin → recovery codes → next sign-in asks for the authenticator', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await softNav(page, '/security'); // a company account: no console prefix
    await expect(page.getByRole('tab', { name: 'This account', selected: true })).toBeVisible();
    await page.getByRole('button', { name: 'Set up two-factor' }).click();
    await expect(page.getByText(/otpauth:\/\/totp\/WeTa%20Snap:admin%40agroexpo\.de\?secret=[A-Z2-7]{16}/)).toBeVisible();
    await page.locator('#mfa-code').fill('12345');
    await page.getByRole('button', { name: 'Turn on two-factor' }).click();
    await expect(page.getByText('Enter the 6-digit code from your authenticator app.')).toBeVisible();
    await page.locator('#mfa-code').fill('123456');
    await page.getByRole('button', { name: 'Turn on two-factor' }).click();
    await expectToast(page, 'Two-factor is on');
    await expect(page.getByText('Save these recovery codes now — they are shown once.')).toBeVisible();
    await expect(page.locator('main ul.font-mono li')).toHaveCount(6);
    const f = await download(page, () => page.getByRole('button', { name: 'Download' }).click());
    expect(f.name).toBe('wetasnap-recovery-codes.txt');
    await signOut(page);
    await submitPassword(page, 'client-admin', ACC.admin);
    await fillCode(page, await demoCode(page));
    await expect(page.getByRole('heading', { name: 'Authenticator code' })).toBeVisible();
    await fillCode(page, '654321');
    await expect(page).toHaveURL(/\/leads$/);
  });

  test('devices: list and revoke another session', async ({ page }) => {
    await asSuper(page, '/security');
    await page.getByRole('tab', { name: 'Devices' }).click();
    const items = page.locator('main ul > li');
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText('This device');
    const other = items.filter({ hasText: 'Chennai, IN' });
    await other.getByRole('button', { name: 'Sign out' }).click();
    await dialog(page, 'Sign out this device').getByRole('button', { name: 'Sign it out' }).click();
    await expectToast(page, 'Windows · Edge was signed out');
    await expect(items).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Sign out all other devices' })).toHaveCount(0);
  });

  test('sign-in history shows failed attempts in red', async ({ page }) => {
    await submitPassword(page, 'super-admin', ACC.super, 'Wrong#Pass999');
    await expect(page.getByRole('alert')).toBeVisible();
    await asSuper(page, '/security');
    await page.getByRole('tab', { name: 'Sign-in history' }).click();
    const failed = page.locator('main table tbody tr.bg-red-50\\/60').filter({ hasText: 'super@wetano.com' });
    await expect(failed.filter({ hasText: 'Wrong password' }).first()).toBeVisible();
    await expect(failed.filter({ hasText: 'This device' }).first()).toBeVisible();
  });

  test('Profile → "Active sessions" opens the Devices tab', async ({ page }) => {
    await asSuper(page, '/profile');
    await page.getByRole('link', { name: 'Active sessions' }).click();
    await expect(page.getByRole('tab', { name: 'Devices', selected: true })).toBeVisible();
  });
});

// ------------------------------------------------------------------------------------------------ Support
test.describe('7f · Support', () => {
  test('WeTano: reply, change status, assign', async ({ page }) => {
    await asSuper(page, '/support');
    await page.locator('main li button').filter({ hasText: 'Zoho fields not matching' }).click();
    const thread = page.locator('main .card').filter({ has: page.getByPlaceholder('Write a reply…') });
    await thread.getByPlaceholder('Write a reply…').fill('Please send us a screenshot of the Zoho field list.');
    await thread.getByRole('button', { name: 'Send' }).click();
    await expectToast(page, 'Reply sent');
    await expect(thread.locator('header')).toContainText('Waiting');
    await thread.getByPlaceholder('name@wetano.com').fill('qa@wetano.com');
    await thread.getByRole('button', { name: 'Assign' }).click();
    await expectToast(page, 'Request updated');
    await expect(thread).toContainText('assigned to qa@wetano.com');
    await thread.locator('header select').selectOption('resolved');
    await expect(thread.locator('header')).toContainText('Resolved');
  });

  test('client admin: new request (validation) gets a unique number and shows in the list', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await nav(page, 'Support');
    await page.getByRole('button', { name: 'New request' }).click();
    const sh = sheetWith(page, 'Send request');
    await sh.getByRole('button', { name: 'Send request' }).click();
    await expect(sh.getByText('Give your request a short subject.')).toBeVisible();
    await sh.locator('#sup-subject').fill('QA: export is slow');
    await sh.locator('#sup-body').fill('Exporting 300 leads takes a minute.');
    await sh.getByRole('button', { name: 'High' }).click();
    await sh.getByRole('button', { name: 'Send request' }).click();
    await expectToast(page, /Request SUP-2026-\d{4} sent — we will reply here\./);
    await expect(page.locator('main li button').filter({ hasText: 'QA: export is slow' })).toBeVisible();
    const nums = (await serverRows<{ number: string }>(page, 'tickets')).map((t) => t.number);
    expect(nums.filter((x, i) => nums.indexOf(x) !== i), 'ticket numbers must be unique').toEqual([]);
  });

  test('client admin can close their own request', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await nav(page, 'Support');
    await page.locator('main li button').filter({ hasText: 'Zoho fields not matching' }).click();
    await page.getByRole('button', { name: 'Close this request' }).click();
    await expectToast(page, 'Request updated');
  });

  test('the opening message is shown once in the conversation', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await nav(page, 'Support');
    await page.locator('main li button').filter({ hasText: 'Zoho fields not matching' }).click();
    await expect(page.locator('main article').filter({ hasText: 'Our custom field Product interest does not arrive in Zoho' })).toHaveCount(1);
  });

  test('client admin only sees their own company’s requests', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await nav(page, 'Support');
    await expect(page.locator('main li button')).toHaveCount(1);
    await expect(page.getByText('CRM push failing since this morning')).toHaveCount(0);
  });

  test('menu: WeTano console has Security and Support under "Other pages" on phones', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'super-admin', ACC.super);
    const sheet = await openMenu(page);
    await expect(sheet.getByText('Other pages')).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Security' }).first()).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Support' })).toBeVisible();
  });
});
