# WeTa Snap 📱📇

> **Enterprise-Grade AI Business Card Scanner, Lead Capture & CRM Synchronization Platform.**  
> *Built for high-volume exhibitions, trade shows, corporate sales teams, and solo professionals.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Preact](https://img.shields.io/badge/Preact-10.x-673AB8?style=for-the-badge&logo=preact&logoColor=white)](https://preactjs.com/)
[![NestJS](https://img.shields.io/badge/NestJS-10.x-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)](https://nestjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-316192?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Database-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![PWA](https://img.shields.io/badge/PWA-Offline_First-success?style=for-the-badge&logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
[![Vercel](https://img.shields.io/badge/Vercel-Deployed-black?style=for-the-badge&logo=vercel&logoColor=white)](https://vercel.com/)

---

## 📑 Table of Contents

- [Overview](#-overview)
- [System Architecture](#-system-architecture)
- [Complete Feature Catalog](#-complete-feature-catalog)
  - [1. Offline-First Storage & Outbox Sync](#1-offline-first-storage--outbox-sync)
  - [2. Computer Vision & Multi-Engine OCR](#2-computer-vision--multi-engine-ocr)
  - [3. Multi-Role Portal Architecture](#3-multi-role-portal-architecture)
  - [4. Instant Lead Follow-Up Messaging](#4-instant-lead-follow-up-messaging)
  - [5. CRM Connectors & Data Exports](#5-crm-connectors--data-exports)
  - [6. Lead Lifecycle, Telemetry & 30-Day Recycle Bin](#6-lead-lifecycle-telemetry--30-day-recycle-bin)
  - [7. Security, Authentication & Session Control](#7-security-authentication--session-control)
- [Monorepo Structure](#-monorepo-structure)
- [Tech Stack Details](#-tech-stack-details)
- [Environment Configuration](#-environment-configuration)
- [Local Development Guide](#-local-development-guide)
- [Production Deployment](#-production-deployment)
  - [Frontend Deployment (Vercel)](#frontend-deployment-vercel)
  - [Backend Deployment (Render / Railway / Cloud)](#backend-deployment-render--railway--cloud)
- [Default Seed & Test Accounts](#-default-seed--test-accounts)
- [Testing & Quality Assurance](#-testing--quality-assurance)
- [License](#-license)

---

## 🌟 Overview

**WeTa Snap** is a high-performance, offline-capable Progressive Web Application (PWA) and backend ecosystem engineered for fast-paced commercial environments such as international trade shows, conventions, and field sales.

Exhibition Wi-Fi is notoriously unstable. WeTa Snap guarantees **zero data loss**: every card capture, photo, note, and contact field is saved to client-side IndexedDB before network transmission. When connectivity is restored, the service worker and outbox engine automatically synchronize leads to a central PostgreSQL database and dispatch them to corporate CRMs.

---

## 🏛️ System Architecture

```
                    ┌────────────────────────────────────────────────────────┐
                    │                   CLIENT LAYER (PWA)                   │
                    │  Preact · Vite · Tailwind v4 · Dexie (IndexedDB) · SW   │
                    └───────────────┬────────────────────────┬───────────────┘
                                    │                        │
                    (Direct Local Capture)         (Network Available / Restored)
                                    ▼                        ▼
                    ┌─────────────────────────┐    ┌─────────────────────────┐
                    │   IndexedDB (Local)     │    │   NestJS REST API       │
                    │  - db.leads (dirty: 1)  │───▶│   - Auth & Session Guard│
                    │  - db.photos (blobs)    │    │   - Lead Validation     │
                    │  - db.session & cache   │    │   - Idempotent Sync     │
                    └─────────────────────────┘    └────────────┬────────────┘
                                                                │
                                   ┌────────────────────────────┼────────────────────────────┐
                                   ▼                            ▼                            ▼
                      ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
                      │   PostgreSQL Database   │  │   Cloud Services        │  │   External Integrations │
                      │   (Supabase IPv4 Pool)  │  │   - Nodemailer (SMTP)   │  │   - Zoho CRM / Bigin    │
                      │   - Row Level Security  │  │   - Twilio (SMS Verify) │  │   - HubSpot             │
                      │   - Audit Logs          │  │   - Gemini 2.0 Flash    │  │   - Salesforce          │
                      │   - Soft-delete purger  │  │   - Object Storage      │  │   - Signed Webhooks     │
                      └─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
```

---

## ✨ Complete Feature Catalog

### 1. Offline-First Storage & Outbox Sync
- **Local-First Writes**: Cards and dual-sided camera photos are stored in IndexedDB (`wetasnap-device`) before network requests are dispatched.
- **Service Worker Background Sync**: Integrates the Background Sync API (`sync-leads`). Queued cards synchronize even if the user switches apps or closes the browser tab.
- **Active Connectivity Probing**: Actively monitors real internet reachability rather than relying solely on passive browser events.
- **State Indicators**: Real-time status indicators across the top bar:
  - `Offline · {n} waiting` (amber warning indicator).
  - `Online · {n} waiting` (interactive blue sync button).
  - `Online · all synced` (green verification indicator).
- **Idempotent PostgreSQL Sync**: The backend endpoint (`POST /v1/leads/sync`) executes atomic upsert queries (`INSERT ... ON CONFLICT (id) DO UPDATE`), preventing duplicates during network retries.

---

### 2. Computer Vision & Multi-Engine OCR
- **Edge Perspective Correction**: Uses client-side ONNX Runtime WebAssembly to detect card corners, straighten angled images, and crop boundaries directly on device.
- **Multi-Engine OCR Flexibility**:
  - **Google Gemini 2.0 Flash**: Cloud vision extraction with structured JSON schemas.
  - **Tesseract.js**: Fully in-browser optical text extraction when running completely offline.
  - **Surya OCR Service**: Optional self-hosted Python FastAPI microservice for private on-premises OCR.
- **Confidence Scoring & Audit**: Extracted fields display visual validation indicators. Raw OCR text is preserved under `lead.notes` as **"Detected card text"** for full traceability.

---

### 3. Multi-Role Portal Architecture

| Role | Access URL | Default Landing | Description |
| :--- | :--- | :--- | :--- |
| **Super Admin** | `/super-admin/signin` | `/companies` | Platform administration, client organization provisioning, license tier controls, system audit logs, and unified support queues. |
| **Company Admin** | `/signin` | `/home` | Team administration, event creation, CRM connectors, custom field templates, and corporate follow-up template management. |
| **Event Organizer** | `/signin` | `/home` | Event campaign oversight, referral codes (`ORG-XXXXX`), attendee team member allocation (`max_logins`), and event analytics. |
| **Booth Staff (Scanner)** | `/signin` | `/home` | Quick navigation (`Home` → `Scans` → `All leads`), high-speed camera scanning, offline capture, and lead inspection. |
| **Solo Individual** | `/signin` | `/home` | Self-serve lead capture with 5 free monthly scans, Pro subscription upgrade, personal telemetry, and direct support. |

---

### 4. Instant Lead Follow-Up Messaging
- **Dual-Channel Dispatch**: Sends follow-up messages directly via **WhatsApp** (`https://wa.me/`) and **Email** (`mailto:`).
- **Dynamic Placeholder Replacement**:
  - `{name}` → Scanned contact's full or first name.
  - `{company}` → Sender's organization name.
  - `{lead_company}` → Company parsed from the business card.
  - `{event}` → Live event name.
  - `{sender}` → Logged-in member's name.
- **Organization Template Governance**:
  - Company Admins configure organization-wide message templates and auto-send toggles in **Settings > Company** or **Profile**.
  - Team staff inherit the template in a read-only view with their personal name dynamically populated, ensuring brand consistency.
- **Precision Cursor Placeholder Insertion**: Clicking placeholder tags (`{name}`, `{company}`, etc.) inserts the token directly at the text cursor position.
- **Solo & Organizer Brand Input**: If an individual or organizer includes `{company}`, an input field appears automatically to specify their brand name.

---

### 5. CRM Connectors & Data Exports
- **Supported CRM Providers**:
  - **Zoho CRM**: Maps to Zoho Leads with auto-detected domains.
  - **Zoho Bigin**: Maps to Bigin Contacts and Pipelines.
  - **HubSpot**: Maps to HubSpot Contacts.
  - **Salesforce**: Maps to Salesforce Leads.
  - **Signed Webhook**: Dispatches HMAC-SHA256 authenticated JSON payloads with customizable field mappings for Zapier, Make, n8n, or proprietary APIs.
  - **Excel / CSV**: Always-available export engine.
- **Live Test Lead Dispatch**: Built-in test trigger confirms webhook and CRM connectivity with real payload feedback.
- **Export Capabilities**: Exports to formatted **Excel (.xlsx)** with auto-filters and frozen headers, **CSV**, and **PDF**.

---

### 6. Lead Lifecycle, Telemetry & 30-Day Recycle Bin
- **Product Interest Categorization**: Categorizes prospects into **WeTaLoop**, **WeTaAnalytics**, or **Other** (includes custom text specification).
- **Lead Priority Indicators**: Flags leads with **Hot 🔥**, **Warm ☀️**, or **Cold ❄️** ratings.
- **Long-Press Card Selection**: Clean interface without checkboxes. Long-pressing (500ms on touch or desktop) activates multi-select mode.
- **30-Day Recycle Bin**:
  - Deleted cards are soft-deleted (`deleted_at = now()`) and moved to an isolated Recycle Bin.
  - Individual users and organization teams access their deleted cards in **Profile > Recycle Bin** with one-click restoration.
  - Automated background workers purge records older than 30 days.
- **Real-Time Telemetry Counters**:
  - Solo accounts display personal statistics (**My Captured Cards**, **Scanned Today**, **Needs Review**).
  - Deleting a card decrements the active count and surfaces a dedicated **Recycle Bin** card on the dashboard.

---

### 7. Security, Authentication & Session Control
- **Two-Factor Authentication (2FA)**: Time-based One-Time Passwords (TOTP) compatible with Google Authenticator and Microsoft Authenticator.
- **Direct TOTP Login**: Solo users with 2FA enabled bypass redundant email codes and authenticate directly with their 6-digit TOTP code.
- **Sign-In State Persistence**: Preserves active verification steps in `sessionStorage`. Switching to email apps on mobile devices does not reset credentials.
- **Strict Super Admin Session Limits**:
  - Restricts Super Admins to a maximum of **2 concurrent active sessions** (FIFO revocation).
  - Automatically signs out the oldest device when a 3rd session logs in.
  - Enforces a strict **5-minute inactivity auto-logout** across client and server.
- **Mobile Number Validation & Duplicate Restriction**:
  - Enforces a minimum 10-digit mobile number with international E.164 normalization (`+91...`).
  - Restricts registrations to one account per mobile number.
- **Twilio SMS OTP Integration**: Dispatches 6-digit SMS verification codes via the Twilio Verify API.

---

## 📂 Monorepo Structure

```
weta-snap/
├── apps/
│   └── web/                         # Frontend Application (PWA)
│       ├── public/                  # Manifest, icons, service worker
│       │   ├── push-sw.js           # Push notifications & Background Sync handler
│       │   └── manifest.webmanifest # PWA installable manifest
│       └── src/
│           ├── components/          # Reusable UI & modal components
│           │   ├── AppShell.tsx     # Navigation, responsive bars, sync banners
│           │   ├── Camera.tsx       # Live camera viewfinder & capture
│           │   ├── DocCamera.tsx    # Edge-detection document camera
│           │   ├── FollowUpModal.tsx# Post-scan WhatsApp/Email dispatch modal
│           │   ├── LeadDetail.tsx   # Lead inspection, contact sharing, notes
│           │   ├── LeadForm.tsx     # Field editor, priority & product interest
│           │   └── ui.tsx           # Design system components (Dialog, Tabs, etc.)
│           ├── lib/                 # Core domain logic
│           │   ├── backend/         # API abstraction & offline demo engine
│           │   ├── db.ts            # Dexie IndexedDB schemas & tables
│           │   ├── followup.ts      # Template formatter & WhatsApp/mailto handlers
│           │   ├── net.ts           # Connectivity detection & health probes
│           │   ├── sync.ts          # Outbox manager & PostgreSQL sync pipeline
│           │   └── types.ts         # TypeScript interfaces & domain types
│           └── screens/             # Route-level views
│               ├── Home.tsx         # Dashboard, telemetry cards, live quotas
│               ├── Leads.tsx        # Directory, search, dropdown filters, bulk actions
│               ├── Profile.tsx      # Account settings, 2FA, Recycle Bin, Follow-up
│               ├── ScanV2.tsx       # AI perspective warping & capture review
│               ├── Settings.tsx     # CRM connections, company details, field definitions
│               ├── SignIn.tsx       # Authentication, password setup, mobile OTP
│               └── Usage.tsx        # Super Admin usage meters & quota tracking
│
├── services/
│   ├── api/                         # Backend REST API (NestJS)
│   │   ├── src/
│   │   │   ├── common/              # Database, crypto, mail, SMS, sessions, guards
│   │   │   │   ├── db.service.ts    # PostgreSQL client & query runner
│   │   │   │   ├── mail.service.ts  # Nodemailer RFC 5322 SMTP engine
│   │   │   │   ├── session.service.ts # Session validation & FIFO limit enforcement
│   │   │   │   └── sms.service.ts   # Twilio Verify & HTTP SMS dispatcher
│   │   │   └── modules/             # NestJS domain modules
│   │   │       ├── admin/           # Company provisioning & platform analytics
│   │   │       ├── auth/            # Sign-in, password reset, 2FA, people service
│   │   │       ├── catalogue/       # Events & custom field catalog
│   │   │       ├── leads/           # Lead search, sync, outbox processing, audit
│   │   │       ├── settings/        # Company settings & CRM connector logic
│   │   │       └── team/            # Team invites, role promotion/demotion
│   │   └── db/                      # SQL migrations, setup, and seeds
│   │
│   └── ocr/                         # Standalone Python OCR service (Surya / FastAPI)
│
├── vercel.json                      # Vercel deployment configuration & SPA rewrites
└── package.json                     # Monorepo workspaces & build orchestration
```

---

## 💻 Tech Stack Details

| Domain | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend Framework** | [Preact](https://preactjs.com/) + [Vite](https://vitejs.dev/) | Ultra-lightweight reactive UI with sub-second bundle times |
| **Styling** | [Tailwind CSS v4](https://tailwindcss.com/) | Theme tokens (`brand-*`, `ocean-*`), dark/light mode support |
| **Client Storage** | [Dexie.js](https://dexie.com/) (IndexedDB) | Persistent offline database for cards, photos, and sync state |
| **Edge Vision** | [ONNX Runtime Web](https://onnxruntime.ai/) | Client-side corner detection & perspective warping in WebAssembly |
| **Backend Framework** | [NestJS](https://nestjs.com/) + [Express](https://expressjs.com/) | Modular enterprise REST API architecture |
| **Database** | [PostgreSQL 16](https://www.postgresql.org/) via [Supabase](https://supabase.com/) | Relational database accessed via IPv4 Session Pooler |
| **Validation** | [Zod](https://zod.dev/) | Strict runtime input validation across API endpoints |
| **Email Delivery** | [Nodemailer](https://nodemailer.com/) | RFC 5322 SMTP integration via Gmail App Passwords |
| **SMS Delivery** | [Twilio](https://www.twilio.com/) Verify API | International SMS OTP verification with template bypass |
| **PWA Engine** | [Vite PWA](https://vite-pwa-org.netlify.app/) (Workbox) | Offline caching, web manifests, and Background Sync API |

---

## ⚙️ Environment Configuration

### 1. Backend Configuration (`services/api/.env`)
Create `services/api/.env` using the following structure:

```env
# Database (Supabase IPv4 Connection Pooler - Session Mode)
DATABASE_URL="postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-1-[REGION].pooler.supabase.com:5432/postgres"
SERVICE_DATABASE_URL="postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-1-[REGION].pooler.supabase.com:5432/postgres"

# JWT & Crypto Encryption
JWT_SECRET="your-32-character-jwt-secret-string"
ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

# SMTP Email Configuration (e.g. Gmail App Password)
MAIL_DRIVER=smtp
MAIL_FROM="WeTano Support <your-email@gmail.com>"
SMTP_URL="smtps://your-email%40gmail.com:your-16-char-app-password@smtp.gmail.com:465"

# SMS OTP Configuration (Twilio Verify)
SMS_DRIVER=twilio
TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_NUMBER=+1234567890
TWILIO_VERIFY_SERVICE_SID=VAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Server Settings
PORT=4000
APP_URL="http://localhost:5173"
NODE_ENV=development
```

### 2. Frontend Configuration (`apps/web/.env.local`)
Create `apps/web/.env.local`:

```env
VITE_API_URL=http://localhost:4000
NEXT_PUBLIC_SUPABASE_URL=https://[PROJECT_REF].supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=[YOUR_SUPABASE_PUBLISHABLE_KEY]
```

---

## 🚀 Local Development Guide

### 1. Install Dependencies
Run from the root directory:
```bash
npm install
```

### 2. Run the Development Servers
```bash
# Terminal 1: Launch Backend API (Port 4000)
npm run dev:api

# Terminal 2: Launch Frontend Web App (Port 5173)
npm run dev:web
```

Access the application in your browser:
- **Client Application**: [http://localhost:5173](http://localhost:5173)
- **Super Admin Console**: [http://localhost:5173/super-admin/signin](http://localhost:5173/super-admin/signin)
- **API Health Endpoint**: [http://localhost:4000/health](http://localhost:4000/health)

---

## 🌐 Production Deployment

### Frontend Deployment (Vercel)

The repository includes a configured root `vercel.json` with Single Page Application rewrites:

1. Import the repository in [Vercel](https://vercel.com).
2. Configure build settings:
   - **Framework Preset**: `Vite`
   - **Root Directory**: `./` (or `apps/web`)
   - **Build Command**: `npm run build -w @wetasnap/web`
   - **Output Directory**: `apps/web/dist`
3. Add Environment Variables:
   - `NEXT_PUBLIC_SUPABASE_URL`: `https://[PROJECT_REF].supabase.co`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: `[PUBLISHABLE_KEY]`
   - `VITE_API_URL`: `https://api.yourdomain.com` (your deployed backend URL)
4. Click **Deploy**.

---

### Backend Deployment (Render / Railway / Cloud)

Deploy `services/api` as a long-running Node.js service:

1. Create a **New Web Service** connected to your repository.
2. Configure:
   - **Root Directory**: `services/api`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `node dist/main.js`
3. Add environment variables from `services/api/.env`.
4. Point the frontend `VITE_API_URL` to your production API URL.

---

## 🔑 Default Seed & Test Accounts

Shared password for all pre-seeded accounts: **`WetaSnap#2026`**

| Role | Username / Email | Password | Access Scope |
| :--- | :--- | :--- | :--- |
| **WeTano Support (Super Admin)** | `super@wetano.com` | `WetaSnap#2026` | `/super-admin/signin` — Full platform management, usage tracking, license controls, audit logs. |
| **Company Admin** | `admin@agroexpo.de` | `WetaSnap#2026` | `/signin` — AgroExpo organization dashboard, team management, CRM integrations, follow-up templates. |
| **Scanner (Booth Staff)** | `anna@agroexpo.de` | `WetaSnap#2026` | `/signin` — Direct card scanning, offline outbox, personal lead history. |
| **Event Organizer** | `organizer@techfest.org` | `WetaSnap#2026` | `/signin` — TechFest 2026 campaign management, attendee quotas, referral codes. |
| **Event Attendee** | `attendee@techfest.org` | `WetaSnap#2026` | `/signin` — Registered attendee scanner under TechFest 2026. |

---

## 🧪 Testing & Quality Assurance

```bash
# Run unit and integration tests across web and API
npm test

# Run TypeScript compilation checks across all workspaces
npm run typecheck

# Build production artifacts for all packages
npm run build

# Enforce PWA initial load budget (≤ 250 KB initial bundle)
npm run size
```

---

## 📄 License

Proprietary — Developed for **WeTano Technologies**. All rights reserved.
