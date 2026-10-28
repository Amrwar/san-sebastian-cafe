# San Sebastian Café — Ordering & Loyalty Platform

Customer PWA, staff/owner console, and backend for San Sebastian Café (Montréal, QC).

**Status:** Phase 4 (payments) implemented: Stripe Checkout, webhooks, refunds and recovery — see the [Phase 4 report](docs/14-phase-4-report.md) and the [payments runbook](docs/13-payments.md). Verified end to end in the Stripe sandbox on 2026-10-26 (payments, declines, 3-D Secure, refunds, disputes); production payments are **not** enabled.
With `PAYMENT_PROVIDER=none` (the default, and the Vercel demo) orders cannot be placed and nothing is
charged. All menu items, prices, hours and accounts in development databases are clearly labelled
demonstration data.

## Requirements

| Tool           | Version                      | Notes                                            |
| -------------- | ---------------------------- | ------------------------------------------------ |
| Node.js        | ≥ 22.12 (24 LTS in CI)       |                                                  |
| npm            | ≥ 10 (workspaces)            | Bundled with Node. No pnpm/yarn needed.          |
| Docker Desktop | any recent                   | Runs local PostgreSQL 17 on port **5442**        |
| Internet       | for `npm ci` and first build | `next/font` downloads Google Fonts at build time |

## First-time setup

```bash
npm install                          # install all workspaces
cp .env.example .env                 # then set BETTER_AUTH_SECRET (command below)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

npm run db:up                        # start Postgres (creates ssc_dev, ssc_test, ssc_e2e)
npm run db:migrate                   # apply SQL migrations
npm run db:seed                      # load DEMO data (safe to re-run; refuses in staging/production)
npm run dev                          # http://localhost:3000 → redirects to /fr
```

> If the Postgres volume existed before `ssc_e2e` was added, create it once:
> `docker exec ssc-postgres psql -U ssc -d ssc_dev -c "CREATE DATABASE ssc_e2e OWNER ssc;"`

### Environment variables

All variables are validated at startup by [`packages/env`](packages/env/src/index.ts); the app refuses to
start with a clear message naming the invalid variable (values are never printed).

| Variable                                                   | Purpose                                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                                  | `development` \| `test` \| `staging` \| `production`                                                                                |
| `LOG_LEVEL`                                                | pino level (`debug` locally)                                                                                                        |
| `DATABASE_URL`                                             | Application database                                                                                                                |
| `DATABASE_URL_TEST`                                        | Integration tests — **wiped on every run**; name must contain `test`                                                                |
| `DATABASE_URL_E2E`                                         | Playwright — **wiped and re-seeded on every run**; name must contain `e2e`                                                          |
| `BETTER_AUTH_URL`                                          | Public base URL (must be `https` in staging/production)                                                                             |
| `BETTER_AUTH_SECRET`                                       | ≥ 32 random chars; the placeholder is rejected in staging/production                                                                |
| `EMAIL_TRANSPORT`                                          | `console` (development only: printed and saved in `apps/web/.dev-mail`) · `smtp` (via `SMTP_URL`; required when deployed)           |
| `SMTP_URL`                                                 | `smtp://localhost:1025` for Mailpit (`docker compose up -d mailpit`, inbox at http://localhost:8025); `smtps://…` when deployed     |
| `EMAIL_FROM`                                               | Sender shown on emails                                                                                                              |
| `PAYMENT_PROVIDER`                                         | `none` (default: orders can't be placed) · `fake` (development simulator, no money moves; refused in staging/production) · `stripe` |
| `STRIPE_SECRET_KEY`                                        | Stripe secret/restricted key — test mode except in production (live keys refused elsewhere)                                         |
| `STRIPE_WEBHOOK_SECRET`                                    | Signing secret of the webhook endpoint or of `stripe listen`                                                                        |
| `CRON_SECRET`                                              | Enables the scheduled jobs (Bearer): `/api/cron/payments` (5–10 min), `/api/cron/outbox` (1 min), `/api/cron/retention` (daily)     |
| `STORAGE_DRIVER`                                           | Product photos: `local` (default; `apps/web/.dev-uploads`, refused in staging/production) · `vercel-blob`                           |
| `BLOB_STORE_ID`                                            | Set by Vercel when a Blob store is connected (with `vercel-blob`; authenticates through the deployment's OIDC token)                |
| `BLOB_READ_WRITE_TOKEN`                                    | Alternative to `BLOB_STORE_ID` for using the Blob store outside Vercel                                                              |
| `VAPID_PUBLIC_KEY` · `VAPID_PRIVATE_KEY` · `VAPID_SUBJECT` | Web Push (order ready/cancelled notices); generate with `npx web-push generate-vapid-keys`. All three or none                       |

## Signing in locally

Sign-in is passwordless: enter an email, then the 6-digit code. In development **no email is sent** —
the code is printed in the `npm run dev` terminal inside a `DEV EMAIL (not sent)` box (and written to
`apps/web/.dev-mail/`). Demo accounts (seeded, `is_demo = true`, unreachable `.invalid` domain):

| Email                                 | Role       | Can open              |
| ------------------------------------- | ---------- | --------------------- |
| `owner@demo.san-sebastian.invalid`    | owner      | account, staff, admin |
| `manager@demo.san-sebastian.invalid`  | manager    | account, staff, admin |
| `lead@demo.san-sebastian.invalid`     | shift_lead | account, staff        |
| `staff@demo.san-sebastian.invalid`    | staff      | account, staff        |
| `customer@demo.san-sebastian.invalid` | customer   | account               |

Any other email creates a new **customer** account. Roles can only be changed in the database for now
(staff management UI is Phase 9).

### Trying an order end to end (development)

Set `PAYMENT_PROVIDER=fake` in `.env`, then: add items → **Commander et payer** → on the payment step use
**Simuler un paiement accepté** → sign in as `staff@…` in another browser and open **/fr/staff** to accept,
start, mark ready and hand over the order; the customer's order page follows along automatically.
Products can be taken off sale from **/fr/staff/availability**. Shift leads and managers refund from
**/fr/staff/payments**.

To pay through the **Stripe sandbox** instead, follow [docs/13-payments.md §3](docs/13-payments.md#local-sandbox)
(test-mode keys, `stripe listen`, test card 4242 4242 4242 4242).

## Verifying the foundation

```bash
npm run typecheck          # strict TypeScript, all workspaces
npm run lint               # ESLint (type-aware, jsx-a11y, client/server import boundaries)
npm run format:check       # Prettier
npm run test               # unit tests (domain, env, ui, web)
npm run test:integration   # Postgres integration tests (uses DATABASE_URL_TEST; db must be up)
npm run test:e2e           # builds the app and runs Playwright + axe on :3100 (uses DATABASE_URL_E2E)
npm run test:load -w @ssc/web  # builds the app and load-tests ordering and webhooks on :3200 (uses DATABASE_URL_LOAD)
npm run check              # typecheck + lint + unit tests
```

Manual smoke test: `GET http://localhost:3000/api/health` → `{"status":"ok","database":"ok"}`;
`/fr/menu` shows demo products with a warning banner; switch language with the header button.

## Data scripts

| Command                                  | Effect                                                          |
| ---------------------------------------- | --------------------------------------------------------------- |
| `npm run db:generate -- --name <change>` | Generate a SQL migration after editing `packages/db/src/schema` |
| `npm run db:migrate`                     | Apply pending migrations                                        |
| `npm run db:seed`                        | Replace all demo rows with a fresh copy (real rows untouched)   |
| `npm run db:purge-demo`                  | Delete every `is_demo` row — run before going live              |
| `npm run db:reset`                       | Drop, migrate and re-seed (development only)                    |
| `npm run db:down`                        | Stop Postgres (data volume kept)                                |

## Repository layout

```
apps/web            Next.js 16 app: customer pages, /staff, /admin, /api (v1 + auth + health)
  src/server        env, logger, db, auth, errors, http wrapper, authz, session, mailer, audit
  src/server/modules  business services by module (identity, catalog, ordering, admin)
  messages/         fr.json (default) and en.json UI catalogs
  e2e/              Playwright tests
packages/domain     pure business vocabulary & rules (money, roles/permissions, enums)
packages/db         Drizzle schema, SQL migrations, seed/purge, test-database helper
packages/env        environment validation
packages/ui         design tokens (theme.css) and accessible components
packages/config     shared tsconfig + ESLint
docs/               planning and phase documentation
```

## Documentation

| Doc                                                          | Contents                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [00 Repository inspection](docs/00-repository-inspection.md) | Environment and tooling findings                                                      |
| [01 Product requirements](docs/01-product-requirements.md)   | Goals, personas, functional & non-functional requirements                             |
| [02 Architecture](docs/02-architecture.md)                   | Stack, rationale, module boundaries, API, payment evaluation                          |
| [03 Data model](docs/03-data-model.md)                       | Implemented schema: ownership, constraints, transaction boundaries                    |
| [04 Implementation plan](docs/04-implementation-plan.md)     | Phased roadmap and checklist                                                          |
| [05 Risk register](docs/05-risk-register.md)                 | Risks and mitigations                                                                 |
| [06 Acceptance criteria](docs/06-acceptance-criteria.md)     | Testable criteria                                                                     |
| [07 Open decisions](docs/07-open-decisions.md)               | What the owner must decide or supply                                                  |
| [08 Compliance notes](docs/08-compliance-notes.md)           | Québec/Canada obligations (requires professional confirmation)                        |
| [09 Design direction](docs/09-design-direction.md)           | Palette, type, references, key screens                                                |
| [10 Phase 1 report](docs/10-phase-1-report.md)               | What was built, test results, open issues, blockers                                   |
| [11 Phase 2 report](docs/11-phase-2-report.md)               | Customer experience: pages, contracts, states, tests, limitations                     |
| [12 Phase 3 report](docs/12-phase-3-report.md)               | Ordering domain, staff queue, API, tests, limitations                                 |
| [13 Payments](docs/13-payments.md)                           | Provider decision, flow, setup, webhooks, refunds, recovery, launch checklist         |
| [14 Phase 4 report](docs/14-phase-4-report.md)               | Payments: what was built, tests, limitations                                          |
| [15 Phase 5 report](docs/15-phase-5-report.md)               | Loyalty engine, counter stamps, staff support                                         |
| [16 Phase 6 report](docs/16-phase-6-report.md)               | Admin console, product photos (Vercel Blob)                                           |
| [17 Phase 7 report](docs/17-phase-7-report.md)               | Reporting: sales, taxes, tips, refunds, loyalty, CSV exports                          |
| [18 Phase 8 report](docs/18-phase-8-report.md)               | Privacy (Law 25): data export, deletion, requests, incidents, retention               |
| [19 Phase 9 report](docs/19-phase-9-report.md)               | Live queue and tracking, order emails, Web Push                                       |
| [20 Phase 10 report](docs/20-phase-10-report.md)             | Guest-order stamp claim; accounts and loyalty phases closed                           |
| [21 Phase 11 report](docs/21-phase-11-report.md)             | Growth: promotions admin, marketing email (CASL), referrals                           |
| [22 Operations runbook](docs/22-operations-runbook.md)       | Deploys and migrations, jobs, monitoring, incidents, restore drill, launch checklist  |
| [23 Staff guide](docs/23-staff-guide.md)                     | Guide de l’équipe (French): queue, pause, refunds, counter loyalty                    |
| [24 Phase 12 report](docs/24-phase-12-report.md)             | Hardening: security upgrade, CSP, rate limits, route sweep, health                    |
| [26 Gift cards report](docs/26-gift-cards-report.md)         | Gift cards: counter and online sale, online and counter use, refunds, liability       |
| [25 Inventory report](docs/25-inventory-report.md)           | Stock counts, auto-86 at zero, low-stock alerts, history, ledger                      |
| [27 Delivery report](docs/27-delivery-report.md)             | Delivery zones, courier step, on-its-way notice, fees in reports (built switched off) |

## Deployment (Vercel demo)

- Project `san-sebastian-cafe` on Vercel, deployed from `main`: https://san-sebastian-cafe.vercel.app
- Database: Neon Postgres (US East) provisioned through the Vercel Marketplace, which sets `DATABASE_URL`
  and `DATABASE_URL_UNPOOLED`. **Demo data only** until the Law 25 privacy impact assessment is done (D21).
- Vercel variables: `APP_ENV=development` (required explicitly; sign-in codes appear in the function logs
  because no email provider exists yet), `BETTER_AUTH_SECRET` (sensitive), `BETTER_AUTH_URL` (production;
  previews derive it from `VERCEL_URL`), `EMAIL_FROM`, `LOG_LEVEL`.
- Product photos: create a **public** Blob store (Vercel dashboard → Storage → Create → Blob, access
  _Public_) and connect it to the project, which sets the Blob credentials. Then add
  `STORAGE_DRIVER=vercel-blob` and redeploy. Until then, photo uploads on Vercel are refused with a
  "storage not set up" message; the rest of the app is unaffected.
- Migrations are not run during the build. After a schema change, run `npm run db:migrate` against
  `DATABASE_URL_UNPOOLED` before (or right after) deploying.
