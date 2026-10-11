# San Sebastian Café — Ordering & Loyalty Platform

Customer PWA, staff/owner console, and backend for San Sebastian Café (Montréal, QC).

**Status:** Phase 1 (foundation) complete — see the [Phase 1 report](docs/10-phase-1-report.md).
Online ordering, payments and loyalty are **not** implemented yet. All menu items, prices and accounts
in a development database are clearly labelled demonstration data.

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

| Variable             | Purpose                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `APP_ENV`            | `development` \| `test` \| `staging` \| `production`                        |
| `LOG_LEVEL`          | pino level (`debug` locally)                                                |
| `DATABASE_URL`       | Application database                                                        |
| `DATABASE_URL_TEST`  | Integration tests — **wiped on every run**; name must contain `test`        |
| `DATABASE_URL_E2E`   | Playwright — **wiped and re-seeded on every run**; name must contain `e2e`  |
| `BETTER_AUTH_URL`    | Public base URL (must be `https` in staging/production)                     |
| `BETTER_AUTH_SECRET` | ≥ 32 random chars; the placeholder is rejected in staging/production        |
| `EMAIL_TRANSPORT`    | `console` only (development) — rejected in staging/production until Phase 7 |
| `EMAIL_FROM`         | Sender shown on emails                                                      |

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

## Verifying the foundation

```bash
npm run typecheck          # strict TypeScript, all workspaces
npm run lint               # ESLint (type-aware, jsx-a11y, client/server import boundaries)
npm run format:check       # Prettier
npm run test               # unit tests (domain, env, ui, web)
npm run test:integration   # Postgres integration tests (uses DATABASE_URL_TEST; db must be up)
npm run test:e2e           # builds the app and runs Playwright + axe on :3100 (uses DATABASE_URL_E2E)
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

| Doc                                                          | Contents                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| [00 Repository inspection](docs/00-repository-inspection.md) | Environment and tooling findings                                   |
| [01 Product requirements](docs/01-product-requirements.md)   | Goals, personas, functional & non-functional requirements          |
| [02 Architecture](docs/02-architecture.md)                   | Stack, rationale, module boundaries, API, payment evaluation       |
| [03 Data model](docs/03-data-model.md)                       | Implemented schema: ownership, constraints, transaction boundaries |
| [04 Implementation plan](docs/04-implementation-plan.md)     | Phased roadmap and checklist                                       |
| [05 Risk register](docs/05-risk-register.md)                 | Risks and mitigations                                              |
| [06 Acceptance criteria](docs/06-acceptance-criteria.md)     | Testable criteria                                                  |
| [07 Open decisions](docs/07-open-decisions.md)               | What the owner must decide or supply                               |
| [08 Compliance notes](docs/08-compliance-notes.md)           | Québec/Canada obligations (requires professional confirmation)     |
| [09 Design direction](docs/09-design-direction.md)           | Palette, type, references, key screens                             |
| [10 Phase 1 report](docs/10-phase-1-report.md)               | What was built, test results, open issues, blockers                |
