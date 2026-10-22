import { test, expect } from './fixtures';
import { ACC, SAMPLE_CARD, nav, printedCardFile, signIn, uniq, uploadInput, expectToast } from './helpers';

/**
 * SCAN-V2 · the pro scanner runs parallel to the classic one: its own nav entry,
 * live camera screen, corner true-up with a perspective warp, then the same
 * review form and save. The warp is plain canvas work, so it runs for real with
 * no network; corner detection needs the ONNX model and is covered by unit tests
 * (lib/__tests__/docAligner.test.ts) rather than by a 15 MB download in CI.
 */
test.describe('2b · Pro scanner (staff)', () => {
  test('nav entry, upload → corners → Use scan → review → save', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    // The single scan entry in the nav now opens the pro scanner.
    await nav(page, 'Scan');
    await expect(page).toHaveURL(/\/scan-v2$/);
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();

    await uploadInput(page).setInputFiles([await printedCardFile(page)]);
    // The true-up step: four draggable corners, a flat preview, the warp button.
    await expect(page.getByText('Line up the corners')).toBeVisible({ timeout: 15_000 });
    for (const corner of ['Top-left corner', 'Top-right corner', 'Bottom-right corner', 'Bottom-left corner']) {
      await expect(page.getByRole('button', { name: corner })).toBeVisible();
    }
    const use = page.getByRole('button', { name: 'Use scan', exact: true });
    await expect(use).toBeEnabled({ timeout: 60_000 });
    await use.click();

    // Same review form as the classic scanner (ids prefixed scan-v2).
    await expect(page.getByText('Review & save')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByAltText('Front of the card')).toBeVisible();
    const last = uniq('Pro');
    await page.locator('#scan-v2-first_name').fill(SAMPLE_CARD.first);
    await page.locator('#scan-v2-last_name').fill(last);
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expectToast(page, 'Lead saved');
    await expect(page.getByText('Scan a card to start')).toBeVisible();
  });
});
