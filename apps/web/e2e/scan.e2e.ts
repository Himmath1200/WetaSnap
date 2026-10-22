import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import {
  ACC, IDS, SAMPLE_CARD, backendCall, cardFile, printedCardFile, deviceRows, expectToast, nav, openMenu, serverRows, setSimulatedOffline, signIn, softNav, syncNow, uniq, uploadInput, uploadCard, } from './helpers';

type Lead = { id: string; status: string; fields: Record<string, { value: string; by?: string }>; tag_ids: string[]; has_back_photo: boolean; company_id: string; captured_by: string; deleted_at: string | null };

const pill = (page: Page) => page.getByRole('status').filter({ visible: true }).first();

async function typeLead(page: Page, first: string, last: string, email?: string) {
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await expect(page.getByText('Review & save')).toBeVisible();
  await page.locator('#scan-first_name').fill(first);
  await page.locator('#scan-last_name').fill(last);
  if (email) await page.locator('#scan-email').fill(email);
}

/** Opens My leads and returns the row button for this lead name. */
async function myLeadRow(page: Page, name: string) {
  await nav(page, 'My leads');
  await expect(page.getByRole('heading', { name: 'My leads' })).toBeVisible();
  return page.locator('main li button').filter({ hasText: name });
}

for (const [who, portal, email, myLeadsPath] of [
  ['staff', 'staff', ACC.anna, '/my-leads'],
  ['client admin', 'client-admin', ACC.admin, '/my-leads'],
] as const) {
  test.describe(`2 · Scanning (${who})`, () => {
    test(`${who}: upload a card → AI review → save → My leads (Synced → In CRM)`, async ({ page }) => {
      await signIn(page, portal, email);
      if (portal === 'client-admin') await softNav(page, '/scan');
      // A card with real printed text: the reader must pull the details off this photo (SCAN-03).
      await uploadCard(page, await printedCardFile(page));
      await expect(page.getByText('Review & save')).toBeVisible();
      await expect(page.getByText(/Read by AI|Read on device/)).toBeVisible({ timeout: 90_000 });
      const first = await page.locator('#scan-first_name').inputValue();
      const last = await page.locator('#scan-last_name').inputValue();
      expect(first, 'the first name was read off the card').toBe(SAMPLE_CARD.first);
      expect(last, 'the last name was read off the card').toBe(SAMPLE_CARD.last);
      expect(await page.locator('#scan-email').inputValue()).toBe(SAMPLE_CARD.email);
      await expect(page.getByAltText('Front of the card')).toBeVisible();
      await page.getByRole('button', { name: 'Save lead' }).click();
      await expectToast(page, 'Lead saved');
      // In-app navigation: the demo "server" runs inside this page, so a reload would cut its CRM push short.
      // (Admins have no "My leads" link in the navigation — reached by URL only, see report.)
      if (portal === 'staff') await nav(page, 'My leads'); else await softNav(page, myLeadsPath);
      await expect(page).toHaveURL(new RegExp(`${myLeadsPath}$`));
      const row = page.locator('main li button').filter({ hasText: `${first} ${last}` }).first();
      await expect(row).toBeVisible();
      await expect(row.getByText(/^(Waiting|Synced|In CRM)$/)).toBeVisible();
      // The server pipeline pushes to Zoho; the next sync brings "In CRM" back.
      await expect.poll(async () => { await syncNow(page); return row.innerText(); }, { timeout: 45_000, intervals: [2_000] }).toContain('In CRM');
      const server = await serverRows<Lead>(page, 'leads', { key: 'company_id', value: IDS.agro });
      const hit = server.find((l) => l.fields.first_name?.value === first && l.fields.last_name?.value === last && l.status === 'in_crm');
      expect(hit, 'lead reached the server and the CRM').toBeTruthy();
    });
  });
}

test.describe('2 · Scanning — auto-capture', () => {
  /**
   * SCAN-01: the shutter fires by itself only for a business card, badge or code that is properly
   * in the frame. A desk, a hand or a blank wall must never trigger it. The scenes are drawn with
   * canvas and put through the same detector the camera loop uses.
   */
  test('fires only for a card, badge or code that fills the frame', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await page.goto('/scan');
    const verdicts = await page.evaluate(async () => {
      const { analyseFrame, placement } = await import('/src/lib/image.ts');
      const W = 160;
      const H = 100;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const x = cv.getContext('2d', { willReadFrequently: true })!;
      const verdict = () => placement(analyseFrame(x.getImageData(0, 0, W, H).data, W, H));
      const out: Record<string, string> = {};

      x.fillStyle = '#fdfdfb'; x.fillRect(0, 0, W, H);
      x.fillStyle = '#1b1b1b'; x.font = 'bold 13px Arial'; x.fillText('Katharina Vogel', 10, 30);
      x.font = '9px Arial';
      x.fillText('Head of Export Sales', 10, 46);
      x.fillText('katharina.vogel@nordsaat.de', 10, 62);
      x.fillText('+49 391 55 04 128', 10, 78);
      out.card = verdict();

      x.fillStyle = '#6b5b4a'; x.fillRect(0, 0, W, H);
      x.fillStyle = '#fdfdfb'; x.fillRect(34, 24, 92, 52);
      x.fillStyle = '#1b1b1b'; x.font = '7px Arial';
      x.fillText('Katharina Vogel', 40, 40);
      x.fillText('nordsaat.de', 40, 54);
      out.cardTooFar = verdict();

      const grain = x.createImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        const v = 70 + ((i * 37) % 120);
        grain.data[i * 4] = v; grain.data[i * 4 + 1] = v - 8; grain.data[i * 4 + 2] = v - 20; grain.data[i * 4 + 3] = 255;
      }
      x.putImageData(grain, 0, 0);
      out.desk = verdict();

      x.fillStyle = '#f2f2f0'; x.fillRect(0, 0, W, H);
      out.blankWall = verdict();

      x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
      x.fillStyle = '#000000';
      for (let by = 14; by < 86; by += 6) {
        for (let bx = 44; bx < 116; bx += 6) if ((bx * 5 + by * 11) % 3) x.fillRect(bx, by, 5, 5);
      }
      out.qrBadge = verdict();
      return out;
    });

    expect(verdicts, 'a card in the frame and a QR badge capture; nothing else does').toEqual({
      card: 'ok',
      qrBadge: 'ok',
      cardTooFar: 'far',
      desk: 'none',
      blankWall: 'blank',
    });
  });
});

test.describe('2 · Scanning (staff)', () => {
  test('required-field and format errors block saving', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Please check: First name, Last name');
    await expect(page.getByText('This field is required')).toHaveCount(2);
    await page.locator('#scan-first_name').fill('Grace');
    await page.locator('#scan-last_name').fill('Hopper');
    await page.locator('#scan-email').fill('grace at navy');
    await page.locator('#scan-website').fill('not a site');
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expect(page.getByText('This does not look like an email address')).toBeVisible();
    await expect(page.getByText('This does not look like a website')).toBeVisible();
    await expect(page.getByText('Review & save')).toBeVisible(); // still on the form
  });

  test('manual entry (Type) with interest, notes and consent is saved and synced', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    const last = uniq('Typed');
    await typeLead(page, 'Ada', last, `ada.${last.toLowerCase()}@example.org`);
    await page.getByRole('button', { name: 'Hot' }).click();
    await page.locator('#scan-notes').fill('Wants the drip irrigation brochure');
    await page.getByRole('checkbox').filter({ visible: true }).last().check();
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Lead saved');
    await expect(page.getByText('Scan a card to start')).toBeVisible(); // ready for the next card
    const row = (await myLeadRow(page, `Ada ${last}`)).first();
    await expect(row).toBeVisible();
    await expect(row.getByText('Hot')).toBeVisible();
    const local = (await deviceRows<Lead & { source: string; consent: boolean; notes: string }>(page, 'leads')).find((l) => l.fields.last_name?.value === last)!;
    expect(local.source).toBe('manual');
    expect(local.consent).toBe(true);
    expect(local.fields.first_name!.by).toBe('person');
  });

  test('several photos at once create one lead each, filled by AI after sync', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await nav(page, 'My leads');
    const count = async () => Number(((await page.locator('main h1 + p').innerText()).match(/(\d+) lead/) ?? [])[1]);
    await expect.poll(count).toBeGreaterThan(0);
    const before = await count();
    await softNav(page, '/scan');
    await uploadInput(page).setInputFiles([
      await printedCardFile(page, { ...SAMPLE_CARD, last: 'Aaltonen' }, 'a.png'),
      await printedCardFile(page, { ...SAMPLE_CARD, last: 'Baumann' }, 'b.png'),
      await printedCardFile(page, { ...SAMPLE_CARD, last: 'Costa' }, 'c.png'),
    ]);
    await expectToast(page, '3 leads saved. They will be read after sync.');
    await nav(page, 'My leads');
    await expect.poll(count).toBe(before + 3);
    // A photo dropped in without review is read afterwards; the names arrive with a later sync.
    await expect.poll(async () => { await syncNow(page); return page.getByText('Unnamed lead').count(); }, { timeout: 60_000, intervals: [3_000] }).toBe(0);
  });

  test('back of the card is captured and shown with the front', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await uploadCard(page, await printedCardFile(page, SAMPLE_CARD, 'front.png'));
    await expect(page.getByText(/Read by AI|Read on device/)).toBeVisible({ timeout: 90_000 });
    const name = `${await page.locator('#scan-first_name').inputValue()} ${await page.locator('#scan-last_name').inputValue()}`;
    await page.getByRole('button', { name: 'Add the back of the card' }).click();
    await expect(page.getByText('Now hold the back of the card in the frame')).toBeVisible();
    await uploadCard(page, cardFile('back.png', 6));
    await expectToast(page, 'Back of the card added');
    await expect(page.getByAltText('Back of the card')).toBeVisible();
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Lead saved');
    const local = (await deviceRows<Lead>(page, 'leads')).filter((l) => `${l.fields.first_name?.value} ${l.fields.last_name?.value}` === name && l.has_back_photo);
    expect(local.length).toBeGreaterThan(0);
    const row = (await myLeadRow(page, name)).first();
    await row.click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByAltText('Front of the card')).toBeVisible();
    await expect(sheet.getByAltText('Back of the card')).toBeVisible();
  });

  test('tags picked while scanning are stored on the lead', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    const last = uniq('Tagged');
    await typeLead(page, 'Tim', last);
    const chip = page.getByRole('button', { name: 'Press', exact: true });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Wants a demo' }).click();
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Lead saved');
    const row = (await myLeadRow(page, `Tim ${last}`)).first();
    await expect(row.getByText('Press')).toBeVisible();
    await expect(row.getByText('Wants a demo')).toBeVisible();
    const l = (await deviceRows<Lead>(page, 'leads')).find((x) => x.fields.last_name?.value === last)!;
    expect(l.tag_ids.sort()).toEqual(['g-demo', 'g-press']);
  });

  test('duplicate warning when the email was already captured at this event (still saveable)', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await typeLead(page, 'Lukas', 'Schneider', 'l.schneider@feldtechnik.de');
    await expect(page.getByText(/This visitor was already captured at this event \(.+\)\. You can still save\./)).toBeVisible();
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Lead saved');
  });

  test('offline capture (Simulate offline) waits on the device, then syncs when back online', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await expect(pill(page)).toHaveAttribute('aria-label', /Online/);
    await setSimulatedOffline(page, true);
    await expect(pill(page)).toHaveAttribute('aria-label', 'Offline');
    const last = uniq('Offline');
    await typeLead(page, 'Olga', last);
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Lead saved');
    await expect(pill(page)).toHaveAttribute('aria-label', 'Offline · 1 waiting');
    const row = (await myLeadRow(page, `Olga ${last}`)).first();
    await expect(row.getByText('Waiting', { exact: true })).toBeVisible();
    await expect(page.getByText('Waiting = on this device')).toBeVisible();
    await setSimulatedOffline(page, false);
    await expect(pill(page)).toHaveAttribute('aria-label', /Online · all synced/, { timeout: 20_000 });
    await expect(row.getByText(/^(Synced|In CRM)$/)).toBeVisible({ timeout: 20_000 });
  });

  test('offline: the card is still read on the device, and syncs when the connection returns', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await setSimulatedOffline(page, true);
    const last = `Vogel${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 5) || 'zxq'}`;
    await uploadCard(page, await printedCardFile(page, { ...SAMPLE_CARD, last }, 'offline.png'));
    // No server, no cloud model: Tesseract on the device fills the form (AI-05).
    await expect(page.getByText('Read on device')).toBeVisible({ timeout: 90_000 });
    expect(await page.locator('#scan-last_name').inputValue()).toBe(last);
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Lead saved');
    await nav(page, 'My leads');
    const row = page.locator('main li button').filter({ hasText: last });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Waiting'); // still only on this device
    await setSimulatedOffline(page, false);
    await expect.poll(async () => { await syncNow(page); return row.innerText(); }, { timeout: 45_000, intervals: [3_000] }).not.toContain('Waiting');
  });

  test('the "n waiting" pill counts unsynced leads (count only below 400 px)', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await signIn(page, 'staff', ACC.anna);
    await setSimulatedOffline(page, true);
    for (const n of [1, 2]) {
      await typeLead(page, 'Pat', uniq('Pill'));
      await page.getByRole('button', { name: 'Save lead' }).click();
      await expectToast(page, 'Lead saved');
      await expect(pill(page)).toHaveAttribute('aria-label', `Offline · ${n} waiting`);
      expect((await pill(page).innerText()).trim()).toBe(String(n)); // only the count is visible below 400 px
    }
    const sheet = await openMenu(page);
    await expect(sheet.getByRole('button', { name: /Sync now/ })).toContainText('2 waiting');
    await expect(sheet.getByRole('button', { name: /Sync now/ })).toBeDisabled(); // offline
  });

  test('never delete unsynced data: an idle sign-out keeps leads that are still only on the device', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await setSimulatedOffline(page, true);
    const last = uniq('Unsynced');
    await typeLead(page, 'Uma', last);
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Lead saved');
    expect((await deviceRows<Lead & { dirty: number }>(page, 'leads')).filter((l) => l.dirty === 1)).toHaveLength(1);
    // Idle for longer than the policy allows.
    await page.evaluate(async () => {
      const path = '/src/lib/session.ts';
      const m = await import(/* @vite-ignore */ path);
      m.session.set({ ...m.session.get(), last_active_at: new Date(Date.now() - 31 * 60_000).toISOString() });
    });
    await expect(page).toHaveURL(/\/signin$/, { timeout: 30_000 });
    const left = (await deviceRows<Lead>(page, 'leads')).filter((l) => l.fields.last_name?.value === last);
    expect(left, 'the unsynced lead must survive the idle sign-out (CLAUDE.md: never delete unsynced data)').toHaveLength(1);
  });

  test('card fields follow the template of the event picked in the menu', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    const today = new Date().toISOString().slice(0, 10);
    const r = await backendCall<{ id: string }>(page, 'saveEvent', [{
      name: 'QA Quick Show', starts_on: today, ends_on: today, venue: 'QA Hall', booth: 'Q1', status: 'open', description: '',
      time_zone: 'Europe/Berlin', template_id: 't0000000-0000-4000-8000-000000000002', attachments: [],
    }]);
    expect(r.ok).toBe(true);
    await page.evaluate(async () => { const p = '/src/lib/session.ts'; const m = await import(/* @vite-ignore */ p); await m.pullConfig(); });
    const sheet = await openMenu(page);
    await sheet.getByRole('button', { name: /QA Quick Show/ }).click();
    await expectToast(page, 'Event changed to QA Quick Show');
    await page.keyboard.press('Escape');
    await softNav(page, '/scan');
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    // "Quick capture" has First name, Last name, Company and Job title only.
    await expect(page.locator('#scan-job_title')).toBeVisible();
    await expect(page.locator('#scan-email'), 'Quick capture template has no Email field').toHaveCount(0);
  });

  test('the staff member is attributed and the device label recorded on the server copy', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    const last = uniq('Attr');
    await typeLead(page, 'Ann', last);
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Lead saved');
    await expect.poll(async () => (await serverRows<Lead>(page, 'leads')).filter((l) => l.fields.last_name?.value === last).length, { timeout: 15_000 }).toBe(1);
    const l = (await serverRows<Lead & { captured_by_name: string; device: string }>(page, 'leads')).find((x) => x.fields.last_name?.value === last)!;
    expect(l.captured_by).toBe('p-anna');
    expect(l.captured_by_name).toBe('Anna Weber');
    expect(l.company_id).toBe(IDS.agro);
    expect(l.device).toMatch(/Windows · Edge/);
  });
});
