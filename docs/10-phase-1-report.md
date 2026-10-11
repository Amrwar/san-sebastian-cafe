# 10 — Phase 1 Report: Foundation

_Completed 2026-10-11 · Status: **done, awaiting approval for Phase 2**_

## 1. Scope delivered

| Area                        | What exists now                                                                                                                                                                                                                                                                                                            | Where                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Monorepo & tooling          | npm workspaces, Turborepo, strict TS 5.9, ESLint 9 (type-aware, jsx-a11y, react-hooks, client→server import ban), Prettier                                                                                                                                                                                                 | root, `packages/config`                             |
| Environment                 | Zod-validated config; fails at startup naming bad variables (never values); refuses placeholder secret, console email and non-HTTPS URL in staging/production                                                                                                                                                              | `packages/env`                                      |
| Domain                      | Integer-cent `Money`, ppm tax-rate math with half-up rounding, CAD formatting per locale; 5 roles × 22 permissions; enum vocabularies per module                                                                                                                                                                           | `packages/domain`                                   |
| Database                    | 24 tables + SQL migration covering users, profiles, notification preferences, categories, products, variants, modifiers, orders, order items, status history, payments, webhook inbox, loyalty accounts/ledger/rewards/redemptions, promotions, delivery zones, audit events, rate limits                                  | `packages/db`, [03-data-model.md](03-data-model.md) |
| Demo data                   | Labelled seed (`is_demo`, `[DÉMO]/[DEMO]`, `demo-` slugs, `.invalid` emails), idempotent re-seed, atomic purge, dev-only reset                                                                                                                                                                                             | `packages/db/src/seed.ts`                           |
| Auth & authorization        | Passwordless email codes (hashed, 10 min, 5 attempts), DB sessions, DB-backed rate limits, role never client-settable, account provisioning hook; `authorize(actor, permission)` in every protected service; page gating (sign-in redirect / localized 403)                                                                | `apps/web/src/server/{auth,authz,session}.ts`       |
| Errors, logging, validation | `AppError` → RFC 9457 problem JSON; request ids; pino JSON logs with PII/secret redaction; Zod body validation                                                                                                                                                                                                             | `apps/web/src/server/{errors,http,logger}.ts`       |
| Localization                | next-intl, `fr` default (always at `/`), `en`; ICU plurals; catalog parity test; `lang` per page; Montréal time zone                                                                                                                                                                                                       | `apps/web/messages`, `src/i18n`                     |
| Design system               | Tokens (palette, type, radii, shadow, motion), contrast-checked; Button (6 variants), TextField, SelectField, CheckboxField, Alert, Badge, EmptyState, Container, PageHeader, Surface, SkipLink                                                                                                                            | `packages/ui`                                       |
| Shell & pages               | Sticky header, mobile disclosure nav (Esc/focus return), language switch, footer with dev notice; Home, Menu preview (read-only, from DB), Sign-in, Account (profile, language, order emails, marketing consent), Staff overview (orders by status), Admin overview (catalog real-vs-demo, audit log), 404, error boundary | `apps/web/src/app/[locale]`                         |
| API                         | `GET /api/health`, `GET /api/v1/menu`, `GET/PUT /api/v1/me/settings`, `/api/auth/*`                                                                                                                                                                                                                                        | `apps/web/src/app/api`                              |
| CI                          | GitHub Actions: format, typecheck, lint, unit, migrate + double seed, **migration drift check**, integration, build, Playwright E2E                                                                                                                                                                                        | `.github/workflows/ci.yml`                          |

No fake functionality: the home page lists ordering, stamp card and tracking under "Coming to the app — not available yet"; the menu has no add/order buttons; staff and admin pages show only real database data.

## 2. Test results (all run locally on 2026-10-11, Windows 11, Node 22.16, Postgres 17)

| Suite                         | Command                                        | Result                                                                                |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Formatting                    | `npm run format:check`                         | ✔ all files                                                                           |
| Types                         | `npm run typecheck` (5 workspaces)             | ✔ 0 errors                                                                            |
| Lint                          | `npm run lint` (5 workspaces)                  | ✔ 0 errors, 0 warnings                                                                |
| Unit                          | `npm run test`                                 | ✔ **40 passed** (domain 16, env 3, ui 4, web 17)                                      |
| Integration (Postgres)        | `npm run test:integration`                     | ✔ **47 passed** (db constraints 12, web services 35)                                  |
| End-to-end (Playwright + axe) | `npm run test:e2e`                             | ✔ **22 passed**, 1 skipped by design (mobile-only toggle test in the desktop project) |
| Migrations                    | `npm run db:migrate`, `db:seed` ×2, `db:reset` | ✔                                                                                     |
| Schema drift                  | `drizzle-kit generate`                         | ✔ "No schema changes"                                                                 |
| Production build              | `next build`                                   | ✔                                                                                     |

**Not yet run:** the GitHub Actions workflow itself — it executes on the first push of this phase.

Highlights of what the tests prove: tampered/unknown fields cannot change a user's role or another user's data; every protected service rejects anonymous (401) and under-privileged (403) actors across all 5 roles; DB rejects totals that don't add up, duplicate webhook events, double stamp earning, double reward redemption and negative balances; sign-in works end to end with an emailed code; WCAG 2.2 AA automated checks pass on home, menu, sign-in, account, staff, admin (desktop and Pixel 7).

### Defects found and fixed during the phase

1. **Tax math:** QST 9.975% cannot be expressed in basis points; switched to parts-per-million (unit test caught it).
2. **Contrast:** hero button override lost the CSS cascade (dark text on burgundy); added dedicated `accent`/`inverse` variants (axe caught it).
3. **Language default:** English browsers were redirected to `/en`; now `/` always serves French (decision D20 for the owner).
4. **Deprecated APIs:** migrated next-intl to `next/root-params`; replaced deprecated React `FormEvent` usage.

## 3. Review

- **Security:** no secrets in code (`.env` git-ignored, CI uses a throwaway secret); HTTP-only session cookies (`Secure` in staging/production), SameSite=Lax; Better Auth origin checks; rate-limited code requests (5 / 5 min) and verifications (10 / 5 min); open-redirect guard on `?next=`; no card data anywhere; security headers (nosniff, frame DENY, referrer, permissions, HSTS); logs redact email/phone/code/token/address.
- **Privacy (Law 25 / CASL):** marketing consent off by default, separate and unticked, timestamped and audited on grant/withdrawal; transactional emails separate from marketing.
- **Accessibility:** skip link, landmarks, visible focus rings, labelled fields with linked hints/errors, `aria-current`, 44 px targets, `prefers-reduced-motion`, page `lang`, axe-clean.
- **Responsive:** 320–1280 px, no horizontal scroll (tested), mobile disclosure nav.
- **Failure states:** invalid env → refuses to start; DB down → `/api/health` 503; unknown routes → localized 404; render errors → localized boundary with reference id; invalid input → field errors / 400 problem; wrong/expired code and rate limiting → specific messages.
- **Dependencies:** `npm audit` reports 4 moderate advisories, all in **drizzle-kit's bundled esbuild** (dev-server request issue). drizzle-kit is a local CLI, never shipped or run as a server; the suggested "fix" is a breaking downgrade, so it was not applied. Re-check on drizzle-kit updates.

## 4. Unresolved issues / known gaps (deliberate, tracked)

| Item                                                                                                                | Plan                                              |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| No real email provider — production sign-in impossible (env validation blocks deploy)                               | Phase 7, needs D22                                |
| Content-Security-Policy not set                                                                                     | Phase 15 (after payment scripts known)            |
| `PUT /api/v1/me/settings` relies on SameSite=Lax + JSON content type for CSRF protection; add explicit Origin check | Phase 4 completion                                |
| Rate limit is per IP: many customers on café Wi-Fi could share a limit                                              | Tune with real traffic; consider per-email limits |
| PWA manifest, icons, service worker; full component set (dialog, sheet, toast, tabs, skeleton, quantity stepper)    | Phase 2                                           |
| Roles are changed only in the database                                                                              | Phase 9 staff management                          |
| Fonts (Newsreader, Figtree — OFL) are placeholders until brand fonts are supplied                                   | Owner                                             |
| CI workflow not yet executed on GitHub                                                                              | Next push                                         |

## 5. Blockers and owner input still needed

- **R1 / D1 — Québec mandatory billing (SRS/WEB-SRM) and the café's POS.** Blocks payments provider choice (Phase 6) and any live sales.
- **D2** payment processor · **D21** hosting/database region (Canadian residency, Law 25 PIA) · **D22** email provider and domain.
- **D20** French-only default at `/` (legal/owner confirmation).
- Golden Crema hex: `#38251F` was supplied (same as Espresso); `#D7B77A` is in use — please confirm.
- Real menu, prices, hours, GST/QST numbers, logo, photography, privacy officer (see [07-open-decisions.md](07-open-decisions.md) §C).

## 6. Next phase

**Phase 2 — Design system & PWA shell**: remaining components (dialog/sheet, toast, tabs, skeletons, segmented control, chips, quantity stepper, price), product card/hero patterns from [09-design-direction.md](09-design-direction.md), dev-only `/design` catalog page, PWA manifest + icons + offline page (no caching of prices/orders), visual review at 320/768/1280 in both languages. Not started — awaiting approval.
