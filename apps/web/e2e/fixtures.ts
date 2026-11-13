import { test as base, expect, type Page } from '@playwright/test';

/**
 * Every test starts from a clean state: the device database, the demo "server" database,
 * localStorage and sessionStorage are wiped on the app's origin before the test navigates.
 * Console errors and uncaught page errors are collected so tests can assert on them.
 */
export interface Diagnostics {
  consoleErrors: string[];
  pageErrors: string[];
}

export async function wipeOrigin(page: Page) {
  // A static file on the same origin: no app code runs, so nothing holds the databases open.
  await page.goto('/logo.png');
  await page.evaluate(async () => {
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    for (const name of ['wetasnap-device', 'wetasnap-demo-server-4']) {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
  });
}

export const test = base.extend<{ diag: Diagnostics }>({
  diag: [async ({ page }, use) => {
    const d: Diagnostics = { consoleErrors: [], pageErrors: [] };
    page.on('console', (m) => { if (m.type() === 'error') d.consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => d.pageErrors.push(`${e.name}: ${e.message}`));
    await wipeOrigin(page);
    await use(d);
  }, { auto: true }],
});

export { expect };
