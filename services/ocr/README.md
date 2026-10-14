# WeTa Snap — local card reader

A small FastAPI service that reads exhibition business cards **on your own
machine**, so card photos never leave the building. The PWA calls it directly
over localhost or the show Wi-Fi and falls back to the cloud reader when this
service does not answer.

It reads with [Surya](https://github.com/datalab-to/surya) when Surya is
installed, and with Tesseract otherwise. A QR code on the card (vCard or URL)
beats both, because there is nothing to misread.

**The image is decoded in memory, read, and dropped. Nothing is written to
disk, and no card text is ever logged** — only timings and counts.

---

## 1. Install

```bat
cd "D:\Weta Snap\services\ocr"
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

That gets you the service plus Tesseract support. Surya and the QR readers are
optional and are installed separately (below).

### Tesseract on Windows

`pytesseract` is only a wrapper — the program itself is a separate install:

1. Get the installer from <https://github.com/UB-Mannheim/tesseract/wiki>.
2. During setup, tick the language packs you need:
   `deu`, `fra`, `spa`, `ita`, `nld`, `por` (English is always included).
3. If `tesseract.exe` is not on your `PATH`, point the service at it:

   ```ini
   # .env
   TESSERACT_CMD=C:\Program Files\Tesseract-OCR\tesseract.exe
   ```

   Setting `TESSERACT_CMD` is the usual fix for
   `TesseractNotFoundError` on Windows.

### Surya (the better reader)

Surya pulls in PyTorch (about 2 GB) and downloads its models the first time it
runs, which is why it is **not** in `requirements.txt`:

```bat
pip install surya-ocr
```

Install it into the same interpreter as the service (activate `.venv` first).
The first `/read` after a restart loads the models and takes a few seconds;
every request after that reuses them, because the service keeps them in memory
for the life of the process. `GET /health` tells you whether Surya was found
and whether it is loaded yet.

Surya has reshaped its Python API several times. The service detects which
version you have and adapts (it has been checked against **0.22.x**, and
handles the older 0.4–0.19 shapes too). If a new release breaks it, the
service logs the reason and quietly falls back to Tesseract.

### QR codes (optional)

Either package is enough; `pyzbar` is tried first, then OpenCV:

```bat
pip install pyzbar
pip install opencv-python
```

---

## 2. Run it

```bat
run.bat
```

or, on macOS/Linux/Git Bash:

```sh
./run.sh
```

Both read `.env` (copy `.env.example` to `.env` first) and start uvicorn on
`0.0.0.0:8099`. Check it:

```
http://localhost:8099/health
```

Settings live in `.env.example` — engine choice, host, port, token, size limit
and log level.

---

## 3. Reaching it from a phone on the same Wi-Fi

The service binds to `0.0.0.0`, so it already listens on your LAN address.

1. **Find this machine's IP**: run `ipconfig` and take the IPv4 address of the
   adapter you are on (something like `192.168.1.24`).
2. **Open the port in Windows Firewall.** This is the step people miss — the
   service is running fine, the phone just cannot reach it. In an
   **Administrator** PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "WeTa Snap OCR" -Direction Inbound `
     -Protocol TCP -LocalPort 8099 -Action Allow -Profile Private
   ```

   `-Profile Private` keeps the rule off public networks. Exhibition Wi-Fi is
   usually classed as Public, so if the phone still cannot connect, either set
   that network to Private in Windows settings or add `Public` to the profile
   list — and if you do, **set `OCR_TOKEN`** (below), because anyone on that
   network can then reach the service.
3. **Point the phone at it**: `http://192.168.1.24:8099/health` in the phone's
   browser should return `{"ok":true,...}`.

Notes:

- Both devices must be on the same network, and the network must allow
  device-to-device traffic. Many guest and conference networks block it
  ("client isolation"); a phone hotspot is the usual workaround.
- The browser blocks plain HTTP calls from an HTTPS page. If the PWA is served
  over HTTPS, a `http://192.168.x.x` call is mixed content and will be refused.
  Either run the PWA over HTTP in the hall, or put the reader behind a TLS
  proxy. See the TODO at the end.
- CORS is open to every origin on purpose — the PWA is served from a different
  origin than this service. `OCR_TOKEN` is what actually guards it.

---

## 4. The contract

### `GET /health`

No authentication (the app needs to ping it before it has done anything) and
no model loading, so it answers in milliseconds.

```json
{
  "ok": true,
  "engines": {
    "preference": "auto",
    "surya":     { "installed": true,  "loaded": false, "error": null },
    "tesseract": { "installed": true },
    "qr":        { "installed": true }
  },
  "version": "1.0.0"
}
```

`installed` means the package is importable; `loaded` means the Surya models
are already in memory. Treat any `200` with `ok: true` as "the local reader is
available".

### `POST /read`

Request:

```json
{
  "image_base64": "/9j/4AAQSkZJRgABAQ…",
  "mime": "image/jpeg",
  "language": "de",
  "fields": [
    { "key": "first_name", "label": "First name", "type": "text",  "options": [], "ai_hint": "", "required": true },
    { "key": "company",    "label": "Company",    "type": "text",  "options": [], "ai_hint": "Legal company name, without the logo tagline", "required": false },
    { "key": "phone",      "label": "Phone",      "type": "phone", "options": [], "ai_hint": "Prefer the mobile number if there are several", "required": false }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `image_base64` | yes | Base64 of the card photo. A `data:image/jpeg;base64,` prefix is accepted and stripped. |
| `mime` | no | Advisory only; the format is detected from the bytes. |
| `language` | no | One of `en de fr es it nl pt`. A hint, not a restriction — mixed-language cards are expected. |
| `fields` | yes | The company's own fields. `type` is one of `text email phone link choice longtext`. Empty list → `422`. |

Send `Authorization: Bearer <token>` when `OCR_TOKEN` is set.

Response:

```json
{
  "fields": {
    "first_name": { "value": "Anna",                 "confidence": 0.93 },
    "company":    { "value": "Müller Technik GmbH",  "confidence": 0.91 },
    "phone":      { "value": "+4915123456789",       "confidence": 0.7,
                    "reason": "Two numbers on the card — check which is the mobile" }
  },
  "engine": "surya",
  "ms": 412
}
```

- Only fields that were **found** appear. A field the reader could not fill is
  simply absent — it is never returned empty.
- `confidence` is `0..1`, from the OCR confidence combined with how sure the
  heuristic is.
- `reason` is present **exactly when** `confidence < 0.8`, and is a short note
  for the person reviewing the card (AI-03). Values from a QR code come back at
  `0.97` and never carry a reason.
- `engine` is `"surya"` or `"tesseract"` — whichever actually did the reading.
- `ms` is the whole request, decode included.

The shape matches `ReadResult` in `apps/web/src/lib/backend/index.ts`
(`Record<string, { value, confidence, reason? }>`), so the result can be handed
to `fillFromRead` as-is.

Errors:

| Status | When |
| --- | --- |
| `400` | The image could not be decoded or opened. |
| `401` | `OCR_TOKEN` is set and the bearer token was missing or wrong. |
| `413` | Request larger than `OCR_MAX_BODY_BYTES` (8 MB default). |
| `422` | No fields were asked for, or the body did not validate. |
| `503` | No engine could read the card. **Fall back to the cloud reader.** |

Try it:

```bat
curl -X POST http://localhost:8099/read -H "Content-Type: application/json" ^
  -d "{\"image_base64\":\"...\",\"fields\":[{\"key\":\"email\",\"label\":\"Email\",\"type\":\"email\"}]}"
```

Interactive docs while it is running: <http://localhost:8099/docs>.

---

## 5. What it actually does with a card

`extract.py` holds the heuristics; they use the line **boxes**, not just the
text:

- **Name** — the largest line near the top that is not the company, a job
  title or contact details. When the email local part backs it up
  (`a.schmidt@…` next to "Anna Schmidt") the confidence goes up and no reason
  is set. Honorifics (`Dr.`, `Dipl.-Ing.`) are dropped, and surname particles
  stay with the surname: *Sanne de Vries* → `Sanne` / `de Vries`.
- **Company** — the line carrying a legal suffix (GmbH, SAS, S.r.l., B.V.,
  Ltd, Lda, AB, SL and friends), else the line matching the email or website
  domain, else the biggest line left over (and then it says so).
- **Phone** — every number on the card is found and labelled from the words
  around it (`Tel`, `Mobil`, `Móvil`, `Telemóvel`, `Port.`, a bare `M`). Fax
  numbers are dropped. Mobiles win, by label or by national numbering range.
  Numbers become E.164 when a country can be worked out from the dialling
  code, the domain TLD, the country printed on the card, or the `language`
  hint — otherwise the digits are kept as they were rather than guessed at.
- **Email / website** — with the spaces OCR leaves around `@` repaired. A
  website guessed from the email domain is returned at low confidence with a
  reason.
- **Address / country** — street keywords and postcode shapes for DE, FR, ES,
  IT, NL, PT, BE, AT, CH, GB, SE.
- **Custom fields** — a field whose key is not recognised is matched on its
  own **label** printed on the card (`Stand: B4-217`), on its `ai_hint`
  keywords, or, for `choice` fields, against its options.

### Tests

The extraction tests are pure Python — **no Surya, Tesseract, Pillow or
FastAPI needed**:

```bat
python -m pytest
```

59 cases covering German, French, Italian, Spanish, Dutch, Portuguese,
British and mixed-language cards, phone normalisation, QR vCards, custom
field mapping, and the rule that a `reason` appears exactly when the
confidence is below 0.8.

---

## 6. TODO

- **`reason` is English only.** The strings in `extract.py` (`_REASONS`) are
  returned as plain English and the app shows them as-is, so they bypass
  `t()` / `tn()`. If reasons need translating, return a short code alongside
  the text and let the web app key its own translation off that.
- **No TLS.** If the PWA is served over HTTPS, the browser will refuse a
  plain-HTTP call to this service. Needs a local certificate or a proxy.
- **Surya is pinned to nothing.** The adapter detects the API shape at load
  time, but only 0.22.x has been exercised against a real install here. Worth
  re-checking after a Surya upgrade — `GET /health` shows the load error if it
  breaks.
- **One card at a time.** Requests are serialised through a lock, because
  Surya's predictors hold model state. Fine for a stand with a few staff; it
  would need a worker pool for heavier use.
- **Not wired into the app yet.** `apps/web` still has to try this service
  before the cloud reader — that change belongs in `lib/backend`, which
  another developer owns.
