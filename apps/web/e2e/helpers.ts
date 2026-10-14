import { expect, type Locator, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';

export const PW = 'WetaSnap#2026';
/** Which kind of account — and so which door it signs in at. */
export type PortalId = 'staff' | 'client-admin' | 'super-admin';

/** The sign-in page each kind of account uses: WeTano has its own, companies share one. */
export const SIGN_IN: Record<PortalId, string> = {
  staff: '/signin',
  'client-admin': '/signin',
  'super-admin': '/super-admin/signin',
};

/** Where each kind of account lands after signing in. */
export const HOME: Record<PortalId, string> = {
  staff: '/scan',
  'client-admin': '/leads',
  'super-admin': '/super-admin/companies',
};

export const ACC = {
  anna: 'anna@agroexpo.de',
  ben: 'ben@agroexpo.de',
  admin: 'admin@agroexpo.de',
  nordicAdmin: 'admin@nordicseeds.se',
  super: 'super@wetano.com',
  /** Verde Irrigazione staff member, seeded as locked out for 10 minutes. */
  locked: 'luca.ferrari@verdeirrigazione.it',
  /** Polder Tech (suspended company) admin. */
  suspendedAdmin: 'daan.bakker@poldertech.nl',
  terraAdmin: 'carmen.ruiz@terramaquinaria.es',
};

/** Company and object ids from demo.ts / demoData.ts. */
export const IDS = {
  agro: 'c0000000-0000-4000-8000-000000000001',
  nordic: 'c0000000-0000-4000-8000-000000000002',
  terra: 'c0000000-0000-4000-8000-000000000003',
  polder: 'c0000000-0000-4000-8000-000000000005',
  evAgri: 'e0000000-0000-4000-8000-000000000001',
  evFarm: 'e0000000-0000-4000-8000-000000000002',
  evNordic: 'e0000000-0000-4000-8000-000000000003',
};

// ------------------------------------------------------------------ sign-in
export async function fillCode(page: Page, code: string) {
  await page.getByLabel('Digit 1').fill(code);
}

export async function demoCode(page: Page): Promise<string> {
  const b = page.locator('p', { hasText: 'Demo mode — your code is' }).locator('b');
  await expect(b).toHaveText(/^\d{6}$/);
  return (await b.textContent())!.trim();
}

/**
 * Uploads one card and comes back with the review open. A single photo goes through the
 * Scan / adjust screen first (SCAN-02), which is one tap when the corners are already right.
 */
export async function uploadCard(page: Page, files: Parameters<Locator['setInputFiles']>[0]) {
  await page.locator('input[type=file]').first().setInputFiles(files);
  const use = page.getByRole('button', { name: 'Use scan' });
  await use.waitFor({ state: 'visible', timeout: 15_000 });
  await use.click();
  await use.waitFor({ state: 'detached', timeout: 15_000 });
}

/** The code on an invitation confirmation (demo only: there is no email to open). */
export async function invitationCode(scope: Page | Locator): Promise<string> {
  const b = scope.locator('p', { hasText: 'Demo mode — there is no email' }).locator('b');
  await expect(b).toHaveText(/^\d{6}$/);
  return (await b.textContent())!.trim();
}

export async function submitPassword(page: Page, portal: PortalId, email: string, password = PW) {
  // “/signin” is part of “/super-admin/signin”, so compare the whole path, not a fragment.
  if (new URL(page.url()).pathname !== SIGN_IN[portal]) await page.goto(SIGN_IN[portal]);
  await page.locator('#si-email').fill(email);
  await page.locator('#si-pw').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
}

/**
 * Signs in on the one sign-in page and waits for the home screen. `portal` says what kind of
 * account it is, so the helper knows how many steps to expect — the page itself never asks.
 */
export async function signIn(page: Page, portal: PortalId, email: string, password = PW) {
  await page.goto(SIGN_IN[portal]);
  await submitPassword(page, portal, email, password);
  if (portal !== 'staff') {
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await fillCode(page, await demoCode(page));

  }
  await expect(page).toHaveURL(new RegExp(`${HOME[portal]}$`), { timeout: 20_000 });
  await expect(page.locator('main')).toBeVisible();
}

/** Opens the account menu sheet (avatar on phones / staff, name card in the admin sidebar). */
export async function openMenu(page: Page) {
  const avatar = page.getByRole('button', { name: 'Menu' });
  await expect(page.locator('header').first()).toBeVisible(); // the shell has rendered
  if (await avatar.isVisible()) await avatar.click();
  else await page.locator('aside button').last().click();
  const sheet = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Sign out' }) });
  await expect(sheet).toBeVisible();
  return sheet;
}

export async function signOut(page: Page) {
  const sheet = await openMenu(page);
  await sheet.getByRole('button', { name: 'Sign out' }).click();
  const dlg = page.getByRole('dialog').filter({ hasText: /Sign out\?|Leads not sent yet/ });
  await expect(dlg).toBeVisible();
  const yes = dlg.getByRole('button', { name: 'Yes, sign out' });
  if (await yes.isVisible()) await yes.click();
  else await dlg.getByRole('button', { name: 'Sign out anyway and delete them' }).click();
  await expect(page).toHaveURL(/\/signin/);
}

export async function closeSheet(page: Page) {
  await page.keyboard.press('Escape');
}

export async function setSimulatedOffline(page: Page, offline: boolean) {
  const sheet = await openMenu(page);
  const box = sheet.getByRole('checkbox', { name: 'Simulate offline (demo)' });
  if (offline) await box.check(); else await box.uncheck();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
}

export const toast = (page: Page, text: string | RegExp) =>
  page.locator('[aria-live="polite"] > div').filter({ hasText: text });

export async function expectToast(page: Page, text: string | RegExp) {
  await expect(toast(page, text).first()).toBeVisible();
}

// ------------------------------------------------------------------ direct calls into the app's modules
/**
 * Calls a method on the app's own backend instance (same module URL the app imports, so the
 * same signed-in token). Returns { ok, value } or { ok: false, error }.
 */
export async function backendCall<T = unknown>(page: Page, method: string, args: unknown[] = []): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return page.evaluate(async ({ method, args }) => {
    const path = '/src/lib/backend/index.ts';
    const m = await import(/* @vite-ignore */ path);
    const b = await m.backend();
    try {
      const value = await b[method](...args);
      return { ok: true as const, value: JSON.parse(JSON.stringify(value ?? null)) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, { method, args });
}

/** Reads rows straight from the demo "server" database (setup only — never what the UI shows). */
export async function serverRows<T = Record<string, unknown>>(page: Page, store: string, filter?: { key: string; value: unknown }): Promise<T[]> {
  return page.evaluate(async ({ store, filter }) => {
    const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('wetasnap-demo-server-4'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = await new Promise<unknown[]>((res, rej) => {
      const q = db.transaction(store).objectStore(store).getAll();
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
    db.close();
    return (filter ? all.filter((x) => (x as Record<string, unknown>)[filter.key] === filter.value) : all) as never;
  }, { store, filter });
}

export async function deviceRows<T = Record<string, unknown>>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (store) => {
    const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('wetasnap-device'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = await new Promise<unknown[]>((res, rej) => {
      const q = db.transaction(store).objectStore(store).getAll();
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
    db.close();
    return all as never;
  }, store);
}

// ------------------------------------------------------------------ files
/** A small, valid RGB PNG that looks vaguely like a business card (white with dark "text" bars). */
export function cardPng(seed = 1, w = 640, h = 400): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const bar = (y > 60 && y < 90 && x > 40 && x < 360) || (y > 120 && y < 140 && x > 40 && x < 300) ||
        (y > 200 + (seed % 5) * 10 && y < 215 + (seed % 5) * 10 && x > 40 && x < 420) || (y > 300 && y < 320 && x > 40 && x < 260);
      const v = bar ? 30 : 250 - ((x + y + seed * 7) % 5);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = v; raw[o + 1] = v; raw[o + 2] = bar ? 60 : v;
    }
  }
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (~c) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const cardFile = (name: string, seed = 1) => ({ name, mimeType: 'image/png', buffer: cardPng(seed) });

/** The details printed on a generated card, so a test can check what came back off it. */
export interface CardText { first: string; last: string; title: string; company: string; email: string; phone: string; web: string }

export const SAMPLE_CARD: CardText = {
  first: 'Katharina', last: 'Vogel', title: 'Head of Export Sales', company: 'Nordsaat Saatgut GmbH',
  email: 'katharina.vogel@nordsaat.de', phone: '+49 391 55 04 128', web: 'www.nordsaat.de',
};

/**
 * A business card with real printed text, drawn in the page with canvas. Reading is done for real
 * now (Tesseract on the device), so a card of grey bars would have nothing on it to read.
 */
export async function printedCardFile(page: Page, card: CardText = SAMPLE_CARD, name = 'card-front.png') {
  const dataUrl = await page.evaluate((c) => {
    const cv = document.createElement('canvas');
    cv.width = 1050; cv.height = 600;
    const x = cv.getContext('2d')!;
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, cv.width, cv.height);
    x.fillStyle = '#111111';
    x.font = 'bold 40px Arial'; x.fillText(c.company, 70, 110);
    x.font = 'bold 44px Arial'; x.fillText(`${c.first} ${c.last}`, 70, 250);
    x.font = '28px Arial'; x.fillStyle = '#333333';
    x.fillText(c.title, 70, 305);
    let y = 380;
    for (const line of [c.email, c.phone, c.web]) { x.fillText(line, 70, y); y += 46; }
    return cv.toDataURL('image/png');
  }, card);
  return { name, mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1]!, 'base64') };
}

export function csvFile(name: string, rows: string[][]) {
  const text = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');
  return { name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') };
}

// ------------------------------------------------------------------ navigation + sync
/** Clicks the visible navigation link with this label (header, sidebar or bottom bar). */
export async function nav(page: Page, label: string) {
  await page.getByRole('link', { name: label, exact: true }).filter({ visible: true }).first().click();
}

/** In-app route change without a page reload (like clicking a link). */
export async function softNav(page: Page, path: string) {
  await page.evaluate((p) => {
    const a = document.createElement('a');
    a.href = p;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[?]/g, '\\?')}$`));
}

/** Runs the app's outbox sync right now (same as Menu → Sync now). */
export async function syncNow(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/lib/sync.ts';
    const m = await import(/* @vite-ignore */ path);
    await m.syncNow();
  });
}

export const uploadInput = (page: Page) => page.locator('input[type=file][accept="image/*"][multiple]');

// ------------------------------------------------------------------ misc
export const uniq = (p = 'qa') => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** Waits until no spinner is visible inside <main> (data loaded). Never fails the test by itself. */
export async function settle(page: Page, ms = 10_000) {
  // The app-wide loader (lazy screen chunks) sits outside <main>, so wait for that too on screens that have one.
  await page.locator('[data-loading]').first().waitFor({ state: 'detached', timeout: ms }).catch(() => {});
  await page.locator('main .animate-spin').first().waitFor({ state: 'detached', timeout: ms }).catch(() => {});
  await page.waitForTimeout(250);
}

export async function tableRows(scope: Page | Locator) {
  return scope.locator('table tbody tr');
}
