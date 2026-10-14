import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { ACC, demoCode, fillCode, openMenu, settle, signIn, submitPassword, type PortalId, printedCardFile } from './helpers';

/**
 * 11 · Responsive & visual. Every screen of every kind of account at 360×740, 390×844, 768×1024 and
 * 1366×768, light and dark: no horizontal page overflow, nothing hidden under the phone bottom bar,
 * touch targets ≥ 40 px, no console errors, and an axe-core colour-contrast check. Full-page
 * screenshots at 390 (phone) and 1366 (laptop) go to docs/testing/screens/<portal>/.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../../docs/testing');
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const VIEWPORTS = [
  { id: '360', w: 360, h: 740, shot: null },
  { id: '390', w: 390, h: 844, shot: 'phone' },
  { id: '768', w: 768, h: 1024, shot: null },
  { id: '1366', w: 1366, h: 768, shot: 'laptop' },
] as const;
const THEMES = ['light', 'dark'] as const;

type Portal = 'public' | PortalId;
interface State { name: string; path?: string; open?: (page: Page) => Promise<void>; dialog?: boolean }

const firstRow = (page: Page) => page.locator('main table tbody tr, main ul.divide-y > li > button, main ol > li > button').filter({ visible: true }).first();
const clickRow = async (page: Page) => { await firstRow(page).click(); await page.waitForTimeout(400); };
const tab = (name: string) => async (page: Page) => { await page.getByRole('tab', { name }).click(); await settle(page); };
const btn = (name: string | RegExp) => async (page: Page) => { await page.getByRole('button', { name }).filter({ visible: true }).first().click(); await page.waitForTimeout(400); };

const SCREENS: Record<Portal, State[]> = {
  public: [
    { name: 'signin', path: '/signin' },
    { name: 'signin-emailed-code', path: '/signin', open: async (p) => { await submitPassword(p, 'client-admin', ACC.admin); await demoCode(p); } },
    { name: 'signin-setup', path: '/signin#setup=mia.hostess%40gmail.com' },
    { name: 'signin-forgot', path: '/signin', open: btn('Set or reset password') },
    { name: 'signin-reset', path: '/signin', open: async (p) => { await p.getByRole('button', { name: 'Set or reset password' }).click(); await p.locator('#fp-email').fill(ACC.ben); await p.getByRole('button', { name: 'Send the code' }).click(); await demoCode(p); } },
  ],
  staff: [
    { name: 'scan', path: '/scan' },
    { name: 'scan-review', path: '/scan', open: async (p) => {
      await p.locator('input[type=file]').first().setInputFiles(await printedCardFile(p));
      await p.getByText('Review & save').waitFor({ timeout: 15_000 });
    } },
    { name: 'my-leads', path: '/my-leads' },
    { name: 'my-leads-filters', path: '/my-leads', open: btn('Filter leads'), dialog: true },
    { name: 'lead-preview', path: '/my-leads', open: clickRow, dialog: true },
    { name: 'lead-edit', path: '/my-leads', open: async (p) => { await clickRow(p); await p.getByRole('dialog').getByRole('button', { name: 'Edit' }).click(); }, dialog: true },
    { name: 'security', path: '/security' },
    { name: 'security-devices', path: '/security', open: tab('Devices') },
    { name: 'profile', path: '/profile' },
    { name: 'menu', path: '/scan', open: async (p) => { await openMenu(p); }, dialog: true },
    { name: 'notifications', path: '/my-leads', open: btn(/^Notifications/), dialog: true },
    { name: 'signout-dialog', path: '/profile', open: async (p) => { await p.locator('main').getByRole('button', { name: 'Sign out' }).click(); }, dialog: true },
  ],
  'client-admin': [
    { name: 'leads', path: '/leads' },
    { name: 'leads-filters', path: '/leads', open: btn('Filter leads'), dialog: true },
    { name: 'lead-preview', path: '/leads', open: clickRow, dialog: true },
    { name: 'lead-edit', path: '/leads', open: async (p) => { await clickRow(p); await p.getByRole('dialog').getByRole('button', { name: 'Edit' }).click(); }, dialog: true },
    { name: 'import', path: '/leads', open: btn(/Import leads from Excel|^Import$/), dialog: true },
    { name: 'import-history', path: '/leads', open: btn('Import history'), dialog: true },
    { name: 'scan', path: '/scan' },
    { name: 'my-leads', path: '/my-leads' },
    { name: 'team', path: '/team' },
    { name: 'invite-dialog', path: '/team', open: btn('Invite person'), dialog: true },
    { name: 'invite-sent', path: '/team', open: async (p) => {
      await btn('Invite person')(p);
      const dlg = p.getByRole('dialog');
      await dlg.locator('#p-email').fill(`visual-${Date.now()}@agroexpo.de`);
      await dlg.locator('#p-name').fill('Vera Visual');
      await dlg.getByRole('button', { name: 'Send invite' }).click();
      await p.getByRole('heading', { name: 'Invitation sent' }).waitFor();
    }, dialog: true },
    { name: 'settings-events', path: '/settings?tab=events' },
    { name: 'settings-fields', path: '/settings?tab=fields' },
    { name: 'settings-tags', path: '/settings?tab=tags' },
    { name: 'settings-crm', path: '/settings?tab=crm' },
    { name: 'settings-company', path: '/settings?tab=company' },
    { name: 'settings-billing', path: '/settings?tab=billing' },
    { name: 'support', path: '/support' },
    { name: 'support-new-request', path: '/support', open: btn('New request'), dialog: true },
    { name: 'security', path: '/security' },
    { name: 'profile', path: '/profile' },
    { name: 'notifications', path: '/team', open: btn(/^Notifications/), dialog: true },
    { name: 'menu', path: '/team', open: async (p) => { await openMenu(p); }, dialog: true },
  ],
  'super-admin': [
    { name: 'companies', path: '/super-admin/companies' },
    { name: 'new-company', path: '/super-admin/companies', open: btn('New company'), dialog: true },
    { name: 'company-detail', path: '/super-admin/companies', open: async (p) => { const open = p.locator('main table tbody tr').filter({ visible: true }).first().getByRole('button', { name: 'Open' }); if (await open.count()) await open.click(); else await clickRow(p); }, dialog: true },
    { name: 'subscriptions-plans', path: '/super-admin/subscriptions' },
    { name: 'subscriptions-subs', path: '/super-admin/subscriptions', open: tab('Subscriptions') },
    { name: 'subscriptions-invoices', path: '/super-admin/subscriptions', open: tab('Invoices') },
    { name: 'invoice-sheet', path: '/super-admin/subscriptions', open: async (p) => { await tab('Invoices')(p); await clickRow(p); }, dialog: true },
    { name: 'new-invoice', path: '/super-admin/subscriptions', open: async (p) => { await tab('Invoices')(p); await btn('New invoice')(p); }, dialog: true },
    { name: 'usage', path: '/super-admin/usage' },
    { name: 'usage-alerts', path: '/super-admin/usage', open: tab('Usage alerts') },
    { name: 'audit', path: '/super-admin/audit' },
    { name: 'audit-detail', path: '/super-admin/audit', open: clickRow, dialog: true },
    { name: 'security-policy', path: '/super-admin/security' },
    { name: 'security-account', path: '/super-admin/security', open: tab('This account') },
    { name: 'security-devices', path: '/super-admin/security', open: tab('Devices') },
    { name: 'security-history', path: '/super-admin/security', open: tab('Sign-in history') },
    { name: 'support', path: '/super-admin/support' },
    { name: 'profile', path: '/super-admin/profile' },
    { name: 'notifications', path: '/super-admin/usage', open: btn(/^Notifications/), dialog: true },
    { name: 'menu', path: '/super-admin/usage', open: async (p) => { await openMenu(p); }, dialog: true },
  ],
};

const ACCOUNT: Record<PortalId, string> = { staff: ACC.anna, 'client-admin': ACC.admin, 'super-admin': ACC.super };

interface Finding {
  screen: string;
  overflow: { scrollWidth: number; innerWidth: number; culprits: string[] } | null;
  navOverlap: string[];
  smallTargets: { el: string; w: number; h: number }[];
  consoleErrors: string[];
  contrast: { target: string; html: string; fg: string; bg: string; ratio: number; expected: number }[];
  otherA11y: { id: string; impact: string; help: string; nodes: number }[];
  screenshot: string | null;
  error?: string;
}

async function measure(page: Page, dialog: boolean) {
  return page.evaluate((dialog) => {
    const describe = (el: Element) => {
      const h = el as HTMLElement;
      const label = (h.getAttribute('aria-label') || h.innerText || h.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}${h.id ? '#' + h.id : ''}${label ? ` "${label}"` : ''}`;
    };
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 && !el.closest('.sr-only');
    };
    const sw = document.documentElement.scrollWidth;
    const iw = window.innerWidth;
    let overflow = null as null | { scrollWidth: number; innerWidth: number; culprits: string[] };
    if (sw > iw + 1) {
      const culprits = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.right > iw + 1 && r.width > 0 && vis(e); })
        .filter((e) => !(e.parentElement && e.parentElement.getBoundingClientRect().right > iw + 1)).slice(0, 5).map(describe);
      overflow = { scrollWidth: sw, innerWidth: iw, culprits };
    }
    // Things hidden under the fixed phone bottom bar (after scrolling to the end).
    const navOverlap: string[] = [];
    const bar = [...document.querySelectorAll('nav')].find((n) => getComputedStyle(n).position === 'fixed' && vis(n));
    if (bar && !dialog) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const nb = bar.getBoundingClientRect();
      for (const el of document.querySelectorAll('main a, main button, main input, main select, main textarea, main [role=checkbox]')) {
        if (!vis(el) || bar.contains(el)) continue;
        // The part of the element actually shown: clip by every scrolling/clipping ancestor.
        const b = el.getBoundingClientRect();
        const r = { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.overflowY !== 'visible' || s.overflowX !== 'visible') {
            const c = a.getBoundingClientRect();
            r.top = Math.max(r.top, c.top); r.bottom = Math.min(r.bottom, c.bottom); r.left = Math.max(r.left, c.left); r.right = Math.min(r.right, c.right);
          }
        }
        if (r.bottom <= r.top || r.right <= r.left) continue;
        if (r.bottom > nb.top + 1 && r.top < nb.bottom && r.right > nb.left && r.left < nb.right) navOverlap.push(describe(el));
      }
      window.scrollTo(0, 0);
    }
    // Touch targets: buttons and links smaller than 40 px (inline links inside sentences are exempt).
    const smallTargets: { el: string; w: number; h: number }[] = [];
    const scope = dialog ? [...document.querySelectorAll('[role=dialog]')] : [document.body];
    for (const root of scope) {
      for (const el of root.querySelectorAll('a[href], button, [role=button], [role=checkbox], [role=tab], [role=radio], select')) {
        if (!vis(el)) continue;
        if (el.tagName === 'A' && el.parentElement && ['P', 'SPAN', 'LI'].includes(el.parentElement.tagName) && (el.parentElement.textContent ?? '').trim().length > (el.textContent ?? '').trim().length + 3) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) smallTargets.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    return { overflow, navOverlap, smallTargets };
  }, dialog);
}

async function axe(page: Page, full: boolean) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async (full) => {
    const a = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; help: string; nodes: { target: string[]; html: string; any: { data?: { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string } }[] }[] }[] }> } }).axe;
    const res = await a.run(document, full ? { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } } : { runOnly: { type: 'rule', values: ['color-contrast'] } });
    const contrast = res.violations.filter((v) => v.id === 'color-contrast').flatMap((v) => v.nodes.map((n) => {
      const d = n.any[0]?.data ?? {};
      return { target: n.target.join(' '), html: n.html.slice(0, 120), fg: d.fgColor ?? '', bg: d.bgColor ?? '', ratio: d.contrastRatio ?? 0, expected: Number(String(d.expectedContrastRatio ?? '4.5').replace(':1', '')) };
    }));
    const otherA11y = res.violations.filter((v) => v.id !== 'color-contrast').map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }));
    return { contrast, otherA11y };
  }, full);
}

for (const portal of Object.keys(SCREENS) as Portal[]) {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`11 · ${portal} @ ${vp.w}×${vp.h} ${theme}: every screen — overflow, bottom bar, targets, console, contrast`, async ({ page, diag }) => {
        test.setTimeout(15 * 60_000);
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await page.emulateMedia({ colorScheme: theme });
        await page.addInitScript((t) => { try { localStorage.setItem('wetasnap-theme', t); } catch { /* ignore */ } }, theme);
        if (portal !== 'public') await signIn(page, portal, ACCOUNT[portal]);
        const findings: Finding[] = [];
        for (const s of SCREENS[portal]) {
          const errBefore = diag.consoleErrors.length + diag.pageErrors.length;
          const f: Finding = { screen: s.name, overflow: null, navOverlap: [], smallTargets: [], consoleErrors: [], contrast: [], otherA11y: [], screenshot: null };
          try {
            if (s.path) { await page.goto(s.path); await settle(page); }
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            if (s.open) { await s.open(page); await settle(page, 5_000); }
            await page.waitForTimeout(300);
            Object.assign(f, await measure(page, !!s.dialog));
            const a = await axe(page, vp.id === '1366' && theme === 'light');
            f.contrast = a.contrast; f.otherA11y = a.otherA11y;
            if (vp.shot) {
              const rel = `screens/${portal}/${s.name}-${vp.shot}-${theme}.png`;
              mkdirSync(resolve(ROOT, 'screens', portal), { recursive: true });
              await page.screenshot({ path: resolve(ROOT, rel), fullPage: true, animations: 'disabled' });
              f.screenshot = rel;
            }
          } catch (e) {
            f.error = (e as Error).message.split('\n')[0]!.slice(0, 300);
          }
          f.consoleErrors = [...diag.consoleErrors, ...diag.pageErrors].slice(errBefore);
          findings.push(f);
          // Close any sheet/dialog before the next screen.
          await page.keyboard.press('Escape').catch(() => {});
        }
        mkdirSync(resolve(ROOT, 'findings'), { recursive: true });
        writeFileSync(resolve(ROOT, 'findings', `visual-${portal}-${vp.id}-${theme}.json`), JSON.stringify(findings, null, 2));

        for (const f of findings) {
          expect.soft(f.error, `${f.screen}: screen could be opened`).toBeUndefined();
          expect.soft(f.overflow, `${f.screen}: no horizontal page overflow`).toBeNull();
          expect.soft(f.navOverlap, `${f.screen}: nothing hidden under the bottom navigation`).toEqual([]);
          expect.soft(f.smallTargets, `${f.screen}: touch targets ≥ 40 px`).toEqual([]);
          expect.soft(f.consoleErrors, `${f.screen}: no console errors`).toEqual([]);
          expect.soft(f.contrast.length, `${f.screen}: colour contrast (WCAG AA)`).toBe(0);
        }
      });
    }
  }
}
