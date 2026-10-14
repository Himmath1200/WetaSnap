# WeTa Snap

A business-card scanner for exhibitions. Booth staff scan a visitor's card with a phone or laptop, check the details and save. Leads are kept on the device when there is no network and go to the company's CRM once the connection returns.

Built to **URS Phase 1, Lean edition v2.0** ([docs/WeTa-Snap-URS-Phase1-Lean-v2.0.docx](docs/WeTa-Snap-URS-Phase1-Lean-v2.0.docx)).

## Layout

| Path | What |
|---|---|
| `apps/web` | The one app (PWA) for phones and laptops: Preact + Vite + TypeScript + Tailwind v4, Dexie (IndexedDB) and a service worker |
| `services/api` | The backend: NestJS + TypeScript on PostgreSQL, with Redis where there is one, object storage for card images and a background worker ([README](services/api/README.md)) |
| `services/ocr` | Optional local card reader (FastAPI wrapping Surya, with Tesseract as a fallback) — cards are read on your own machine and the photo never leaves your network |
| `docs` | URS and project documents |

```
  app (PWA)  ──HTTPS──▶  API (NestJS)  ──────▶  PostgreSQL   users · contacts · business cards
                                 │                           companies · leads · tags · notes · activities
                                 ├──────▶  Object storage   the card images
                                 ├──────▶  Redis            sessions cache · rate limits · jobs
                                 └──────▶  pgvector         semantic contact search
```

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173. With no `VITE_API_URL` the app runs in **demo mode**: a mock server lives in the browser, with six client companies and a few hundred leads, so every screen can be clicked through with nothing installed.

### With the real backend

```bash
psql -U postgres -f services/api/db/setup.sql   # once: roles, database, extensions
cp services/api/.env.example services/api/.env  # fill in the two DATABASE_URLs and SECRET_KEY
npm run migrate && npm run seed                 # schema, then development data
npm run dev:api                                 # the API on :4000
npm run worker                                  # the background worker, in another terminal
echo "VITE_API_URL=http://localhost:4000" > apps/web/.env.local
npm run dev                                     # the app, now talking to PostgreSQL
```

### Two doors

| Who | Signs in at | Lands on |
|---|---|---|
| Booth staff | `/signin` | `/scan` |
| The client's admins | `/signin` | `/leads` |
| WeTano Super Admins | `/super-admin/signin` | `/super-admin/companies` |

WeTano has its own address; client admins and staff share the main one. How many steps follow the
password depends on the account — staff are in straight away, and admins get a 6-digit emailed
code. An authenticator app is never required: anyone can turn one on for their own account in
Security, and is then asked for it at every sign-in. An account that tries the wrong door is
refused and told where to go.

### The first time: setting a password

Nobody signs themselves up. WeTano adds the client company and its first admin (Companies → New
company); that admin adds the team (Team → Invite person). Each new person is emailed a 6-digit
code and a **Set up password** button:

1. The button opens WeTa Snap at `/signin#setup=<their address>` — *Set up your password*.
2. They enter the code from the email, a new password, and the same password again.
3. *Your password is set* appears with **Go to sign in**, and from then on they sign in with that
   password like everyone else.

The code lasts 7 days, and the same screen can email a new one. A forgotten password later takes
exactly the same path (*Set or reset password*), with a code that lasts 10 minutes. The admin who
sent the invitation sees the setup link too, in case the email never arrives.

Inside each door every screen has a plain address (`/leads`, `/scan`, `/super-admin/usage`, …) and
the menu shows only what that role may open; anything else sends the person back to their own home
screen, in the app and in the database alike. Company links from the earlier three-portal layout
(`/client-admin/leads`, `/staff/scan`) still work — they are redirected to the shared address.

Demo accounts (password **`WetaSnap#2026`** for all; demo mode shows the emailed code on screen, and accepts any 6 digits for an authenticator once one is set up):

| Who | Accounts |
|---|---|
| Scanner | anna@agroexpo.de, ben@agroexpo.de, maja.karlsson@nordicseeds.se |
| Admin portal | admin@agroexpo.de, admin@nordicseeds.se, carmen.ruiz@terramaquinaria.es, priya.raman@kisanagro.in |
| Console | super@wetano.com |

Use **Menu → Simulate offline (demo)** to try offline capture and sync.

While the API runs in development, the sign-in page lists the accounts it has: one tap fills the
address and the password, and an admin's 6-digit code appears on the screen that asks for it.
**http://localhost:4000/dev/mail** shows every message the API has sent, if you want the fuller
picture. Both vanish in a real deployment — the endpoints behind them are not loaded when
`NODE_ENV=production`, and nothing is written to disk once real email is configured.

With the API running (above), the seeded accounts are `super@wetano.test`, `anna.admin@agroexpo.test`,
`erik.lund@nordicseeds.test`, `sam.staff@agroexpo.test` and `maja.karlsson@nordicseeds.test` — all with
the same development password, printed by `npm run seed`.

## Checks

```bash
npm run typecheck
npm test
npm run build
npm run size
```

`npm run size` enforces the URS §8.1 budget: ≤ 250 KB of code on first open, ≤ 2 MB for the installed app.

## Screens → requirements

| Screen | File | Requirements |
|---|---|---|
| S1 Sign in | `screens/SignIn.tsx` | AUTH-01..04 |
| S2 Scan + S3 Review | `screens/Scan.tsx`, `components/Camera.tsx`, `components/LeadForm.tsx` | SCAN-01..09, AI-03/04/05, LEAD-01/02/05 |
| S4 My leads | `screens/MyLeads.tsx`, `components/EditLead.tsx` | LEAD-03/04, SYNC-02, CRM-05/06 |
| S5 Leads + lead panel | `screens/Leads.tsx` | LEAD-04/06/07, ADM-06/07 |
| S6 Team | `screens/Team.tsx` | ADM-01/02, AUTH-05/06/08 |
| S7 Settings | `screens/Settings.tsx` | ADM-03..05, CRM-01..09, AI-07 |
| S8 Companies | `screens/Companies.tsx` | LIC-01..07 |
| S9 Subscriptions (plans, subscriptions, invoices) | `screens/Subscriptions.tsx` | — |
| S10 Audit log | `screens/AuditLog.tsx` | PRIV-04 |
| S11 Support | `screens/Support.tsx` | — |

Search on S4 and S5 has a **Filter** button beside it. Events, captured by and tags are multi-select; dates offer Today / Last 7 days / Last 30 days or a custom range. Active filters show as removable chips.

## Beyond the URS (client additions, 20 Sep 2026)

- **Light, dark and system themes** — picked in Menu → Appearance; with no choice made the app follows the phone or laptop.
- **Notifications** — a bell with an unread count: failed CRM pushes, licence expiry, events, imports, support replies. Reminders appear at the top of the panel. Optional push when the app is closed (needs `VITE_VAPID_PUBLIC_KEY` and the `push-send` function).
- **Tags** — created in Settings → Tags, attached while scanning or editing, and used as a filter.
- **Import leads** — Excel or CSV with column matching, duplicate warnings and a downloadable template (Leads → Import).
- **Export** — Excel with a green header row, frozen header, a filter arrow on every column, banded rows and a second sheet listing the filters used; CSV is still there.
- **Lead preview** — a lead opens read-only; Edit makes it editable. Phone, email, website and address are tappable, and a lead can be saved to the phone's contacts or shared (contact card or the card photo).
- **Card fields templates** — several named sets of fields per company, one default, chosen per event.
- **Events** — attachments (price lists, floor plans) and the template to use.
- **Team** — a mobile number per person and several events per person.
- **Company** — headquarters, default language and time zone.
- **Local card reading** — point the app at `services/ocr` in Settings → Company; cards are read there first and the cloud reader is only the fallback.

## Second round of client additions (21 Sep 2026)

- **Look** — the wordmark and screen titles use Outfit (two latin weights, ~28 KB, loaded after the system font); a quieter notification dropdown with All / Unread / Reminders tabs and a link into each item; a copyright line with the app version on every screen.
- **My profile** (`/profile`) — profile picture, name and mobile number, appearance, push alerts, app version and build date, and a sign-out that always asks yes or no.
- **Security & devices** (`/security`) — password rules and session limits set by WeTano and applied everywhere; change password (confirmed by an emailed code); two-factor with recovery codes; active sessions with device, IP and last seen, revoke one or all others; sign-in history including failed attempts.
- **Super Admin sign-in** — email and password, then the authenticator code. Forgotten passwords are reset with a 6-digit code sent to the same address. Everyone else keeps the passwordless code sign-in.
- **Staff can delete their own leads** (client decision of 22 Sep 2026, overriding URS §4.3) — always a soft delete that a Client Admin can restore for 30 days; a lead that never left the phone is simply removed from it.
- **Errors are audited** — any failure (uncaught errors, failed actions, screen crashes) is written to the audit log with what the person was doing, the error, its root cause and where it happened. Personal data is scrubbed from the text. Super Admins filter with **Errors only**.
- **Leads** — tick boxes for bulk tagging, resending, exporting and deleting; sortable columns; export to PDF beside Excel and CSV; an import history with "view imported leads".
- **Team** — filter by role, status and events, and sortable columns.
- **Settings → Billing & plan** — the company's own plan, seats, scan allowance and invoices.
- **Events** — description/notes and the venue's time zone.
- **Super Admin** — company detail shows the plan above the licence type and lists the company's admins with their email and phone; companies can be suspended; the scan-allowance behaviour is set per company (block / allow overage / notify); a Usage page with per-company meters and usage alerts that raise notifications.

## Theme

Green is the main colour, with blue accents (client brief). The tokens are in `apps/web/src/styles.css`:
- `brand-*` (green): the one main button per screen, active navigation, success states
- `ocean-*` (blue): links, secondary buttons, filters, focus rings, info states
- the green→blue gradient is used only as a thin accent bar and in the logo
