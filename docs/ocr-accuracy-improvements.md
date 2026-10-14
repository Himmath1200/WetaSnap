# OCR accuracy improvements — this session only

Scope: only what was implemented in this chat session (live raw-text popup). No engine tuning, parsing, preprocessing, or pipeline changes were made in this session — those already existed.

## What was added: live raw OCR text popup

After each scan the webpage now shows a small non-blocking popup with the exact raw text the OCR engine read, before field parsing. The reviewer can compare it against the filled form and fix misreads instead of saving them.

### How it works

- New event bus `apps/web/src/lib/ocrLog.ts`: `pushOcrText(text, source)` / `subscribeOcrLog(fn)` / `lastOcrEntry()`. Listener errors are swallowed so logging never breaks scanning.
- New UI `apps/web/src/components/OcrPopup.tsx`: bottom-right toast (`role=status`, `aria-live=polite`), shows source + time + mono raw text, tap-to-expand past 220 chars, copy button with clipboard + textarea fallback, 12s auto-hide, close button, empty state ("Nothing readable — try better light or move closer"). Mounted once in `apps/web/src/App.tsx` next to `Toaster`.
- Background re-reads stay silent: `readOffline(photo, lang, { silent: true })` skips the push. Only live scans pop (demo pipeline re-read uses `silent: true` in `apps/web/src/lib/backend/demo.ts`).

### Raw text sources wired in this session

- Device Tesseract: `apps/web/src/lib/offlineReader.ts` pushes `data.text` as `device Tesseract`.
- Local OCR service: `apps/web/src/lib/ocr.ts` pushes `raw_text` from `/read` as `local OCR (<engine>)`, falling back to joined field values when absent.
- Server API: `apps/web/src/lib/backend/api.ts` pushes `raw_text` from `/v1/scan/read` as `server read (<engines>)`, falling back to joined field values.
- Local service returns it: `services/ocr/main.py` adds `raw_text: str = ""` to `ReadResponse`, filled with `"\n".join(l.text for l in result.lines)`.
- API forwards it: `services/api/src/modules/scan/pipeline/readers.ts` prefers `body.raw_text`, falls back to joined values; `services/api/src/modules/scan/pipeline.service.ts` adds `raw_text: string` to `ReadOutcome` as `ocr?.text ?? ''` (empty when only AI answered).

### Accuracy effect (review, not recognition)

This does not change what the engine reads. It improves end-result accuracy by making misreads visible at review time: the person sees what the engine actually saw and corrects the form before saving.
