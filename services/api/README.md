# WeTa Snap API

The server behind the app: **NestJS + TypeScript on PostgreSQL**, with Redis where there is one,
object storage for the card images, and a background worker for everything nobody is waiting for.

```
  Weta Snap app (PWA)
          │  HTTPS, bearer token
          ▼
     API (NestJS)                     worker (same code, own process)
          │                                   │
          ├── PostgreSQL ──────────────────────┤   people · contacts · business cards · companies
          │     └── pgvector (optional)        │   leads · tags · notes · activities · jobs
          ├── Redis (optional) ────────────────┤   cache · rate limits · job wake-ups
          ├── Object storage (fs or S3) ───────┤   card images, avatars, event attachments
          └── services/ocr (optional) ─────────┘   on-premise card reading
```

Nothing in the list marked *optional* is needed to run: without Redis the cache and the queue use
PostgreSQL, without pgvector contact search uses trigram matching, without an OCR service or an
Anthropic key the app reads cards on the device as it always has.

## Running it

```bash
# once, as a PostgreSQL superuser — creates the roles, the database and the extensions.
# (This machine: PostgreSQL 15 on port 5433, which is the one with pgvector.)
psql -U postgres -h 127.0.0.1 -p 5433 -f services/api/db/setup.sql

cp services/api/.env.example services/api/.env   # fill in the two DATABASE_URLs and SECRET_KEY
npm install
npm run migrate -w @wetasnap/api                 # applies db/migrations/*.sql in order
npm run seed -w @wetasnap/api                    # development data (refuses to run in production)

npm run dev -w @wetasnap/api                     # the API on :4000
npm run worker -w @wetasnap/api                  # the background worker (own terminal)
```

No psql on the PATH? `db/setup-pgadmin.sql` does the same in two copy-paste steps from pgAdmin's
Query Tool — step 1 on the `postgres` database, step 2 on the new `wetasnap` one.

Admins get a 6-digit code after their password. With `MAIL_DRIVER=log` (the default) nothing is
actually sent — each message is printed by the API and written to `storage/mail`:

* **The sign-in page itself** offers the accounts (one tap fills the address and the password) and
  shows the 6-digit code on the step that asks for it — so demonstrating never means leaving the app.
  It is fed by `/dev/accounts` and `/dev/code`, and needs `DEV_DEMO_PASSWORD` set.
* **http://localhost:4000/dev/mail** — one page with every message, for the fuller picture.
* `npm run mail` — the newest code, in the terminal.

Both disappear the moment this is a real deployment: the page's module is not even loaded when
`NODE_ENV=production`, and nothing is written to disk once `MAIL_DRIVER=smtp` and `SMTP_URL` are set.

Point the app at it with `apps/web/.env.local`:

```
VITE_API_URL=http://localhost:4000
```

Delete that file and the app falls back to its in-browser demo backend, which needs nothing
running at all.

| Script | What it does |
|---|---|
| `npm run dev` | API with reload |
| `npm run worker` | Jobs: card reading, contact linking, CRM push, reminders, retention |
| `npm run migrate` / `migrate:status` / `db:reset` | Schema |
| `npm run seed` | Two client companies, a WeTano account, events, fields, leads |
| `npm run build` / `start` | Compile to `dist/`, then run it with plain node |
| `npm run typecheck` / `test` | TypeScript, then the unit tests |
| `npm run mail` | Prints the newest development email — the 6-digit code, without leaving the terminal (`npm run mail -- anna` for one address, `-- --all` for the last ten) |
| `npm run smoke` | Integration tests against a running API: rebuilds the database, seeds it, then walks sign-in, capture, the first-time setup, tenancy and the whole scanning pipeline |

## How it is put together

```
db/
  setup.sql           roles, database, extensions (run once, as a superuser)
  migrations/         0001 core · 0002 catalogue · 0003 leads · 0004 billing · 0005 rules · 0006 rls
  migrate.ts          applies them in order, one transaction each, checksummed
  seed.ts             development data
src/
  main.ts             the process: helmet, CORS, body limits, guards, error filter
  worker.ts           the job loop and every handler
  common/             db · cache · queue · storage · mail · crypto · session · guards · audit
  modules/
    auth/             sign-in, the emailed code, passwords, invitations
    me/               profile, devices, policy, authenticator, file serving
    catalogue/        events, card-field templates, fields, tags
    leads/            capture, sync, filters, bulk actions, import, CSV export
    scan/             the scanning pipeline (quality → crop → OCR → AI → validate → normalise)
    contacts/         duplicate check, merge, lead score, follow-up, semantic search
    team/             people and seats
    settings/         company, CRM connections, billing
    notifications/    the bell, and web push
    support/          tickets
    admin/            the WeTano console: companies, licences, plans, invoices, usage, audit
```

## Two database roles

| Role | Used for | Row-level security |
|---|---|---|
| `wetasnap_app` | everything a signed-in person asks for | **applies** — each request sets `app.person_id`, `app.company_id`, `app.role` for the transaction |
| `wetasnap_service` | sign-in, background jobs, migrations | does not apply (it owns the tables) |

So a query that forgets its `WHERE company_id = …` still cannot reach another company's rows, and
the handful of places that need to see everything are the ones that say so. Password hashes, TOTP
secrets, one-time codes, CRM tokens and the job queue have **no grant at all** for `wetasnap_app`.

## The scanning pipeline

```
 Capture ─▶ Quality check ─┬─ poor ─▶ retake, with the reason in plain words
                           └─ good ─▶ Crop ─▶ OCR ─▶ AI extraction
                                                 │
 Follow-up ◀─ Lead score ◀─ Enrichment ◀─ Contact ◀─ Duplicate check ◀─ Validation + normalisation
                                           ▲             │
                                           └── merge ◀───┘
```

| Step | Where | What it does |
|---|---|---|
| Quality | `scan/pipeline/quality.ts` | sharpness, exposure, glare and coverage; a poor photo is refused before it costs an OCR pass |
| Crop | `scan/pipeline/crop.ts` | the rectangle the person dragged, or the card found in the frame |
| OCR | `scan/pipeline/readers.ts` | `services/ocr` (Surya / Tesseract), on your own machine |
| AI | `scan/pipeline/readers.ts` | Claude vision, when `ANTHROPIC_API_KEY` is set and the company allows cloud reading |
| Validate + normalise | `scan/pipeline/normalise.ts` | per field type; a value that cannot be made sense of keeps its text, loses confidence and gains a reason |
| Duplicate check | `contacts/contacts.service.ts` | same e-mail → same phone → a close name at the same company |
| Merge / create | `contacts/contacts.service.ts` | the new card fills gaps and adds addresses; it never overwrites |
| Enrichment | `contacts/contacts.service.ts` | company domain from the e-mail, name split, country |
| Lead score | `contacts/score.ts` | 0–100, every point explainable |
| Follow-up | `contacts/score.ts` | hot tomorrow, warm in three days, cold after the show |

Steps up to normalisation answer the request, because somebody is standing at the stand waiting
for the fields. The rest runs as a job, so a dropped connection cannot lose it.

## Security

| Area | What is done |
|---|---|
| Passwords | scrypt (N=2¹⁵), per-password salt, constant-time compare; rules, expiry and "not one of your last N" from `security_policy` |
| Sessions | 256-bit opaque tokens; only the SHA-256 is stored; idle timeout, device list, revoke one or all |
| Lockout | counted server-side per address, over every path that can try a password or a code |
| Codes | 6 digits, keyed HMAC at rest, one live code per purpose, five tries, 10 minutes (7 days for an invitation) |
| Tenancy | row-level security on every table, plus guards on every route |
| Input | every body, query and parameter through a zod schema; 256 KB bodies, 15 MB for a card photo |
| Rate limits | per route and per caller, in Redis when there is one |
| Output | one error shape, plain sentences, never a stack trace or a SQL identifier to a browser |
| Secrets | CRM tokens and webhook secrets encrypted with AES-256-GCM before they reach the database |
| Files | nothing is public; images are served through the API, with short-lived signed links for `<img>` |
| Audit | every change and every client error, with personal data scrubbed from the details |
| Headers | helmet, a deny-everything CSP, `no-referrer`, HSTS in production, no `x-powered-by` |
| CORS | only the origins in `CORS_ORIGINS`, no credentials (bearer tokens) |

## What is not here

- **Hosted CRM connectors** (Zoho, HubSpot, Salesforce) need their OAuth application registered for
  the deployment. The signed webhook and the CSV export work today, and the app says so plainly
  rather than opening a sign-in that cannot finish.
- **Push notifications** need `VAPID_*` keys; without them notifications stay in the app.
