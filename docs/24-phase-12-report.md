# 24 — Phase 12 Report: Hardening & Launch Readiness

_2026-10-26. No migration. Scope: the parts of
[04 Phase 15](04-implementation-plan.md#phase-15--hardening--launch) that don't wait on owner
decisions._

**Status in one line:** the critical Next.js vulnerability is patched; pages run under a strict,
per-request Content Security Policy; abuse-prone actions are rate-limited; an automated sweep
proves every private API route refuses anonymous callers (it found and fixed three that didn't);
the health check now catches a deploy whose database wasn't migrated; and there is an operations
runbook, a soft-launch checklist and a staff guide in French.

## 1. What was done

### Dependencies

| Package    | Was    | Now    | Why                                                                           |
| ---------- | ------ | ------ | ----------------------------------------------------------------------------- |
| next       | 16.4.0 | 16.4.3 | **Critical**: remote code execution and denial-of-service advisories          |
| nodemailer | 10.1.0 | 10.2.1 | Moderate: address parsing could add or redirect recipients                    |
| zod        | 4.6.5  | 4.6.7  | High: memory exhaustion on oversized input (also forced under `@vercel/blob`) |

`npm audit --omit=dev` now reports only a moderate esbuild issue inside `drizzle-kit`, a
development tool that never runs in production (it affects its local dev server only).

### Content Security Policy

- **Every page** gets a fresh nonce and this policy:
  - scripts only from the site and carrying that nonce (`strict-dynamic`);
  - styles from the site;
  - images from the site and the Vercel Blob store;
  - no frames, plugins, outside forms or framing by others;
  - `upgrade-insecure-requests` over HTTPS.
- **API responses** get `default-src 'none'`.
- **Allowed exception:** inline style attributes (image sizing, chart bars), which can't run code.
- **Stripe:** payment is a redirect to Stripe's page, so no Stripe origin is needed.
- Built into `src/proxy.ts` alongside the language routing, following the installed Next.js guide.

### Rate limits

Counters are in the database, shared by all server instances, one window per action and requester
(account, or a hash of the address):

| Action                               | Limit         |
| ------------------------------------ | ------------- |
| Place an order                       | 10 / minute   |
| Price a cart (promo code guesses)    | 120 / minute  |
| Enter a referral code                | 10 / hour     |
| Unsubscribe link                     | 30 / hour     |
| Download my data / delete my account | 5 / hour each |
| Report CSV export                    | 60 / hour     |
| Register a push device               | 20 / hour     |

Over the limit: `429` with `reason: rate_limited`. Limits are 20 times looser when the app runs
for end-to-end tests (one address for all tests). Sign-in already had its own limits.

### Route sweep (found and fixed three gaps)

A test reads every route file under `api/v1/admin`, `staff` and `me` and calls each method with no
session. Every one must answer 401, and a new route can't be forgotten. It found:

- `POST /me/favorites` checked the body before the session (400 instead of 401);
- `GET /me/orders/:id` and `…/status` answered 404 (the shared lookup also serves guests with an
  order link). They now require sign-in; guests keep `/api/v1/orders/:id` with their link.

`PUT /me/settings` now also checks the session before the body. Cross-site state-changing requests
are refused (tested).

### Health and monitoring

`/api/health` now reports:

- `database`: reachable or not;
- `schema`: migrations applied vs expected. **503 when the database is behind the code**, which
  is the situation found on Neon this week;
- `notifications`: queued messages and the age of the oldest. `degraded` after 10 minutes, which
  means the outbox job isn't running.

Counts only, no personal data.

### Documents

- **[22 Operations runbook](22-operations-runbook.md):**
  - safe deploys (migrate before pushing);
  - scheduled jobs (and the Hobby-plan limit);
  - monitoring and alerts;
  - incidents: payment outage, webhook backlog, refunds, privacy incident, leaked secret or
    departing staff;
  - backup and restore drill;
  - soft-launch checklist.
- **[23 Guide de l'équipe](23-staff-guide.md)** (in French for the counter team): queue, pause,
  sold-out, cancellations and refunds, counter loyalty, what never to do.

## 2. Test results

| Suite                             | Result                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Typecheck · ESLint · Prettier     | ✔ clean                                                                             |
| Unit                              | ✔ web 47, domain 107, env 9, ui 4                                                   |
| Integration — web (real Postgres) | ✔ see §2.1 (incl. 2 new rate-limit tests: budget and window; simultaneous requests) |
| E2E — Playwright + axe            | ✔ see §2.1 (new: `security.spec` CSP, `api-guard.spec` route sweep and CSRF)        |

### 2.1 Totals

Integration: **217 passed** (14 files). E2E: **84 passed, 2 skipped** (Stripe sandbox), on Next.js 16.4.3 with the CSP and rate limits in place. This run also covers the Growth phase, whose full rerun had been stopped for low memory.

## 3. Not done here (needs you or a decision)

- **Manual accessibility audit** with NVDA and VoiceOver (automated axe checks pass on every
  tested screen; a person must still do this).
- ~~**Load test** of order placement and webhooks against a staging copy (no staging yet).~~
  **Done locally 2026-10-26** against a production build: `npm run test:load -w @ssc/web`,
  results and budgets in [runbook §6](22-operations-runbook.md#6-load-test). Repeat on a
  staging copy once one exists.
- **Canadian regions** (D21), **error tracking service** (e.g. Sentry: an account to choose),
  **uptime monitor** (an account to choose), **Vercel plan** for per-minute jobs.
- Everything in the soft-launch checklist marked as an owner decision.

## 4. Follow-up (2026-10-26)

- **Backup and restore drill (2026-10-28):** `npm run db:restore-drill` dumps the database,
  restores it into a scratch database and checks the copy (integrity rules: migrations,
  constraints, loyalty and gift card balances against their ledgers, refunds against payments,
  paid orders against money received, stock against movements; row counts against the dump's
  own snapshot). Local run passed in 3.7 s; see [runbook §5](22-operations-runbook.md#5-backups-and-restore-drill).
  `db:backup`, `db:restore` (empty targets only, file checked against its manifest) and
  `db:verify` are separate commands. Still to do on the production Neon project before launch.

- **Performance budgets** (`e2e/performance.spec.ts`, part of `npm run test:e2e`): each key page
  is loaded cold on the production build and must stay within its JavaScript budget (compressed),
  LCP ≤ 2.5 s and CLS ≤ 0.1.

  | Page            | JS today | JS budget | LCP (local) | CLS |
  | --------------- | -------- | --------- | ----------- | --- |
  | Home            | 161 KB   | 195 KB    | 420 ms      | 0   |
  | Menu            | 161 KB   | 195 KB    | 140 ms      | 0   |
  | Product (latte) | 165 KB   | 200 KB    | 156 ms      | 0   |
  | Cart            | 161 KB   | 195 KB    | 112 ms      | 0   |
  | Sign-in         | 171 KB   | 205 KB    | 132 ms      | 0   |
  | Staff queue     | 160 KB   | 195 KB    | 160 ms      | 0   |

  LCP is measured without throttling, so it flags regressions rather than real-phone speed.

- **Load test**: see §3 and [runbook §6](22-operations-runbook.md#6-load-test).
- **Domain coverage**: the Phase 3 target (≥95 % branches, property-based tests) is met and
  enforced in CI (see [Phase 3 report](12-phase-3-report.md)).
