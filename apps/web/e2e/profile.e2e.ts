import { test, expect } from './fixtures';
import { ACC, cardFile, expectToast, openMenu, signIn, softNav, toast } from './helpers';

test.describe('9 · Profile', () => {
  test('picture upload and remove', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await softNav(page, '/profile');
    // Wait for the profile screen itself: until it renders, the Scan screen's own upload input is still in <main>.
    await expect(page.getByRole('heading', { name: 'My profile' })).toBeVisible();
    const logs: string[] = [];
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text().slice(0, 200)}`));
    await page.locator('main input[type=file]').setInputFiles(cardFile('me.png', 9));
    await expect(toast(page, /Picture updated|.+/).first(), `console: ${logs.join(' | ')}`).toBeVisible();
    await expectToast(page, 'Picture updated');
    await expect(page.locator('main img[src^="data:image"]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Menu' }).locator('img')).toBeVisible();
    await page.getByRole('button', { name: 'Remove' }).click();
    await expectToast(page, 'Picture removed');
    await expect(page.getByRole('button', { name: 'Menu' }).locator('img')).toHaveCount(0);
  });

  test('details save and persist', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    await softNav(page, '/profile');
    await page.locator('#pf-name').fill('Anna Weber-Q');
    await page.locator('#pf-phone').fill('+49 151 0000001');
    await expect(page.locator('#pf-email')).toBeDisabled();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectToast(page, 'Profile saved');
    await page.reload();
    await expect(page.locator('#pf-name')).toHaveValue('Anna Weber-Q');
    await expect(page.locator('#pf-phone')).toHaveValue('+49 151 0000001');
    const sheet = await openMenu(page);
    await expect(sheet).toContainText('Anna Weber-Q');
  });

  test('theme Light / Dark / System persists across reload', async ({ page }) => {
    await signIn(page, 'client-admin', ACC.admin);
    await softNav(page, '/profile');
    const group = page.getByRole('radiogroup', { name: 'Appearance' });
    await group.getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe('rgb(255, 255, 255)');
    await page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'System' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem('wetasnap-theme'))).toBe('system');
  });

  test('app version and build date are shown (and in the footer)', async ({ page }) => {
    await signIn(page, 'super-admin', ACC.super);
    await softNav(page, '/profile');
    const about = page.locator('main section').filter({ has: page.getByRole('heading', { name: 'About' }) });
    await expect(about).toContainText(/App version\s*v0\.1\.0/);
    await expect(about).toContainText(/Build date\s*\d{4}-\d{2}-\d{2}/);
    await expect(page.locator('main').getByText(/© \d{4} WeTano Solutions · WeTa Snap v0\.1\.0/)).toBeVisible();
  });
});
