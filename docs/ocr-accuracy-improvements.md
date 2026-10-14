# OCR accuracy improvements — what shipped and why

Pipeline order is fixed (`AI_RULES.md`): quality → crop → OCR → AI extract → validation → normalisation → dupe check → merge/create → enrichment → score → follow-up. Everything below sits in the first six steps. Nothing invents data: every repair is flagged with a lower confidence + plain-words `reason` shown next to the field (SCAN-04 / AI-03).

## 1. Capture: never photograph badly (`apps/web/src/components/Camera.tsx`, `apps/web/src/lib/image.ts`)

- Auto-capture only when steady + sharp for ~1s (`STEADY_FRAMES=4`, `MOTION_MAX=6`, `SHARP_MIN=90`). Laplacian variance (`sharpness()`) + frame diff (`motion()`) on a 160×100 sample.
- Placement gate (`analyseFrame()` + `placement()`): flat card-coloured surface + print ink + border ring fill. Refuses desk / hand / ceiling with hints (`find` / `blank` / `far` / `hold` / `blur`), never fires on them (SCAN-01).
- ID-1 frame (85.6×54, 82% width) so the card fills the photo. More pixels per letter = fewer misreads.
- BarcodeDetector shortcut: QR / DataMatrix / PDF417 / Aztec / Code128 counts as placed on its own — lanyards and busy badges bypass the flat-card test.
- 1920×1080 request, environment camera default, multi-camera picker, EXIF honoured downstream.

## 2. Crop before reading (`apps/web/src/components/CropCard.tsx`, `services/api/src/modules/scan/pipeline/crop.ts`, `apps/web/src/lib/image.ts`)

- Person's rectangle wins (`by: 'person'`). Manual Crop/adjust screen with rotate between capture and read (SCAN-02).
- Server auto-crop (`findCard()`): edge-energy on a 320px grey copy, busy span = card, 3% margin back, dropped when area >90% or <12%. A card at 30% of the frame gets ~3× resolution after the table/hand/lanyard is gone.
- Server normalise: `rotate()` (EXIF), resize to 1600px long edge, `normalise()` + `sharpen({sigma:0.6})`, mozjpeg q88. Web compresses to ≤300KB / ~1600px first (`compressCard`, SCAN-06) so upload is fast but letters stay readable.

## 3. Quality gate refuses bad photos (`services/api/src/modules/scan/pipeline/quality.ts`)

- `measure()` on a 320px grey copy: sharpness (Laplacian variance), exposure, clipped, glare (near-white), coverage (busy-column × busy-row span).
- `poor` verdict throws `poor_quality` with a fix-it reason (closer / hold still / more light / out of glare / fill frame) instead of storing a wrong lead. Same numbers stored on `business_cards.quality` for later diagnosis.

## 4. Device Tesseract tuning (`apps/web/src/lib/offlineReader.ts` — `preprocessForOcr`, `getWorker`)

- Upscale to ~2200px wide (max 2.5×, max ~12MP, in-memory canvas). Small print falls under 30px after SCAN-06 compression; Tesseract reads ~300dpi best.
- Greyscale + autocontrast: sample every 64th pixel for min/max, stretch to 0–255. Off-white card → white, grey print → black.
- `tessedit_pageseg_mode: '6'` (card = one uniform block, not a page), `preserve_interword_spaces: '1'` (two-column gutter survives as spaces for later split), `user_defined_dpi: '300'` (phone photos have no DPI tag; 70dpi default mis-scales).
- Language = company language + English (`langsFor`), preloaded on Wi-Fi (`preloadOfflinePack`), worker cached per language pair. No server, no cost (AI-05).

## 5. Word-box rebuild (`rebuildText`)

- Rebuilds lines from `data.lines[].words[]` instead of trusting `data.text`. Drops words with confidence <30 unless they carry `@`/`+`/digits (emails/phones kept), strips `©®™`, drops decoration tokens (`——`, `©`, stray glyphs) and rule-only lines. Falls back to plain text when no boxes come back.

## 6. Typo table + similarity (`repairTypos`, `bigramSim`, `squashForSim`)

Adapted from syneo-tools-gmbh/Javascript-BCR-Library (Apache-2.0), three ideas only:

- `repairTypos()`: `©`→`@` between alphanumerics, `,com`/`.oom`→`.com`, `.eh`→`.ch`, `—`→`-`, `|`→`l` / `0`→`o` inside words, `1`→`i` inside long words. Every rule needs letter neighbours — phone digit runs untouched.
- `bigramSim()` (Dice): `nordsaat` still matches `nordsat`, so one slip doesn't lose the company/domain or name/email link. Used in `matchDomain` (≥0.55) and `pickName` email agreement (≥0.7).
- `squashForSim()`: lowercase + accent-stripped + alphanumerics only, for the comparisons above.

## 7. Line splitting + debris filter (`parseCardText`, `clean`, `isDebris`, `looksLikeText`)

- Split merged facts: tabs / 2+ spaces (column gutter) + label boundaries (`Tel: … Mobile: …` on one OCR line splits before each label).
- `clean()`: collapse whitespace, strip leading rule fragments (`| Jayakumar P`, `~~ M:…`, `1 M:…`) and trailing punctuation — trailing dot kept (`B.V.`, `S.r.l.`).
- `isDebris()`: <3 alphanumerics (`Ld`, `3 J`) or long rule + E-fragments (`EE ——— EE eeeee———`, red hairline read as Es) with no solid 3+ letter word. `looksLikeText()`: symbol ratio ≤35%. Real mixed facts (`M: +91 … Chennal 600002`) survive — they carry solid words.

## 8. Email as anchor (`extractEmail`)

- Most reliable thing on a card. Glues whitespace in local part (`ay 2 kumar.p@…` → `ay2kumar.p@…`), longest local part wins so a fragment never beats the full address. Domain taken as printed, never repaired.
- Glued = 0.6 + `Uncertain characters — check the spelling`; clean = 0.9.

## 9. Phones: repair, never invent (`repairPhone`, sibling code, `PHONE_CHARS`)

- Strip label punctuation (`T;: +91 …`), brackets (`+9) 842…` → `+91` when second digit of 91 misread as `)`/`]`/`l`).
- `B`→`8` only between digits, applied before the match so `+91 B424015630` matches at all.
- Leading `4` → `+` only when the rest is a plausible calling code + subscriber (`T: 491 …` → `+91 …` via `CC_COUNTRY`).
- Country-less number borrows the calling code from a sibling number on the same card, flagged `repairedCC`.
- <7 digits skipped, not stored. Short mobile loses to the intact desk number (`The mobile number looked incomplete`). Repaired/incomplete capped at 0.65/0.5 with a reason.
- Mobile wins over desk (`MOBILE_LABEL` + `MISREAD_MOBILE` + `MOBILE_INITIAL`): `A:` counts as mobile (middle stroke of `M` dropped on small print). Fax excluded outright.

## 10. Company: legal suffix beats logo (`HARD_SUFFIX` vs `COMPANY`, `matchDomain`)

- Two tiers: hard legal suffix (`… Co. Ltd.`, `GmbH`, `SAS`, `B.V.`…) beats generic company words (`LIFE INSURANCE`, `Group`…). Longest wins within a tier, so `gcc INSURANCE` never beats the printed name. Merged `email   Company` lines contribute what follows the email. Split letterheads rejoin (`NORDSAAT` + `Saatgut GmbH`).
- Fallback only: `matchDomain()` — email/website domain usually is the company (`nordsaat.de` → `NORDSAAT`), exact containment then bigram ≥0.55. Never overrules a real match.

## 11. Country, name, title

- Country: printed word first (`COUNTRY`, 0.7), else dialling-code table from stored phone (`+91` → India, 0.6 + `Worked out from the dialling code`), else nothing. `Chennai` alone matches nothing.
- Name (`pickName` + `splitName`): scored, not first-match. Capitalised start +2, 2 words +2, lone initial (`Jayakumar P`) +2, email-local agreement +2/word (accent-insensitive, bigram-tolerant so `ayakumar P` still matches `jayakumar.p`), near-top +1, threshold ≥3, else `first.last@…` email guess at 0.4. Honorifics stripped, surname particles kept (`Sanne de Vries` → `Sanne / de Vries`), lowercase capitalised.
- Job title (`TITLE`, multilingual): trailing rule glyphs stripped (`Manager ©/C/Ar.` → `Manager`), 0.7.
- Every value: `{ value, confidence, reason?, by: 'offline' }`. Clean 0.7–0.9; repaired/guessed/ambiguous lower with a reviewer-facing reason. Unfixable (`+91 € x 8084`, `g€c`, `No.2]`) left for the person, not guessed.

## 12. Local OCR service (`services/ocr/engines.py`, `extract.py`, `main.py`)

- Surya first, Tesseract fallback (AI-05), lazy singleton, `OCR_ENGINE=auto|surya|tesseract`. EXIF transpose, language+English (`{lang}+eng`), missing-pack retry in English, `image_to_data` word boxes grouped to lines, `/health` without loading models.
- Surya 0.20+ HTML blocks paired with detection boxes by centre-in-box; count mismatch → block sliced into bands so reading order survives. Font size + position feed the heuristics (`_by_prominence`: size×2 + nearness-to-top).
- `extract.py`: email repair (`@` spacing, `(at)`), phone E.164 (`normalise_phone`, AI-08) with calling-code inference from TLD → printed country → language, company legal-suffix → domain-match → largest-remaining, name largest-near-top + email tie-break (0.95/0.88), address street+postcode, country cascade (card 0.92 / phone 0.85 / TLD 0.75 / language 0.5), custom-field label match, choice-options match, `UNSURE_BELOW=0.8` forces a `reason`.
- QR (`pyzbar` → OpenCV fallback): vCard/URL beats every heuristic — cannot be misread. Timings + counts logged, never card text (privacy). `/read` returns `raw_text` (joined engine lines) for the live popup.

## 13. Server merge + normalise (`services/api/src/modules/scan/pipeline/`)

- `readers.ts`: OCR + Claude in parallel. Claude prompt: copy-only, strict JSON, allowed keys only, confidence 0–1, reason <0.7. `mergeReads()`: higher confidence wins (+0.05 margin). `readWithOcr` prefers `raw_text`, falls back to joined values.
- `pipeline.service.ts`: quality → crop → OCR+AI → `mergeReads` → `normaliseFields` → device reading underneath (AI-04: person-typed never overwritten). Returns `raw_text: ocr?.text ?? ''`, logs `ai_read` usage with engines.
- `normalise.ts`: email (`(at)`→`@`, spaces out, `not-an-email` kept at ≤0.5), phone (`O`→`0`/`l`→`1` next to digits only, never invents a country code), link (protocol + hostname-dot check), `titleCase` (`LENA FISCHER` → `Lena Fischer`, `GmbH` kept), empties dropped.
- `worker.ts` background re-read fills empty fields only, same merge path.

## 14. Live raw-text popup (`apps/web/src/lib/ocrLog.ts`, `apps/web/src/components/OcrPopup.tsx`)

- `pushOcrText(text, source)` bus + `subscribeOcrLog()`. Fired by device Tesseract (`offlineReader`), local service (`ocr.ts`), server API (`backend/api.ts` from `raw_text`). Background re-reads pass `silent: true` — only live scans pop.
- Bottom-right non-blocking toast (`role=status`, `aria-live=polite`): source, time, mono raw text, tap-to-expand past 220 chars, copy button, 12s auto-hide, empty state (`Nothing readable — try better light`). Mounted once in `App.tsx` next to `Toaster`.
- Accuracy effect: the reviewer sees exactly what the engine saw before trusting the filled fields — misreads get corrected instead of saved.

## 15. Proof (tests)

- `apps/web/src/lib/__tests__/offlineReader.test.ts`: German card, mobile-over-desk, email fallbacks, Ageas merged-column / B-for-8 / `A:`-as-mobile / fragmented-email samples, debris/label cases, confidence+`by: offline` on every value.
- `services/ocr/tests/test_extract.py`: whole-card per language (DE/FR/IT/ES/NL/PT/GB/mixed), fax-never-phone, E.164, vCard-beats-heuristics, block→line→field chain, `reason`-below-threshold contract.
- `services/api/test/pipeline.test.ts`: normalise (nearly-right email, impossible email kept+flagged, letter-for-digit phones, never-invent-CC, protocol-only link completion, titleCase, domainOf free-mail exclusion).

## Non-goals (deliberate)

- No digit invention: destroyed numbers stay flagged, never stored wrong.
- No domain repair: the domain is company/country evidence.
- No letter guessing inside words: single-glyph damage comes through raw with a reason.
- No new packages: stdlib + canvas + existing `tesseract.js` (lazy import, PWA cache-excluded per size budget).
