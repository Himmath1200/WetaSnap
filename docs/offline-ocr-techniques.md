# Offline OCR techniques — `apps/web/src/lib/offlineReader.ts`

How the on-device reader (Tesseract.js, no server, no cloud) turns a business-card
photo into filled form fields. Each numbered item is one Technique: what it does,
why it exists, and the real card sample that forced it.

Pipeline order: `preprocessForOcr` → Tesseract (`getWorker`) → `rebuildText` →
`parseCardText` (`repairTypos` → line splitting → email → phones → website →
country → company → job title → name). Field mapping is scored, not first-match;
every guess carries a confidence and, below it, a check-reason for the reviewer.

---

## 1. Image-side techniques (before Tesseract sees anything)

### Technique 1 — Upscale small print (`preprocessForOcr`)
Scale the photo so its width reaches ~2200 px (max 2.5×, max ~12 MP), in memory only.
Small print (emails, addresses) often drops under 30 px after SCAN-06 compression;
Tesseract reads ~300 dpi best. Bigger letters, fewer misreads, same photo.

### Technique 2 — Greyscale + autocontrast (`preprocessForOcr`)
Stretch the sampled min/max to 0–255 so an off-white card becomes white and grey
small print becomes black. Sampled every 64th pixel (fast), applied to all pixels.

### Technique 3 — Card-tuned Tesseract parameters (`getWorker`)
- `tessedit_pageseg_mode: '6'` (single uniform block — a card is not a page).
- `preserve_interword_spaces: '1'` — the gutter between two columns survives as
  extra spaces, so merged `email   Company` lines can be split again later.
- `user_defined_dpi: '300'` — phone photos carry no DPI tag; the 70 dpi default
  mis-scales small print.

---

## 2. Text-cleanup techniques (Tesseract output → usable lines)

### Technique 4 — Word-box rebuild (`rebuildText`)
Rebuild lines from Tesseract's word boxes instead of trusting `data.text`:
drop words Tesseract itself barely saw (confidence < 30, unless they carry
`@`, `+` or digits — emails and phones are kept), strip `©®™`, drop
decoration tokens (`——`, `©`, stray glyphs) and rule-only lines. Falls back to
plain text when no word boxes come back.

### Technique 5 — Typo table (`repairTypos`)
Single-character slips repaired before parsing; every rule needs letter
neighbours, so phone digit runs are never touched: `©`→`@` between alphanumerics,
`,com`/`.oom`→`.com`, `.eh`→`.ch`, `—`→`-`, `|`→`l` and `0`→`o` inside words,
`1`→`i` inside long words. *Adapted from syneo-tools-gmbh/Javascript-BCR-Library
(Apache-2.0).*

### Technique 6 — Column and fact splitting (`parseCardText`)
Split merged lines three ways: on tabs / 2+ spaces (two-column gutter),
and on label boundaries (`Tel: … Mobile: …` on one OCR line splits before each
label). Then `clean()`: collapse whitespace, strip leading rule fragments
(`| Jayakumar P`, `~~ M:…`, `1 M:…`) and trailing punctuation — but keep the
trailing dot, it belongs to `B.V.` / `S.r.l.`.

### Technique 7 — Debris filter (`isDebris` + `looksLikeText`)
Drop rule lines and OCR junk: under 3 alphanumerics (`Ld`, `3 J`), or a long
rule mixed with E-fragments (`EE ——— EE eeeee———`, where Tesseract reads the red
hairline as Es) with no solid 3+ letter word. Real mixed facts such as
`M: +91 … Chennal 600002` survive — they carry solid words. Lines that are
mostly symbols (`=a F -— : AL — p—— -`) are dropped by the symbol-ratio check.

---

## 3. Field techniques (lines → card fields)

### Technique 8 — Email as anchor (`extractEmail`)
The most reliable thing on a card. Glues whitespace inside the local part
(`ay 2 kumar.p@…` → `ay2kumar.p@…`); longest local part wins so a fragment never
beats the full address. The domain is taken as printed and **never repaired**.
Glued addresses store at 0.6 with `Uncertain characters — check the spelling`;
clean ones at 0.9.

### Technique 9 — Phone repair, never invention (`repairPhone` + sibling code)
- Strip label punctuation (`T;: +91 …`), brackets (`+9) 842…`).
- `B`→`8` only between digits (`+91 B424015630`); the match runs on the
  normalised line so the digit run matches at all.
- Leading `4` restored to `+` when the rest is a plausible calling code +
  subscriber number (`T: 491 …` → `+91 …`, via the `CC_COUNTRY` table).
- `+9)` + bracket → `+91` (second digit of 91 misread as `)` / `]` / `l`).
- A country-less number borrows the calling code from a sibling number on the
  same card (`; +9) 8424015630` next to a `+91` line).
- Numbers under 7 digits are skipped, not stored. A visibly short mobile loses
  to the intact desk number with `The mobile number looked incomplete`.
  Any repaired/incomplete number is capped at 0.65/0.5 with a check-reason.

### Technique 10 — Mobile wins over desk (`MOBILE_LABEL`, `MISREAD_MOBILE`)
Label-aware pick: explicit mobile labels first, then any labelled / `+` line,
then the first number. `A:` counts as mobile (Tesseract drops the middle stroke
of `M` on small print). Fax lines are excluded outright — a fax is never a contact.

### Technique 11 — Legal suffix beats logo (`HARD_SUFFIX` vs `COMPANY`)
Two-tier company match: a line with a hard legal suffix (`… Co. Ltd.`, `GmbH`,
`SAS`, `B.V.` …) beats a generic company word (`LIFE INSURANCE`, `Group` …).
A merged `email   Company` line contributes what follows the email. Longest
candidate wins within a tier, so a logo fragment (`gcc INSURANCE`) never beats
the printed name. Split letterheads rejoin (`NORDSAAT` above `Saatgut GmbH`).

### Technique 12 — Domain similarity as fallback (`matchDomain`, bigram similarity)
Only when no legal suffix or company-like line won: the email/website domain
usually is the company (`nordsaat.de` → `NORDSAAT`). Exact containment first,
then bigram (Dice) similarity ≥ 0.55 so one misread letter still matches.
Refines the fallback guess only — never overrules a real match.
*Bigram similarity adapted from syneo-tools-gmbh/Javascript-BCR-Library (Apache-2.0).*

### Technique 13 — Country from three sources (`COUNTRY`, `CC_COUNTRY`)
Printed country word first (`Chennai` alone says nothing — no match), else the
dialling-code table from the stored phone (`+91` → India), else nothing.
Sample card has no printed country: `+91` says India at 0.6 with
`Worked out from the dialling code`.

### Technique 14 — Scored name, not first-match (`pickName` + `splitName`)
Candidates scored: capitalised start, 2 words (+2), lone initial (`Jayakumar P`,
+2), email-local agreement per word (+2 each, accent-insensitive, bigram-tolerant
so `ayakumar P` still matches `jayakumar.p`), position near the top (+1).
Threshold ≥ 3, else fall back to `first.last@…` email guess at 0.4.
Contact/company/title lines excluded. Honorifics stripped (`Dr. Katharina Vogel`
→ `Katharina / Vogel`); surname particles kept (`Sanne de Vries` →
`Sanne / de Vries`); lowercase words capitalised.

### Technique 15 — Job-title cleanup (`TITLE`)
Matched on a multilingual title list, then trailing rule glyphs stripped
(`Manager ©/C/Ar.` → `Manager`). Stored at 0.7.

### Technique 16 — Confidence + reason on every value
Every field carries `{ value, confidence, reason?, by: 'offline' }`.
Clean reads score 0.7–0.9; anything repaired, guessed (website/country from
email, name from email local part), or ambiguous (two numbers, short mobile)
scores lower **with a plain-words reason** the review screen shows next to the
field. Nothing is silently invented: unfixable lines (`+91 € x 8084`, single-glyph
damage like `g€c` / `No.2]`) are left for the person, flagged, not guessed.

---

## 4. Deliberate non-goals

- No digit invention (Technique 9): a destroyed number stays flagged, never stored wrong.
- No domain repair (Technique 8): the domain is the company/country evidence.
- No letter guessing inside words: `g€c`, `No.2]` come through raw with a reason.
- No new packages: stdlib + canvas + existing `tesseract.js` (lazy import, PWA
  cache-excluded per `AI_RULES.md` size budget).
