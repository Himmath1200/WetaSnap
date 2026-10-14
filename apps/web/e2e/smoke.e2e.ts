import { test, expect } from './fixtures';
import { ACC, signIn } from './helpers';

test('smoke: every kind of account signs in', async ({ page }) => {
  await signIn(page, 'staff', ACC.anna);
  await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible();
});
