import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { ACC, IDS, csvFile, expectToast, serverRows, signIn, uniq } from './helpers';

type Lead = {
  id: string; status: string; event_id: string; interest: string | null; captured_by: string; captured_by_name: string; tag_ids: string[];
  deleted_at: string | null; created_at: string; notes: string; crm_error: string | null; fields: Record<string, { value: string }>;
};

const trs = (page: Page) => page.locator('main table tbody tr');
const filterBtn = (page: Page) => page.getByRole('button', { name: 'Filter leads' });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Filter leads' });
const tick = (page: Page, i: number) => trs(page).nth(i).getByRole('checkbox');
const selectAll = (page: Page) => page.locator('main table thead').getByRole('checkbox', { name: 'Select all leads' });

async function companyLeads(page: Page) {
  return (await serverRows<Lead>(page, 'leads', { key: 'company_id', value: IDS.agro })).filter((l) => !l.deleted_at);
}

async function openLeads(page: Page) {
  await signIn(page, 'client-admin', ACC.admin);
  await expect(trs(page).first()).toBeVisible();
}

const name = (l: Lead) => [l.fields.first_name?.value, l.fields.last_name?.value].filter(Boolean).join(' ');

test.describe('4 · Leads (client admin)', () => {
  test('counters match the company’s data', async ({ page }) => {
    await openLeads(page);
    const all = await companyLeads(page);
    const today = new Date().toISOString().slice(0, 10);
    const counter = (label: string) => page.locator('main .card').filter({ hasText: label }).locator('p').nth(1);
    await expect(counter('Leads in this event')).toHaveText(String(all.filter((l) => l.event_id === IDS.evAgri).length));
    await expect(counter('Today')).toHaveText(String(all.filter((l) => l.created_at.slice(0, 10) === today).length));
    await expect(counter('Failed to send')).toHaveText(String(all.filter((l) => l.status === 'check').length));
    await expect(trs(page)).toHaveCount(all.filter((l) => l.event_id === IDS.evAgri).length); // current event pre-selected
    await expect(page.getByRole('button', { name: 'Remove filter AgriTech Expo 2026' })).toBeVisible();
  });

  test('search across name, company, email, notes and who captured it', async ({ page }) => {
    await openLeads(page);
    await page.getByRole('searchbox', { name: 'Search leads' }).fill('schneider');
    const all = (await companyLeads(page)).filter((l) => l.event_id === IDS.evAgri);
    const hits = all.filter((l) => [...Object.values(l.fields).map((f) => f.value), l.notes, l.captured_by_name].join(' ').toLowerCase().includes('schneider'));
    await expect(trs(page)).toHaveCount(hits.length);
    await expect(trs(page).filter({ hasText: 'Lukas Schneider' }).first()).toBeVisible();
  });

  test('multi-select filters: events, captured by, tags; chips remove them', async ({ page }) => {
    await openLeads(page);
    const all = await companyLeads(page);
    await filterBtn(page).click();
    await panel(page).getByRole('button', { name: /FarmFair Spring 2026/ }).click();
    await expect(trs(page)).toHaveCount(all.length); // both events = everything
    await panel(page).getByRole('button', { name: 'Anna Weber' }).click();
    await panel(page).getByRole('button', { name: 'Ben Keller' }).click();
    await expect(trs(page)).toHaveCount(all.filter((l) => ['p-anna', 'p-ben'].includes(l.captured_by)).length);
    await panel(page).getByRole('button', { name: 'Press' }).click();
    await panel(page).getByRole('button', { name: 'Distributor' }).click();
    const expected = all.filter((l) => ['p-anna', 'p-ben'].includes(l.captured_by) && l.tag_ids.some((t) => ['g-press', 'g-dist'].includes(t)));
    await panel(page).getByRole('button', { name: 'Show results' }).click();
    await expect(trs(page)).toHaveCount(expected.length);
    await expect(filterBtn(page)).toContainText('6');
    for (const c of ['AgriTech Expo 2026', 'FarmFair Spring 2026', 'By Anna Weber', 'By Ben Keller', 'Press', 'Distributor']) {
      await expect(page.getByRole('button', { name: `Remove filter ${c}` })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Remove filter Press' }).click();
    await expect(trs(page)).toHaveCount(all.filter((l) => ['p-anna', 'p-ben'].includes(l.captured_by) && l.tag_ids.includes('g-dist')).length);
    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(trs(page)).toHaveCount(all.length);
  });

  test('status, interest and Last 7 / 30 days filters', async ({ page }) => {
    await openLeads(page);
    const all = (await companyLeads(page)).filter((l) => l.event_id === IDS.evAgri);
    await filterBtn(page).click();
    await panel(page).getByRole('button', { name: 'In CRM', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Warm', exact: true }).click();
    await expect(trs(page)).toHaveCount(all.filter((l) => l.status === 'in_crm' && l.interest === 'warm').length);
    await panel(page).getByRole('button', { name: 'Any', exact: true }).first().click(); // status: any
    await panel(page).getByRole('button', { name: 'Any', exact: true }).nth(1).click(); // interest: any
    await expect(trs(page)).toHaveCount(all.length);
    const since = (d: number) => new Date(new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00').getTime();
    await panel(page).getByRole('button', { name: 'Last 7 days' }).click();
    await expect(trs(page)).toHaveCount(all.filter((l) => new Date(l.created_at).getTime() >= since(6)).length);
    await panel(page).getByRole('button', { name: 'Last 30 days' }).click();
    await expect(trs(page)).toHaveCount(all.filter((l) => new Date(l.created_at).getTime() >= since(29)).length);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Remove filter Last 30 days' })).toBeVisible();
  });

  test('"Failed to send" counter filters to Check', async ({ page }) => {
    await openLeads(page);
    await page.locator('main button').filter({ hasText: 'Failed to send' }).click();
    await expect(page.getByRole('button', { name: 'Remove filter Check' })).toBeVisible();
    const n = await trs(page).count();
    expect(n).toBeGreaterThan(0);
    for (const t of await trs(page).allInnerTexts()) expect(t).toContain('Check');
  });

  const columns: [string, number, (a: string, b: string) => number][] = [
    ['Name', 1, (a, b) => a.localeCompare(b)],
    ['Company', 2, (a, b) => a.localeCompare(b)],
    ['Captured by', 3, (a, b) => a.localeCompare(b)],
  ];
  for (const [col, idx, cmp] of columns) {
    test(`sorting by ${col} (ascending then descending)`, async ({ page }) => {
      await openLeads(page);
      const header = page.locator('main table thead th').filter({ hasText: col });
      await header.getByRole('button').click();
      await expect(header).toHaveAttribute('aria-sort', 'ascending');
      const firstLine = async () => (await trs(page).locator(`td:nth-child(${idx + 1})`).allInnerTexts()).map((t) => t.split('\n')[0]!.trim().toLowerCase());
      let vals = await firstLine();
      expect(vals).toEqual([...vals].sort(cmp));
      await header.getByRole('button').click();
      await expect(header).toHaveAttribute('aria-sort', 'descending');
      vals = await firstLine();
      expect(vals).toEqual([...vals].sort(cmp).reverse());
    });
  }

  test('sorting by Interest, CRM status and Time', async ({ page }) => {
    await openLeads(page);
    const rank = { Hot: 3, Warm: 2, Cold: 1, '—': 0 } as Record<string, number>;
    const st = { Waiting: 0, Synced: 1, 'In CRM': 2, Check: 3 } as Record<string, number>;
    const read = async (i: number) => (await trs(page).locator(`td:nth-child(${i})`).allInnerTexts()).map((t) => t.trim());
    const h = (c: string) => page.locator('main table thead th').filter({ hasText: c });
    await h('Interest').getByRole('button').click();
    let v = (await read(5)).map((x) => rank[x] ?? 0);
    expect(v).toEqual([...v].sort((a, b) => a - b));
    await h('CRM status').getByRole('button').click();
    await h('CRM status').getByRole('button').click();
    await expect(h('CRM status')).toHaveAttribute('aria-sort', 'descending');
    v = (await read(6)).map((x) => st[x]!);
    expect(v).toEqual([...v].sort((a, b) => b - a));
    await expect(h('Time')).toHaveAttribute('aria-sort', 'none');
    await h('Time').getByRole('button').click();
    await expect(h('Time')).toHaveAttribute('aria-sort', 'ascending');
  });

  test('bulk selection: select all, indeterminate, clear', async ({ page }) => {
    await openLeads(page);
    const n = await trs(page).count();
    await selectAll(page).click();
    await expect(selectAll(page)).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(`${n} selected`)).toBeVisible();
    await tick(page, 0).click();
    await expect(selectAll(page)).toHaveAttribute('aria-checked', 'mixed');
    await expect(page.getByText(`${n - 1} selected`)).toBeVisible();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(selectAll(page)).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
  });

  test('bulk tag add and remove', async ({ page }) => {
    await openLeads(page);
    // Filter to leads without the Press tag … by ticking three rows that do not have it.
    const texts = await trs(page).allInnerTexts();
    const idx = texts.map((t, i) => (t.includes('Press') ? -1 : i)).filter((i) => i >= 0).slice(0, 3);
    const names = [];
    for (const i of idx) { await tick(page, i).click(); names.push(await trs(page).nth(i).locator('td:nth-child(2) p').first().innerText()); }
    await expect(page.getByText('3 selected')).toBeVisible();
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByRole('button', { name: 'Press', exact: true }).last().click();
    await expectToast(page, 'Tag added to 3 leads');
    const pressed = async () => (await trs(page).allInnerTexts()).filter((t) => names.some((n) => t.includes(n)) && t.includes('Press')).length;
    await expect.poll(pressed).toBe(3);
    await page.getByRole('button', { name: 'Remove tag' }).click();
    await page.getByRole('button', { name: 'Press', exact: true }).last().click();
    await expectToast(page, 'Tag removed from 3 leads');
    await expect.poll(pressed).toBe(0);
  });

  test('bulk resend to the CRM', async ({ page }) => {
    await openLeads(page);
    await page.locator('main button').filter({ hasText: 'Failed to send' }).click();
    const n = await trs(page).count();
    await selectAll(page).click();
    await page.getByRole('button', { name: 'Resend to CRM' }).click();
    await expectToast(page, `${n} leads queued for the CRM`);
  });

  test('bulk delete asks first, then removes the rows', async ({ page }) => {
    await openLeads(page);
    const before = await trs(page).count();
    const names = [await trs(page).nth(0).locator('td:nth-child(2) p').first().innerText(), await trs(page).nth(1).locator('td:nth-child(2) p').first().innerText()];
    await tick(page, 0).click();
    await tick(page, 1).click();
    await page.locator('main').getByRole('button', { name: 'Delete', exact: true }).click();
    const dlg = page.getByRole('dialog').filter({ hasText: 'Delete leads?' });
    await expect(dlg).toContainText('2 leads will be deleted.');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(trs(page)).toHaveCount(before);
    await page.locator('main').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').filter({ hasText: 'Delete leads?' }).getByRole('button', { name: 'Delete' }).click();
    await expectToast(page, '2 leads deleted');
    await expect(trs(page)).toHaveCount(before - 2);
    const srv = await serverRows<Lead>(page, 'leads', { key: 'company_id', value: IDS.agro });
    for (const nm of names) expect(srv.filter((l) => name(l) === nm && !l.deleted_at).length).toBeLessThan(srv.filter((l) => name(l) === nm).length);
  });

  for (const [label, ext, magic] of [['Excel (.xlsx)', 'xlsx', 'PK'], ['CSV', 'csv', '﻿'], ['PDF', 'pdf', '%PDF']] as const) {
    test(`export ${ext}: a real file of the right type`, async ({ page }) => {
      await openLeads(page);
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: new RegExp(label.replace(/[().]/g, '\\$&')) }).click()]);
      expect(dl.suggestedFilename()).toMatch(new RegExp(`^wetasnap-leads-\\d{4}-\\d{2}-\\d{2}\\.${ext}$`));
      const buf = readFileSync(await dl.path());
      expect(buf.length).toBeGreaterThan(ext === 'csv' ? 1000 : 3000);
      expect(buf.toString(ext === 'csv' ? 'utf8' : 'latin1').startsWith(magic)).toBe(true);
      if (ext === 'csv') {
        const lines = buf.toString('utf8').trim().split('\r\n');
        expect(lines[0]).toContain('First name');
        expect(lines.length - 1).toBe(await trs(page).count());
      }
      await expectToast(page, /Export ready — \d+ leads/);
    });
  }

  test('export selected rows only (CSV)', async ({ page }) => {
    await openLeads(page);
    for (const i of [0, 1, 2]) await tick(page, i).click();
    await page.getByRole('button', { name: 'Export selected' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /CSV/ }).click()]);
    const lines = readFileSync(await dl.path(), 'utf8').trim().split('\r\n');
    expect(lines).toHaveLength(4);
    await expectToast(page, 'Export ready — 3 leads');
  });

  test('import wizard: upload CSV, map columns, duplicates skipped, success, history, view imported', async ({ page }) => {
    await openLeads(page);
    const tag = uniq('Imp');
    const file = `${tag}.csv`;
    await page.getByRole('button', { name: /Import/ }).first().click();
    const sheet = page.getByRole('dialog').filter({ hasText: 'Import leads' });
    await sheet.locator('input[type=file]').setInputFiles(csvFile(file, [
      ['First name', 'Surname', 'Company', 'E-mail', 'Mobile', 'Unmapped column'],
      ['Ines', `${tag}A`, 'Imported GmbH', `ines.${tag}@imported.example`, '+49 170 1111111', 'x'],
      ['Jonas', `${tag}B`, 'Imported GmbH', `jonas.${tag}@imported.example`, '+49 170 2222222', 'x'],
      ['Karla', `${tag}C`, 'Imported GmbH', `karla.${tag}@imported.example`, '+49 170 3333333', 'x'],
      ['Lukas', 'Schneider', 'Feldtechnik GmbH', 'l.schneider@feldtechnik.de', '', 'dup of an existing lead'],
      ['Ines', `${tag}A`, 'Imported GmbH', `ines.${tag}@imported.example`, '', 'dup inside the file'],
    ]));
    await expect(sheet.getByText(file)).toBeVisible();
    await expect(sheet.getByText('5 rows', { exact: true })).toBeVisible();
    // Column matching: Surname → Last name (alias), E-mail → Email, Mobile → Phone.
    await expect(sheet.locator('select').nth(2)).toHaveValue('Surname');
    await expect(sheet.getByText('2 rows look like leads you already have — they will be skipped.')).toBeVisible();
    await sheet.getByRole('button', { name: 'Press', exact: true }).click();
    await sheet.getByRole('button', { name: 'Import 3 leads' }).click();
    await expect(sheet.getByText('3 leads imported')).toBeVisible();
    await expect(sheet.getByText('2 rows skipped as duplicates.')).toBeVisible();
    await sheet.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('searchbox', { name: 'Search leads' }).fill(tag);
    await expect(trs(page)).toHaveCount(3);

    // History → view imported leads.
    await page.getByRole('searchbox', { name: 'Search leads' }).fill('');
    await page.getByRole('button', { name: 'Import history' }).click();
    const hist = page.getByRole('dialog').filter({ hasText: 'Import history' });
    const item = hist.getByRole('button').filter({ hasText: file });
    await expect(item).toContainText('3 imported');
    await expect(item).toContainText('2 skipped');
    await expect(hist.getByText('hannover-organiser-list.xlsx')).toBeVisible();
    await item.click();
    await expect(page.getByText(`Imported from ${file}`)).toBeVisible(); // D-23: filtered by the import itself
    const shown = await trs(page).allInnerTexts();
    expect(shown.filter((t) => t.includes(tag))).toHaveLength(3);
    expect(shown.length, '"View imported leads" should show only what the file brought in').toBe(3);
  });

  test('imported leads are sent to the CRM like any other lead', async ({ page }) => {
    await openLeads(page);
    const tag = uniq('Crm');
    await page.getByRole('button', { name: /Import/ }).first().click();
    const sheet = page.getByRole('dialog').filter({ hasText: 'Import leads' });
    await sheet.locator('input[type=file]').setInputFiles(csvFile(`${tag}.csv`, [['First name', 'Last name', 'Email'], ['Nora', tag, `nora.${tag}@example.org`]]));
    await sheet.getByRole('button', { name: 'Import 1 lead' }).click();
    await expect(sheet.getByText('1 lead imported')).toBeVisible();
    await expect.poll(async () => (await serverRows<Lead>(page, 'leads')).find((l) => l.fields.last_name?.value === tag)?.status, { timeout: 15_000 })
      .toBe('in_crm');
  });

  test('import duplicate check covers the whole company, not only the filtered list', async ({ page }) => {
    await openLeads(page);
    await page.locator('main button').filter({ hasText: 'Failed to send' }).click(); // list now shows only "Check"
    await expect(page.getByRole('button', { name: 'Remove filter Check' })).toBeVisible();
    await page.getByRole('button', { name: /Import/ }).first().click();
    const sheet = page.getByRole('dialog').filter({ hasText: 'Import leads' });
    await sheet.locator('input[type=file]').setInputFiles(csvFile('dup.csv', [['First name', 'Last name', 'Email'], ['Lukas', 'Schneider', 'l.schneider@feldtechnik.de']]));
    await expect(sheet.getByText('1 row looks like a lead you already have — it will be skipped.')).toBeVisible();
  });

  test('lead panel: preview → Edit → Save & resend', async ({ page }) => {
    await openLeads(page);
    await trs(page).filter({ hasText: 'Lukas Schneider' }).first().click();
    const sheet = page.getByRole('dialog').filter({ hasText: 'Lukas Schneider' });
    await expect(sheet.getByText('Delivery history')).toBeVisible();
    await expect(sheet.getByRole('textbox')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Edit' }).click();
    await sheet.locator('#detail-job_title').fill('Head of QA Purchasing');
    await sheet.getByRole('button', { name: 'Save & resend' }).click();
    await expectToast(page, 'Saved and re-sent to the CRM');
    await expect(sheet).toBeHidden();
    await expect.poll(async () => {
      const l = (await serverRows<Lead>(page, 'leads')).find((x) => x.fields.email?.value === 'l.schneider@feldtechnik.de');
      return `${l?.fields.job_title?.value}|${l?.status}`;
    }, { timeout: 15_000 }).toBe('Head of QA Purchasing|in_crm');
  });

  test('fixing a rejected lead clears the Check status', async ({ page }) => {
    await openLeads(page);
    await page.locator('main button').filter({ hasText: 'Failed to send' }).click();
    const row = trs(page).filter({ hasText: 'Lucía Fernández' });
    await row.click();
    const sheet = page.getByRole('dialog').filter({ hasText: 'Lucía Fernández' });
    await expect(sheet.getByText('Zoho CRM rejected the email address')).toBeVisible();
    await sheet.getByRole('button', { name: 'Edit' }).click();
    await expect(sheet.getByText('This does not look like an email address')).toBeVisible();
    await sheet.locator('#detail-email').fill('lucia@cultivosibericos.es');
    await sheet.getByRole('button', { name: 'Save & resend' }).click();
    await expectToast(page, 'Saved and re-sent to the CRM');
    await expect.poll(async () => (await serverRows<Lead>(page, 'leads')).find((x) => x.fields.email?.value === 'lucia@cultivosibericos.es')?.status, { timeout: 15_000 }).toBe('in_crm');
    await page.reload();
    await page.locator('main button').filter({ hasText: 'Failed to send' }).click();
    await expect(trs(page).filter({ hasText: 'Lucía Fernández' })).toHaveCount(0);
  });

  test('admins have a way to reach "My leads" from the navigation', async ({ page }) => {
    await openLeads(page);
    await expect(page.getByRole('link', { name: 'My leads' }).filter({ visible: true })).not.toHaveCount(0);
  });
});
