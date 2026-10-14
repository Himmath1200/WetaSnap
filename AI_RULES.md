# AI_RULES.md — WeTa Snap

## Tech Stack
- `apps/web` PWA: Preact 10 + `preact-iso` router + Vite 8 + TypeScript strict + Tailwind CSS v4 (`@theme` tokens in `src/styles.css`).
- `services/api`: NestJS 11 + TypeScript (CommonJS) on PostgreSQL 16 + pgvector, Redis-optional (ioredis, falls back to Postgres), S3-compatible object storage, background worker (`src/worker.ts`).
- `services/ocr` (optional, local-only): FastAPI wrapping Surya with Tesseract fallback. Cloud reader is fallback only.
- Offline-first web: Dexie (IndexedDB) + `vite-plugin-pwa` service worker. Saves go to IndexedDB first (`lib/sync.ts` → `saveLocal`), device owns lead id, sync is idempotent. Never delete unsynced data.
- Shared contract: `apps/web/src/lib/types.ts` is the domain contract — SQL in `services/api/db/migrations/*.sql` must match it field for field. Three roles only: `super_admin`, `client_admin`, `staff`. Never add roles.
- Auth: password-first for all; admins get emailed 6-digit code second step; TOTP only if user enabled it in Security. Two doors: `/super-admin/*` console vs shared `/signin` app. Build links with `linkFor()`, gate with `canSee()` / `homeFor()` in `src/routes.ts`.
- I18n + theme: every visible string via `t()` / `tn()` from `lib/i18n.ts` (English text is the key, `src/locales/*.json`). Light/dark share one token set via `data-theme` — no `dark:` variants.
- Size budget (URS §8.1): ≤250 KB first open, ≤2 MB installed. Enforced by `npm run size` (size-limit). Lazy-load pages, libphonenumber, tesseract, xlsx/pdf libs.
- Checks before finishing: `npm run typecheck && npm test && npm run build && npm run size` (both workspaces); API changes also run against a real DB (`npm run smoke -w @wetasnap/api`).

## Library Rules — what to use for what
| Task | Use | Do NOT use |
|---|---|---|
| Routing | `preact-iso` (`LocationProvider`, `Router`, `Route`, `lazy`, `useLocation` in `src/App.tsx`) | react-router, wouter, custom router |
| App state / session / sync | `lib/store.ts` (`useStore`), `lib/session.ts`, `lib/sync.ts`, `lib/backend/index.ts` (`Backend` interface) | redux, zustand, react-query |
| Server calls | `Backend` interface only — `lib/backend/api.ts` (real, when `VITE_API_URL` set) + `lib/backend/demo.ts` (in-browser mock, also used by tests). Same rules in both | direct `fetch` to API in screens/components |
| Styling | Tailwind utilities + semantic tokens: `bg-surface/bg-subtle/text-ink/text-muted/border-line/card/pop`, `brand-*` (green primary), `ocean-*` (blue secondary), `.btn-primary/.btn-secondary/.btn-ghost/.btn-danger/.input/.label/.card` in `styles.css` | hard-coded `bg-white/text-slate-900`, `dark:` variants, new color scales, shadcn/ui, CSS modules |
| Icons | `lucide-preact` | emoji icons, other icon packs |
| Fonts | system font body; Outfit (`.wordmark`/`.title`) via `@fontsource/outfit` latin 600+700 only | other webfonts, extra weights |
| Validation — web | `valibot` (`lib/validate.ts`), `libphonenumber-js` for phones (lazy-load it) | zod on web, custom regex passwords — use `checkPassword()/passwordStrength()` from `lib/password.ts` |
| Validation — API | `zod` via `common/validation.ts`, throw `DomainError` for user-readable errors | class-validator, valibot on API |
| DB / auth / crypto — API | `pg` raw SQL + RLS (`db.as(me,…)` sets `app.person_id/company_id/role`); `node:crypto` for passwords/tokens/TOTP/webpush | ORMs (Prisma/TypeORM), auth libraries (passport/next-auth), no new ORM |
| Offline storage | `dexie` (`lib/db.ts`) | localStorage for leads, new storage libs |
| Errors + audit | web: `reportError()` in `lib/errors.ts` (auto-toasts, `scrub()` PII); API: `AuditService`. Failures go to audit log, never swallowed | `console.log` with PII, silent catch |
| File export | `exceljs` (Excel, green header + filter + banded rows + filters sheet), `jspdf` + `jspdf-autotable` (PDF), hand-rolled CSV with injection guard (`lib/__tests__/csv-injection.test.ts`) | new export libs |
| OCR / images — web | `tesseract.js` (lazy), canvas crop in `components/Camera.tsx`/`CropCard.tsx`, `sharp` on API pipeline | new image libs |
| Email / push — API | `nodemailer` (mail), built-in webpush (`common/webpush.ts`, needs `VITE_VAPID_PUBLIC_KEY`) | email SDKs, push services |
| Cache / queue / rate-limit — API | `ioredis` with Postgres fallback (`common/cache.service.ts`, `common/queue.service.ts`) | bull/mq, new queue libs |
| Reusable UI | `components/ui.tsx` (`Tick`, `SortHeader`, `SortMenu`, `BulkBar`, `Spinner`, `Toaster`), `SearchFilterBar`, `TagPicker` | duplicating bulk/sort/select controls per screen |
| Tests | `vitest` unit (`lib/__tests__/`, `test/pipeline.test.ts`), `playwright` e2e (`apps/web/e2e/`), `axe-core` a11y | jest, cypress, new runners |
| New web runtime deps | Forbidden without `npm run size` check first — prefer stdlib / CSS / lazy import | adding packages for one-liners |

## Conventions (must follow)
- Files: screens in `src/screens/`, components in `src/components/`, logic in `src/lib/`. Copyright line lives only in `AppShell` — screens must not add one.
- Touch targets ≥44px (`min-h-11`); inputs `text-base` below `sm` (16px stops iOS zoom); bottom-pinned UI uses `env(safe-area-inset-bottom)`; sheets/scanner use `dvh`.
- One `btn-primary` (green) per screen; blue `ocean-*` for secondary/filter actions.
- Tag code with requirement IDs (e.g. `// LEAD-05`). Scan pipeline order is fixed: quality → crop → OCR → AI extract → validation → normalisation → dupe check → merge/create → enrichment → score → follow-up — one path only.
