import { test, expect } from './fixtures';
import { ACC, SAMPLE_CARD, nav, printedCardFile, signIn, uniq, uploadInput, expectToast } from './helpers';

/**
 * SCAN-V2 · the pro scanner runs parallel to the classic one: its own nav entry,
 * live camera screen, corner true-up with a perspective warp, then the same
 * review form and save. The camera is headless so capture is exercised via upload;
 * the detector (DocAligner ONNX + ORT) is covered by its own unit tests, since
 * running the real model belongs on a device with the weights, not in CI.
 */
test.describe('2b · Pro scanner (staff)', () => {
  test('nav entry, upload → corners → Use scan → review → save', async ({ page }) => {
    await signIn(page, 'staff', ACC.anna);
    // Second scan button with its own icon sits next to the classic one.
    await nav(page, 'Pro scan');
    await expect(page).toHaveURL(/\/scan-v2$/);
    await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();

    await uploadInput(page).setInputFiles([await printedCardFile(page)]);
    // The true-up step: four draggable corners, a flat preview, the warp button.
    await expect(page.getByText('Line up the corners')).toBeVisible({ timeout: 15_000 });
    for (const corner of ['Top-left corner', 'Top-right corner', 'Bottom-right corner', 'Bottom-left corner']) {
      await expect(page.getByRole('button', { name: corner })).toBeVisible();
    }
    // Auto-detect settles (model or fallback corners), then the warp runs.
    const use = page.getByRole('button', { name: 'Use scan', exact: true });
    await expect(use).toBeEnabled({ timeout: 90_000 });
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
