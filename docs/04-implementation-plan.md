# 04 — Implementation Plan & Phase Checklist

_Status: **Phase 3 complete (2026-10-11)** — menu & order-management domain and staff queue. Next: payment integration (Phase 6, provider decision ⛔ D1/D2). Reports: [Phase 1](10-phase-1-report.md), [Phase 2](11-phase-2-report.md), [Phase 3](12-phase-3-report.md)._

> Scope note: the owner's Phase 2 brief covered the complete customer-facing experience, so parts of Phases 3, 5 and 8 were delivered early (pricing/tax/promotion/reward quote engine, pickup scheduling, menu & cart, read-only loyalty/orders/favorites views). Order **placement**, payments, loyalty **earning/redemption writes**, and staff status changes remain in Phases 6–8.
>
> The owner's Phase 3 brief likewise covered the full order-management domain: order placement, scheduling and capacity, the order state machine, cancellations and refunds, loyalty earning/redemption writes, and the staff order queue — with a **development payment simulator** in place of a real provider. What remains for Phase 6 is the real payment provider and its webhooks. Phase 7 still needs push/realtime (the queue polls) and notifications. The Phase 3 exit criteria of ≥95 % branch coverage and property-based tests are **not yet met** (no coverage tooling or fast-check yet) and carry forward.

Every phase ends with: typecheck ✔ · lint ✔ · unit/integration/E2E tests for the phase ✔ · security, a11y, responsive and failure-state review · docs and this checklist updated · a written report (done / test results / open issues / next).

Legend: ☐ not started · ◐ in progress · ☑ done · ⛔ blocked on owner decision

| #   | Phase                                                    | Status                       |
| --- | -------------------------------------------------------- | ---------------------------- |
| 0   | Discovery & planning                                     | ☑                            |
| 1   | Foundation & tooling                                     | ☑                            |
| 2   | Design system & PWA shell                                | ☑                            |
| 3   | Domain core (pricing, tax, loyalty, order state machine) | ☑ (coverage target open)     |
| 4   | Auth, accounts, roles                                    | ◐                            |
| 5   | Menu browsing, product customization, cart               | ☑                            |
| 6   | Checkout, pickup scheduling, payments                    | ◐ (provider choice ⛔ D1/D2) |
| 7   | Staff order console, realtime, notifications             | ◐                            |
| 8   | Loyalty wallet, history, favorites, reorder, receipts    | ◐                            |
| 9   | Admin: menu, store settings, loyalty rules, staff, audit | ☐                            |
| 10  | Reporting & exports                                      | ☐                            |
| 11  | Privacy & compliance features                            | ☐                            |
| 12  | POS / SRS integration                                    | ⛔ D1                        |
| 13  | Growth: promotions, referrals, communications            | ☐                            |
| 14  | Gift cards · delivery · inventory (each optional)        | ⛔ owner                     |
| 15  | Hardening & launch readiness                             | ☐                            |

---

## Phase 1 — Foundation & tooling ☑

Delivered (2026-10-11):

- ☑ npm-workspaces + Turborepo monorepo; strict TypeScript; ESLint (type-aware, jsx-a11y, client/server import boundary); Prettier
- ☑ `packages/env` validated environment (fails fast; production guards)
- ☑ `packages/domain`: money (integer cents, ppm rates), roles/permission matrix, module vocabularies
- ☑ `packages/db`: full core schema (24 tables) + SQL migration, demo seed/purge/reset, test-DB helper
- ☑ Auth foundation: passwordless email codes, DB sessions, DB rate limits, roles, account provisioning
- ☑ Service-level authorization (`authorize(actor, permission)`) + page gating (sign-in redirect / 403 view)
- ☑ Errors (typed `AppError` → RFC 9457), pino JSON logs with redaction + request ids, Zod request validation
- ☑ next-intl FR/EN (French default) with catalog parity test
- ☑ Design tokens + accessible Button / Field / Select / Checkbox / Alert / Badge / EmptyState / layout primitives
- ☑ Responsive shell (header, mobile disclosure nav, skip link, language switch, footer)
- ☑ Pages: home, menu preview (read-only), sign-in, account (profile + consent), staff overview, admin overview, 404/error
- ☑ API: `/api/health`, `/api/v1/menu`, `/api/v1/me/settings` (GET/PUT), `/api/auth/*`
- ☑ Vitest unit + Postgres integration tests, Playwright + axe E2E (desktop + mobile), GitHub Actions CI
- Pulled forward from later phases: auth/roles foundation (Phase 4 ◐), design tokens & primitives (Phase 2 ◐)

Original scope:

**Scope:** git init, pnpm + Turborepo monorepo, `apps/web` (Next.js 16) and `packages/{domain,contracts,db,services,adapters,ui,i18n,env,config}` skeletons, strict TS, ESLint (with boundary rules) and Prettier, Vitest, Playwright, docker-compose (Postgres 16, Mailpit), Drizzle setup with a first migration (`locations`, `settings`, `audit_log`, `outbox`), Zod env validation, pino logger with request ID, RFC 9457 error mapping, next-intl routing (`/fr` default, `/en`), health endpoint, and GitHub Actions CI. README setup guide.
**Exit:** `pnpm i && pnpm db:up && pnpm db:migrate && pnpm dev` works on a clean machine. CI runs green. A sample unit test, an integration test (Testcontainers) and an E2E smoke test (both locales) pass.

## Phase 2 — Design system & PWA shell

**Scope:** tokens (color, type, spacing, radius, elevation, motion) as CSS variables with Tailwind v4 theme; font selection and loading; primitives (Button, IconButton, Field/Input/Select/Textarea, Checkbox/Radio/Switch, Chip/SegmentedControl, Dialog/Sheet, Toast, Tabs, Skeleton, EmptyState, ErrorState, Price, QuantityStepper, Badge); ProductCard and ProductHero patterns; app shell (header, bottom nav on mobile, side nav on desktop, language switcher); a `/design` catalog page (dev only); PWA manifest, icons (placeholder), service worker (app shell + offline page; **no caching of prices or orders**). See [09-design-direction.md](09-design-direction.md).
**Exit:** every component passes axe, has keyboard and focus states, and renders in FR and EN at 320 / 768 / 1280 px with visual review screenshots. Lighthouse PWA installable.

## Phase 3 — Domain core (pure, no I/O)

**Scope:** `Money`, pricing (base + modifiers + option price rules), promotions interface (stub), loyalty engine (earn, convert, reserve/commit/release, reverse), GST/QST calculation with rounding rules, order state machine with role permissions, pickup slot generation from hours, closures, lead time and capacity.
**Exit:** ≥95% branch coverage on `domain`. Property-based tests (fast-check) for money/tax invariants and loyalty ledger invariants.

## Phase 4 — Auth, accounts, roles

**Scope:** Better Auth (email OTP / magic link via the Notifier), guest identity, profile and locale preference, consents, role/permission matrix, staff/admin route guards, rate limiting on auth endpoints, CSRF, secure cookie settings, dev seed users per role.
**Exit:** integration tests prove that every privileged service rejects unauthorized actors. E2E covers sign up, sign in and sign out in both locales.

## Phase 5 — Menu, customization, cart

**Scope:** catalog + modifier schema and **placeholder seed** (clearly labelled); menu listing (categories, search, filters for dietary needs); product page with size, temperature, milk, syrups, shots and extras; server-quoted cart (`/cart/quote`); availability and opening-hours enforcement; image pipeline (`next/image`, blur placeholders).
**Exit:** a tampered client price is ignored (test). Sold-out and closed states, and min/max modifier rules, are enforced server-side.

## Phase 6 — Checkout, scheduling, payments

**Scope:** `PaymentProvider` interface + `FakePaymentProvider` + chosen real adapter in test mode; idempotent order creation; slot reservation; tip UI compliant with the QC rule (pre-tax base, equal emphasis, custom/none); webhook inbox and processing; order expiry job; return page that polls server state; refunds (service level).
**Exit:** integration tests cover duplicate webhooks, out-of-order webhooks, a replayed idempotency key, payment failure, expiry releasing slot and reward, and that a browser redirect alone never marks an order paid. E2E runs a full order on the fake provider. When test keys exist, a real-provider test-mode run is also done. **Blocked for the real adapter** until D1/D2 are answered; the fake path proceeds.

## Phase 7 — Staff console, realtime, notifications

**Scope:** live queue (SSE + fallback), status actions with optimistic locking, sound and visual alerts, pause ordering, 86 toggles, customer order tracking page, outbox worker, Web Push (VAPID), transactional emails (FR/EN templates), dev Mailpit.
**Exit:** concurrent transition test (two staff tap at once → one wins, one gets a clear conflict). A push/email is sent exactly once per event (outbox test). Tablet-layout E2E.

## Phase 8 — Loyalty & customer history

**Scope:** stamp card UI, rewards wallet, redemption at checkout, ledger history, guest-order stamp claim, favorites with saved configuration, reorder (re-priced with current prices and availability), order history and order confirmation/receipt view.
**Exit:** loyalty integration tests cover concurrency (two simultaneous redemptions of one reward → exactly one succeeds), refund reversal, and that reward-paid drinks don't earn.

## Phase 9 — Admin

**Scope:** menu CRUD (bilingual, required alt text, image upload via Storage adapter, preview, reorder), modifier groups, hours, closures, slot settings, tax config (effective-dated), loyalty program versions, staff invitations and roles, audit log viewer.
**Exit:** every admin mutation is audited and permission-tested. Price changes don't alter existing orders.

## Phase 10 — Reporting

**Scope:** sales by day/hour/product/category, GST/QST collected, tips, refunds, loyalty liability (outstanding rewards), CSV export, all in the America/Toronto timezone.
**Exit:** report totals reconcile with order and payment data in fixture tests.

## Phase 11 — Privacy & compliance features

**Scope:** privacy policy and terms pages (owner/lawyer text, FR first), cookie/consent handling (functional only by default), data export (JSON), deletion and anonymization workflow with tax-record retention, privacy request tracking, confidentiality-incident register (admin), retention jobs.
**Exit:** export/delete E2E. PII redaction in logs verified.

## Phase 12 — POS / SRS integration ⛔

**Scope depends on D1:** push paid online orders into the café's certified POS so the legal bill (QC mandatory billing) is produced, and optionally sync catalog and in-store loyalty earning. Until then the platform runs with `pos: none` and **must not be used for live sales** until R1 is resolved.

## Phase 13 — Growth

Promotions engine and admin, promo code at checkout (stacking rules), referral program with fraud limits, consented marketing email (CASL: identification, unsubscribe within 10 business days), notification preferences.

## Phase 14 — Optional modules (each needs an owner go-ahead)

Gift cards (no expiry/fees, liability ledger, or POS-native), delivery (zones, fees, third-party courier adapter), inventory (stock counts → auto-86).

## Phase 15 — Hardening & launch

Security review (authz matrix tests, dependency audit, CSP, headers, rate limits, secrets), manual accessibility audit with NVDA and VoiceOver, performance budgets, load test of order placement and webhooks, backup/restore drill, production environment in Canadian regions, monitoring and alerting, runbooks (payment outage, webhook backlog, refund), staff training guide, soft launch checklist.
