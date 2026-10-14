# Offline OCR techniques — this chat session only (`apps/web/src/lib/offlineReader.ts`)

Scope: only what changed in this session vs baseline `0ca85c6` (which already had
basic email/phone/company/title/name regex matching). Baseline matching is not
listed below — each Technique is one new repair added while fixing your Ageas card.

---

### Technique 1 — Upscale + autocontrast before Tesseract (`preprocessForOcr`)
New in this session. Canvas upscale toward ~2200 px wide (max 2.5×, ~12 MP cap),
greyscale + min/max stretch so off-white card → white, grey small print → black.
In-memory only. Fixed `491 …` reads and tiny `@ageasfederal.com` print.

### Technique 2 — Card-tuned Tesseract parameters (`getWorker`)
New in this session. `tessedit_pageseg_mode '6'` (one block, not a page),
`preserve_interword_spaces '1'` (column gutter survives as spaces),
`user_defined_dpi '300'` (phone photos have no DPI tag). Enables Technique 5's
column split.

### Technique 3 — Word-box rebuild (`rebuildText`)
New in this session. Rebuild lines from `data.lines[].words[]`: drop words with
confidence < 30 unless they carry `@`/`+`/digits, strip `©®™`, drop decoration
tokens (`——`, `|`), drop rule-only lines. Falls back to `data.text` when no boxes.

### Technique 4 — Typo table (`repairTypos`)
New in this session (ported idea, rewritten here). `©`→`@` between alphanumerics,
`,com`/`.oom`→`.com`, `.eh`→`.ch`, `—`→`-`, `|`→`l` / `0`→`o` inside words,
`1`→`i` in long words. Letter neighbours required — phone digit runs untouched.

### Technique 5 — Merged-fact splitting + edge clean (`parseCardText`, `clean`)
New in this session. Split on tabs / 2+ spaces (column gutter: `email   Company`)
and on label boundaries (`Tel: … Mobile: …` on one OCR line). `clean()` strips
leading rule fragments (`| Jayakumar P`, `~~ M:…`, `1 M:…`) and trailing label
punctuation; trailing dot kept for `B.V.` / `S.r.l.`.

### Technique 6 — Debris filter for rules and E-runs (`isDebris`, `looksLikeText`)
New in this session. Drop < 3 alphanumerics (`Ld`, `3 J`) and long rules mixed
with E-fragments (`EE ——— EE eeeee———`, red hairline read as Es) with no solid
3+ letter word; drop mostly-symbol lines (`=a F -— : AL — p—— -`) by symbol ratio.
`M: +91 … Chennal 600002` survives (solid words present).

### Technique 7 — Fragmented email glue (`extractEmail`)
New in this session. Glues whitespace inside the local part (`ay 2 kumar.p@…` →
`ay2kumar.p@…`), longest local part wins, domain taken as printed and never
repaired. Glued = 0.6 + `Uncertain characters — check the spelling`; clean = 0.9.

### Technique 8 — Phone digit repairs + sibling-code borrow (`repairPhone`)
New in this session. Strip label punctuation (`T;: +91 …`), brackets; `B`→`8`
only between digits (before matching, so `+91 B424015630` matches); `+9)` +
bracket → `+91`; leading `4` → `+` only for plausible calling-code lengths
(`T: 491 …` → `+91 …` via `CC_COUNTRY`); country-less number borrows the code
from a sibling number on the same card. < 7 digits skipped, never stored;
repaired/short numbers capped at 0.65/0.5 with a reason.

### Technique 9 — Mobile-over-desk with misread labels (`MOBILE_LABEL`, `MISREAD_MOBILE`)
New in this session. Explicit mobile labels first; `A:` counts as mobile (middle
stroke of `M` dropped on small print); fax excluded outright. Visibly short
mobile (`+91 63831 8084`) loses to the intact desk number with
`The mobile number looked incomplete`.

### Technique 10 — Legal-suffix tier + domain-similarity fallback (`HARD_SUFFIX`, `matchDomain`)
New in this session. Hard-suffix line (`… Co. Ltd.`) beats generic company words
(`LIFE INSURANCE`); longest wins per tier so `gcc INSURANCE` never beats the
printed name; merged `email   Company` lines contribute text after the email.
Only when nothing won: domain-similarity fallback (exact containment, then bigram
Dice ≥ 0.55, e.g. `nordsaat.de` → `NORDSAAT`) — never overrules a real match.

### Technique 11 — Country from dialling code (`CC_COUNTRY`)
New in this session. Printed country word first; else dialling-code table from
the stored phone (`+91` → India, 0.6 + `Worked out from the dialling code`).
Your card prints no country, so `+91` supplies India.

### Technique 12 — Scored name + title cleanup (`pickName`, `splitName`)
New in this session. Name scored, not first-match: capitalised start, 2 words,
lone initial (`Jayakumar P`), per-word email-local agreement (accent-insensitive,
bigram-tolerant so `ayakumar P` still matches `jayakumar.p`), near-top bonus,
threshold ≥ 3; honorifics stripped, surname particles kept (`de Vries`),
lowercase capitalised. Title trailing rule glyphs stripped
(`Manager ©/C/Ar.` → `Manager`).

## Non-goals (held in this session)
No digit invention (`+91 € x 8084` left flagged, never stored wrong); no domain
repair; no letter guessing inside words (`g€c`, `No.2]` pass through raw with a
reason); no new packages.
