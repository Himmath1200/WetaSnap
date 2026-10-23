# Card Photo Auto-Enhancement — Session Notes

What changed in this session: capture → auto clean-up → fill-in form. No crop screen, no filter picker.

## 1. Flow (final)
- Capture / Upload goes straight to Review & save.
- Removed `CropCard.tsx` and the Scan/adjust step.
- Single upload and camera capture share one path: `develop()` → `startReview()`.
- `develop(_, cropToCard)`: capture passes `false` (the guide frame already cut the card) and so
  does the Pro scanner's warp (`developScan` → `autoEnhance(_, false)`); uploads pass `true`.
- Batch uploads also run through the same clean-up.
- e2e helpers updated: `uploadCard()` now waits for `Review & save`.

## 2. Enhance Card toggle
- Checkbox under the camera: `Enhance card`.
- Default ON.
- Remembered per device in `localStorage` key `wetasnap-enhance` (`on` / `off`).
- Helpers: `isEnhanceEnabled()`, `setEnhanceEnabled()` in `apps/web/src/lib/scan.ts`.
- OFF = plain `compressCard()`. ON = full-frame auto-enhance.
- Safe in private mode (`try/catch` around storage).

## 3. Auto-crop (no sides lost)
- Border flood-fill on a 160px thumbnail finds background (multi-colour tables OK).
- `boundsOfMask()`: majority vote per row/column (`fill >= 0.3`), specks ignored.
- 3% pad at thumbnail + 1% more at full resolution. Error eats margin, never card edge.
- Declines safely (keeps whole photo): empty, full-bleed, tiny (<15%), near-full-frame (>98%), implausibly small (<12%).
- Unit-tested in `apps/web/src/lib/__tests__/scan.test.ts`.

## 4. Colour pipeline (gentle by design)
Order in `develop()`: detect → crop → `flatten()` → `stretch()` → `saturate(1.03)` → `sharpen(0.08)`.
- All on-device canvas. No packages. Offline PWA safe.
- Output compressed ≤ 300 KB via existing `compressCard()`.

### 4.1 Flatten (shadows + lamp tint)
- ONE luminance gain per pixel (R/G/B share it). Hue cannot shift.
- `flattenWeight()`: print darker than 75% of background gets zero correction. Only paper/light shadows lift.
- White balance from bright thumbnail pixels, capped ±4%.
- Shadow lift capped 12%.

### 4.2 Levels (near-identity)
- `paperWhite()`: 90th percentile, no brightness threshold.
- `inkBlack()`: 0.5th percentile.
- `enhanceCurve()`: print pixels pass through byte-identical. Only paper snaps white (±2) and crushed blacks open +6.
- Verified: mid-range worst shift = 0.

### 4.3 Finish
- Saturation 1.03, sharpen 0.08. Whisper only.

## 5. Lead detail photo fit
- `LeadDetail.tsx`: removed fixed `max-h-44` frame + `object-contain` (caused side bars).
- Now `bg-white p-0`, image `block h-auto w-full`. Natural aspect, edge-to-edge, no crop, no bars.
- Front/back aligned top via `items-start`.

## 6. Offline PWA
- `lib/scan.ts` uses Canvas + `createImageBitmap` only. Zero `fetch`.
- Bundled in precached app shell. Saves to IndexedDB via `saveLocal()`, sync deferred.
- Note: text reading (Tesseract) still needs its language pack preloaded once on Wi-Fi. Image clean-up itself needs nothing.

## 7. Bugs fixed along the way
- Vite parse error: missing `)` on homography pivot line.
- White rectangle output: `solveH()` sign convention produced `-identity`; warp sampled outside photo. Fixed rows, verified ~1e-13 error.
- Washout iterations: per-channel gains + partial text boost + paper-threshold white point each bleached faint text in turn. Replaced with single-gain, zero-boost-on-print, threshold-free white point, near-identity curve.

## Files touched
- `apps/web/src/lib/scan.ts` — pipeline, toggle storage, detection, levels.
- `apps/web/src/screens/Scan.tsx` — no crop step, toggle UI, `develop()` path.
- `apps/web/src/components/LeadDetail.tsx` — photo fit.
- `apps/web/src/lib/__tests__/scan.test.ts` — levels + bounds tests.
- Deleted: `apps/web/src/components/CropCard.tsx`.
- e2e: `helpers.ts`, `visual.e2e.ts` hook updates.
