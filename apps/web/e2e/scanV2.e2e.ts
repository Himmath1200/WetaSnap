import { test, expect } from './fixtures';
import { ACC, SAMPLE_CARD, nav, printedCardFile, signIn, uniq, uploadInput, expectToast } from './helpers';

/**
 * SCAN-V2 · the pro scanner runs parallel to the classic one: its own nav entry,
 * live camera screen, corner true-up with a perspective warp, then the same
 * review form and save. The warp itself (jscanify + OpenCV from the CDN) runs
 * for real here; the camera is headless so capture is exercised via upload.
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
    // The engine (OpenCV + jscanify) loads lazily, then auto-detect settles.
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

  test('busy background: the lock sits on the card, not the clutter', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, 'staff', ACC.anna);
    const found = await page.evaluate(async () => {
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 480;
      const x = cv.getContext('2d')!;
      // Busy room: gradient wall, cabinet rects, one long "ceiling" diagonal.
      const g = x.createLinearGradient(0, 0, 0, 480);
      g.addColorStop(0, '#8a8f96'); g.addColorStop(0.5, '#b9b4a8'); g.addColorStop(1, '#6f6a60');
      x.fillStyle = g; x.fillRect(0, 0, 640, 480);
      x.strokeStyle = '#3c3c3c'; x.lineWidth = 5;
      x.strokeRect(380, 40, 220, 160); // cabinet
      x.strokeRect(20, 300, 140, 140); // cabinet
      x.lineWidth = 7; x.beginPath(); x.moveTo(0, 60); x.lineTo(640, 140); x.stroke(); // ceiling line
      x.lineWidth = 4; x.beginPath(); x.moveTo(0, 400); x.lineTo(640, 380); x.stroke();
      // The card: white, dark border, some print.
      x.fillStyle = '#fdfdf8'; x.fillRect(150, 120, 340, 240);
      x.strokeStyle = '#222222'; x.lineWidth = 3; x.strokeRect(150, 120, 340, 240);
      x.fillStyle = '#222222';
      x.fillRect(180, 160, 200, 18); x.fillRect(180, 190, 150, 12); x.fillRect(180, 210, 180, 12);
      const m = await import('/src/lib/scanEngine.ts');
      return m.detectCard(cv, cv.width, cv.height);
    });
    expect(found, 'a quad is found on a busy background').not.toBeNull();
    const near = (p: { x: number; y: number }, ex: number, ey: number) =>
      Math.hypot(p.x - ex, p.y - ey) < 25;
    expect(near(found!.tl, 150, 120)).toBe(true);
    expect(near(found!.tr, 490, 120)).toBe(true);
    expect(near(found!.br, 490, 360)).toBe(true);
    expect(near(found!.bl, 150, 360)).toBe(true);
  });
});
