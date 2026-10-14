import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { ACC, signIn } from './helpers';

const bell = (page: Page) => page.getByRole('button', { name: /^Notifications/ });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Notifications' });

test.describe('8 · Notifications', () => {
  test('bell count, tabs All / Unread / Reminders, mark all read', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications (3 unread)');
    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
    const items = panel(page).locator('ul > li');
    await expect(items).toHaveCount(3);
    await panel(page).getByRole('tab', { name: /Unread/ }).click();
    await expect(items).toHaveCount(3);
    await panel(page).getByRole('tab', { name: /Reminders/ }).click();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Reminder: send the show report');
    await expect(items.first()).toContainText('Reminder');
    await panel(page).getByRole('button', { name: 'Mark all read' }).click();
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications');
    await panel(page).getByRole('tab', { name: /Unread/ }).click();
    await expect(panel(page).getByText('Everything has been read.')).toBeVisible();
    await page.reload();
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications'); // stored on the server
  });

  test('clicking an item opens the right screen inside the admin portal (Leads filtered to Check)', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await bell(page).click();
    await panel(page).getByRole('button', { name: /A lead was rejected by Zoho CRM/ }).click();
    await expect(page).toHaveURL(/\/leads\?status=check$/);
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications (2 unread)');
    await expect(page.getByRole('button', { name: 'Remove filter Check' }), 'Leads list should be filtered to Check').toBeVisible();
  });

  test('event notification opens Settings → Events in the admin portal', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await bell(page).click();
    await panel(page).getByRole('button', { name: /AgriTech Expo 2026 is running now/ }).click();
    await expect(page).toHaveURL(/\/settings\?tab=events$/);
    await expect(page.getByRole('tab', { name: 'Events', selected: true })).toBeVisible();
  });

  test('super admin: WeTano notifications navigate inside the console', async ({ page }) => {
    await signIn(page, 'super-admin', ACC.super);
    await expect(bell(page)).toHaveAttribute('aria-label', /Notifications \(\d+ unread\)/);
    await bell(page).click();
    await expect(panel(page)).not.toContainText('A lead was rejected'); // no company notifications here
    await panel(page).getByRole('button', { name: /Invoice WS-2026-0011 is overdue/ }).click();
    await expect(page).toHaveURL(/\/subscriptions$/);
  });

  test('staff only get notifications that lead to screens they can open', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await bell(page).click();
    const items = panel(page).locator('ul > li button');
    const n = await items.count();
    const titles = await items.allInnerTexts();
    // Every linked notification must stay on a staff screen (not bounce back to Scan).
    const bad: string[] = [];
    for (let i = 0; i < n; i++) {
      await page.goto('/my-leads');
      await bell(page).click();
      const item = panel(page).locator('ul > li button').nth(i);
      const linked = await item.locator('svg.lucide-chevron-right').count();
      if (!linked) continue;
      await item.click();
      await page.waitForTimeout(600);
      if (/\/scan$/.test(page.url())) bad.push(titles[i]!.split('\n')[0]!);
    }
    expect(bad, 'notifications that point staff at admin-only screens').toEqual([]);
  });
});
