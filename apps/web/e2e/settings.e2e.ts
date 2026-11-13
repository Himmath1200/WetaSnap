import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { ACC, IDS, expectToast, nav, serverRows, signIn, uniq } from './helpers';

async function openSettings(page: Page, tab?: string, email = ACC.admin) {
  await signIn(page, 'client-admin', email);
  await nav(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  if (tab) await page.getByRole('tab', { name: tab }).click();
}

/** A connector tile (the first card with this label; the connection editor below is also a .card). */
const card = (page: Page, text: string | RegExp) => page.locator('main .card').filter({ hasText: text }).first();
const dialog = (page: Page, title: string) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title }) });

test.describe('6 · Settings', () => {
  test('tabs keep the URL in step (?tab=…)', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByRole('tab', { name: 'Events', selected: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Tags' }).click();
    await expect(page).toHaveURL(/\/settings\?tab=tags$/);
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Tags', selected: true })).toBeVisible();
  });

  test('events: create with description + time zone + template; validation', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Add' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'Name and dates are required.');
    const name = uniq('Show ');
    await page.locator('#ev-name').fill(name);
    await page.locator('#ev-s').fill('2026-10-10');
    await page.locator('#ev-e').fill('2026-10-08');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'The end date is before the start date.');
    await page.locator('#ev-e').fill('2026-10-12');
    await page.locator('#ev-v').fill('Bombay Exhibition Centre');
    await page.locator('#ev-b').fill('Hall 1 · A7');
    await page.locator('#ev-tz').selectOption('Asia/Kolkata');
    await page.locator('#ev-desc').fill('Ask about drip kits and acreage.');
    await page.locator('#ev-tpl').selectOption({ label: 'Quick capture' });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'Event saved');
    await expect(page.getByText('Edit event')).toBeVisible();
    await expect(page.locator('main li button').filter({ hasText: name })).toContainText('Bombay Exhibition Centre · Hall 1 · A7 · 2026-10-10 → 2026-10-12');
    const ev = (await serverRows<{ name: string; time_zone: string; description: string; template_id: string; company_id: string }>(page, 'events')).find((e) => e.name === name)!;
    expect(ev).toMatchObject({ time_zone: 'Asia/Kolkata', description: 'Ask about drip kits and acreage.', template_id: 't0000000-0000-4000-8000-000000000002', company_id: IDS.agro });
  });

  test('events: attachments add and remove', async ({ page }) => {
    await openSettings(page);
    await page.locator('main li button').filter({ hasText: 'AgriTech Expo 2026' }).click();
    await expect(page.getByText('Edit event')).toBeVisible();
    await page.locator('main .card input[type=file]').setInputFiles({ name: 'price-list.txt', mimeType: 'text/plain', buffer: Buffer.from('Drip kit 40 ha: 12,400 EUR\n'.repeat(80)) });
    await expectToast(page, 'price-list.txt attached');
    const att = page.locator('main .card a[download="price-list.txt"]');
    await expect(att).toBeVisible();
    await expect(page.locator('main li button').filter({ hasText: 'AgriTech Expo 2026' })).toContainText('1');
    await att.locator('xpath=..').getByRole('button', { name: 'Remove' }).click();
    await expect(att).toHaveCount(0);
  });

  test('card fields: templates list, new, duplicate, make default, delete rules', async ({ page }) => {
    await openSettings(page, 'Card fields');
    const chip = (n: string | RegExp) => page.locator('main').getByRole('button', { name: n });
    await expect(chip(/Standard card/)).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(/Quick capture/)).toBeVisible();
    await expect(page.getByText('9 fields · drag to reorder')).toBeVisible();

    // Default template: no Delete offered.
    await expect(page.locator('main').getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // Template in use by an event cannot be deleted.
    await chip(/Quick capture/).click();
    await expect(page.getByText('4 fields · drag to reorder')).toBeVisible();
    await page.locator('main').getByRole('button', { name: 'Delete' }).click();
    await expectToast(page, 'This template is used by 1 event(s). Change those events first.');

    // New template copies the current one.
    const name = uniq('Tpl ');
    await page.getByRole('button', { name: 'New template' }).click();
    await dialog(page, 'New template').locator('#tpl-name').fill(name);
    await dialog(page, 'New template').getByRole('button', { name: 'Save' }).click();
    await expectToast(page, 'Template saved');
    await expect(chip(new RegExp(name))).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('4 fields · drag to reorder')).toBeVisible();

    // Duplicate it.
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(dialog(page, 'New template').locator('#tpl-name')).toHaveValue(`${name} (copy)`);
    await dialog(page, 'New template').getByRole('button', { name: 'Save' }).click();
    await expect(chip(new RegExp(`${name} \\(copy\\)`))).toBeVisible();

    // Make default, then the old default can be deleted? (Standard card is used by AgriTech → refused.)
    await chip(new RegExp(`^${name}\\s*4$`)).click();
    await page.getByRole('button', { name: 'Make default' }).click();
    await expectToast(page, `${name} is now the default`);
    await expect(page.locator('main').getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // An unused, non-default template can be deleted.
    await chip(new RegExp(`${name} \\(copy\\)`)).click();
    await page.locator('main').getByRole('button', { name: 'Delete' }).click();
    await expectToast(page, 'Template removed');
    await expect(chip(new RegExp(`${name} \\(copy\\)`))).toHaveCount(0);
  });

  test('card fields: add a choice field (validation), reorder, remove', async ({ page }) => {
    await openSettings(page, 'Card fields');
    await page.locator('main .card').filter({ hasText: 'drag to reorder' }).getByRole('button', { name: 'Add' }).click();
    await page.locator('#fd-label').fill('Farm size');
    await page.locator('#fd-type').selectOption('choice');
    await page.locator('#fd-opt').fill('Under 10 ha');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'A choice field needs at least two options.');
    await page.locator('#fd-opt').fill('Under 10 ha\n10–100 ha\nOver 100 ha');
    await page.getByRole('button', { name: 'Staff fills it' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'Field saved — used by the AI on the very next scan');
    await expect(page.getByText('10 fields · drag to reorder')).toBeVisible();
    const items = page.locator('main ul li[draggable]');
    await expect(items.last()).toContainText('Farm size');
    await items.last().getByRole('button', { name: 'Move up' }).click();
    await expect(items.nth(8)).toContainText('Farm size');
    await items.nth(8).getByRole('button').first().click();
    await page.getByRole('button', { name: 'Remove' }).click();
    await dialog(page, 'Remove this field?').getByRole('button', { name: 'Remove' }).click();
    await expectToast(page, 'Field removed');
    await expect(page.getByText('9 fields · drag to reorder')).toBeVisible();
  });

  test('tags: create, rename, delete', async ({ page }) => {
    await openSettings(page, 'Tags');
    await expect(page.getByText('4 tags')).toBeVisible();
    await page.getByRole('button', { name: 'Add' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'The tag needs a name.');
    const name = uniq('VIP');
    await page.locator('#tag-name').fill(name);
    await page.getByRole('button', { name: 'purple' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'Tag saved');
    await expect(page.getByText('5 tags')).toBeVisible();
    const li = page.locator('main li').filter({ hasText: name });
    await li.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#tag-name').fill(`${name} renamed`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('main li').filter({ hasText: `${name} renamed` })).toBeVisible();
    await page.locator('main li').filter({ hasText: `${name} renamed` }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('4 tags')).toBeVisible();
  });

  test('CRM: send test lead, edit mapping, disconnect, connect another, webhook needs https', async ({ page }) => {
    await openSettings(page, 'CRM connection');
    await expect(card(page, 'Zoho CRM').first()).toContainText('Connected');
    await page.getByRole('button', { name: 'Send test lead' }).click();
    await expect(page.getByText('Test lead “Test WeTa Snap” created in Zoho CRM.')).toBeVisible();
    const mapRow = page.locator('main table tbody tr').filter({ hasText: 'Job title' });
    await mapRow.locator('input').fill('Title');
    await page.locator('main').getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'CRM settings saved');
    const conn = (await serverRows<{ mapping: Record<string, string> }>(page, 'connections', { key: 'company_id', value: IDS.agro }))[0]!;
    expect(conn.mapping.job_title).toBe('Title');

    await page.getByRole('button', { name: 'Disconnect' }).click();
    await dialog(page, 'Disconnect Zoho CRM?').getByRole('button', { name: 'Disconnect' }).click();
    await expectToast(page, 'Disconnected');
    await card(page, /^HubSpot/).getByRole('button', { name: 'Connect' }).click();
    await expectToast(page, 'HubSpot connected');
    await expect(card(page, /^HubSpot/)).toContainText('Connected');
    await expect(page.locator('#rt')).toHaveValue('Contacts');

    await card(page, /^Webhook/).getByRole('button', { name: 'Connect' }).click();
    const hook = dialog(page, 'Connect a webhook');
    await hook.locator('#hook').fill('http://insecure.example/hook');
    await expect(hook.getByRole('button', { name: 'Connect' })).toBeDisabled();
    await hook.locator('#hook').fill('https://hooks.example.org/wetasnap');
    await hook.getByRole('button', { name: 'Connect' }).click();
    await expectToast(page, 'Webhook connected');
    await expect(card(page, /^HubSpot/)).not.toContainText('Connected'); // one CRM per company
  });

  test('CRM: connectors outside the licence are disabled (Nordic Seeds trial)', async ({ page }) => {
    await openSettings(page, 'CRM connection', ACC.nordicAdmin);
    await expect(card(page, /^Salesforce/).getByRole('button', { name: 'Connect' })).toBeDisabled();
    await expect(card(page, /^Zoho CRM/).getByRole('button', { name: 'Connect' })).toBeDisabled();
    await expect(card(page, /^HubSpot/).getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  test('company: HQ, language, time zone and a consent change bumps the version', async ({ page }) => {
    await openSettings(page, 'Company');
    await expect(page.getByText('currently v1')).toBeVisible();
    await page.locator('#co-hq').fill('Messegelände 1, 30521 Hannover, Germany');
    await page.locator('#co-lang').selectOption('de');
    await page.locator('#co-tz').selectOption('Europe/Vienna');
    await page.locator('#co-consent').fill('I agree that Agro Expo may contact me. (QA v2)');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'Saved — consent text is now version 2');
    await page.reload();
    await expect(page.locator('#co-hq')).toHaveValue('Messegelände 1, 30521 Hannover, Germany');
    await expect(page.locator('#co-lang')).toHaveValue('de');
    await expect(page.locator('#co-tz')).toHaveValue('Europe/Vienna');
    await expect(page.getByText('currently v2')).toBeVisible();
    // Saving again without touching the consent text keeps the version.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'Company settings saved');
  });

  test('Billing & plan shows the plan, seats, allowance and invoices', async ({ page }) => {
    await openSettings(page, 'Billing & plan');
    await expect(page.getByText('Your plan')).toBeVisible();
    await expect(page.locator('main p.title').filter({ hasText: 'Professional' })).toBeVisible();
    await expect(page.getByText(/€2,490\.00\s*\/ year/)).toBeVisible();
    await expect(page.locator('main dl').getByText('4 / 10')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'WS-2026-0007', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ask WeTano' })).toHaveAttribute('href', '/support');
    // Only this company's invoices.
    await expect(page.getByText('Nordic Seeds')).toHaveCount(0);
    await expect(page.getByText('WS-2026-0011')).toHaveCount(0);
    // BILL-04: a company can download its own invoice as a PDF.
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /^Download WS-/ }).first().click(),
    ]);
    expect(dl.suggestedFilename()).toMatch(/^WS-\d{4}-\d{4}\.pdf$/);
    expect(readFileSync(await dl.path()).length).toBeGreaterThan(1000);
  });
});
