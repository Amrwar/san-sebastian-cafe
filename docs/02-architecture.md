# 02 — Architecture & Technical Decisions

_Status: Proposed · 2026-10-10_

## 1. Stack (proposed)

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) | One language end to end; types are shared with future native apps |
| Monorepo | pnpm workspaces + Turborepo | Enforces module boundaries, caches CI, and lets a future `apps/mobile` (Expo) reuse domain code and contracts |
| Web framework | Next.js 16 (App Router), React 19, Node.js runtime | Server rendering for fast menu pages and SEO, plus Server Components for data-heavy staff/admin views. Route handlers expose a versioned HTTP API. PWA support. |
| Database | PostgreSQL 16+ | Relational integrity, transactions, row locking (`SELECT … FOR UPDATE`) for loyalty and slot capacity, and `LISTEN/NOTIFY` |
| ORM / migrations | Drizzle ORM + drizzle-kit (SQL migrations committed) | SQL-first, transparent queries, typed schema, and no runtime engine binary |
| Validation | Zod (shared `contracts` package) | One schema for API input, env validation and form validation |
| Auth | Better Auth (self-hosted, Drizzle adapter, DB sessions) | User data stays in our database (Law 25 residency/PIA simpler). Supports email OTP/magic link, passkeys later, and organization/roles. No per-MAU vendor cost. |
| i18n | next-intl, locale-prefixed routes (`/fr`, `/en`), `fr-CA` default | Mature App Router support, ICU messages, and locale-aware number/currency/date formatting |
| Styling | Tailwind CSS v4 with design tokens as CSS variables, Radix UI primitives (accessible behavior), and our own component layer | Accessible primitives without a generic "template" look; tokens keep the system coherent |
| Payments | `PaymentProvider` adapter. **Provider chosen in Phase 6 after the POS decision** (see §5). Dev: `FakePaymentProvider`. | Avoids lock-in; the POS/SRS question can change the answer |
| Realtime | `RealtimeBus` adapter. v1: SSE for the staff console backed by Postgres `LISTEN/NOTIFY`; customer status uses SSE with an automatic polling fallback. | No extra vendor at launch, and the staff connection count is tiny. Can swap to Ably/Pusher if scale needs it. |
| Notifications | `Notifier` adapter: Web Push (VAPID), email (Resend/Postmark, decided in Phase 7), SMS optional (Twilio). Dev: Mailpit (Docker) + console. | |
| Object storage | `Storage` adapter for menu photos. Dev: local filesystem. Prod: S3-compatible bucket in ca-central-1, or Vercel Blob (residency to be confirmed). | |
| Logging | pino (JSON) with request ID and actor ID; redaction of PII and secrets | |
| Errors | Typed domain errors mapped to HTTP problem responses (RFC 9457); Sentry (optional, decided in Phase 15) | |
| Testing | Vitest (unit), Vitest + Testcontainers Postgres (integration), Playwright + @axe-core/playwright (E2E/a11y), and contract tests for webhooks | |
| Lint/format | ESLint (typescript-eslint strict, jsx-a11y, import boundaries) + Prettier | |
| CI | GitHub Actions: install → typecheck → lint → unit → integration (Postgres service) → build → E2E (on PR) | |
| Hosting (prod) | Vercel with functions pinned to **yul1 (Montréal, ca-central-1)**. Postgres in **AWS ca-central-1** (e.g. Supabase, PlanetScale Postgres or RDS; Neon currently has no Canadian region). | Keeps compute and data in Canada, which simplifies Law 25 obligations. **Final choice is an owner decision** (cost and residency). |

## 2. Module boundaries

```
san-sebastian/
├─ apps/
│  └─ web/                     Next.js app: customer PWA, /staff, /admin, /api/v1, /api/webhooks
│     ├─ src/app/[locale]/(customer)/…   menu, product, cart, checkout, orders, account, rewards
│     ├─ src/app/[locale]/staff/…        live queue, availability, lookup
│     ├─ src/app/[locale]/admin/…        menu, settings, loyalty rules, staff, reports, audit
│     ├─ src/app/api/v1/…                versioned JSON API (used by web client components & future mobile)
│     ├─ src/app/api/webhooks/…          payment / POS webhooks (signature-verified, idempotent)
│     ├─ src/server/                     request context, auth guards, route→service wiring
│     └─ messages/{fr,en}.json           UI strings (or from packages/i18n)
├─ packages/
│  ├─ domain/      PURE TypeScript, no I/O: money, pricing, tax (GST/QST), promotions,
│  │               loyalty engine, order state machine, pickup-slot rules. ~100% unit-tested.
│  ├─ contracts/   Zod schemas + inferred types for API requests/responses and events
│  ├─ db/          Drizzle schema, migrations, seed (dev placeholder data), test helpers
│  ├─ services/    Application use-cases (placeOrder, confirmPayment, transitionOrder,
│  │               redeemReward, …). Owns transactions; depends on domain, db and adapter interfaces.
│  ├─ adapters/    Implementations: payments (fake, stripe|square), notifier, realtime,
│  │               storage, pos (none|…), clock, id. Each with a dev-safe implementation.
│  ├─ ui/          Design system: tokens, primitives, composed components (no data fetching)
│  ├─ i18n/        Message catalogs shared by web, emails and push payloads; formatters
│  ├─ env/         Zod-validated environment loading (fails fast at boot)
│  └─ config/      Shared tsconfig, eslint and vitest presets
├─ e2e/            Playwright tests
├─ docs/           This documentation set
└─ docker-compose.yml   Postgres, Mailpit (dev only)
```

**Dependency rules** (enforced with ESLint `import/no-restricted-paths`):
`domain` → nothing · `contracts` → zod only · `db` → domain types · `services` → domain, db, contracts, adapter *interfaces* · `adapters` → services interfaces + SDKs · `apps/web` → everything except it must not import `db` directly from UI components. Client components never import `services`, `db` or `adapters`.

## 3. Key design rules

1. **Server owns all money math.** The client sends `{productId, optionIds[], qty}`. `services` loads current catalog rows, and `domain.pricing` computes line totals, discounts, tax and the total. A `pricing_snapshot` is stored on the order and is immutable after `awaiting_payment`.
2. **Integer cents** (`bigint`/`integer` columns, `Money` value type). No floats. Rounding uses half-up per tax component; GST and QST are each computed on the taxable subtotal and rounded separately (confirm with accountant: per-line vs per-invoice rounding).
3. **Order state machine** in `domain`: a pure `transition(order, event, actor) → Result<NewState, DomainError>`. Persistence uses an optimistic `version` column, so concurrent staff taps can't double-apply.
4. **Loyalty as a ledger.** `loyalty_entries` is append-only (`earn`, `convert`, `redeem_reserve`, `redeem_commit`, `redeem_release`, `reverse`, `adjust`). `loyalty_accounts` caches balances, and both are updated in the same transaction with `SELECT … FOR UPDATE` on the account row. Unique constraints such as `(order_line_id, kind)` make earning idempotent.
5. **Payments.** Webhook handler: verify signature → `INSERT … ON CONFLICT DO NOTHING` into `payment_events(provider, event_id)` → process inside a transaction that re-reads the provider object (no trust in event ordering) → state transition plus loyalty earn → write `outbox` rows for notifications. A browser return URL only *displays* status by polling the server.
6. **Outbox pattern** for side effects (emails, push, realtime, POS sync). Writes happen in the same transaction and are drained by a worker route or cron, with retries. This avoids "paid but never notified" and duplicate sends.
7. **Authorization** lives in `services` (not just middleware): every use-case takes an `Actor` and checks a permission matrix. Staff routes are additionally gated in `proxy.ts`/layouts for UX.
8. **Idempotency keys** on `POST /orders` and `POST /checkout` (client-generated UUID, stored with a unique constraint) prevent double orders on flaky mobile networks.
9. **Audit log** for privileged actions (refunds, loyalty adjustments, price changes, role changes).
10. **Config over code** for business values: hours, lead time, tax rates (with effective dates), the loyalty rule (versioned), tip presets and the reward value cap.

## 4. API surface (v1, indicative)

| Method & path | Purpose | Auth |
|---|---|---|
| `GET /api/v1/menu?locale=` | Catalog with availability | public |
| `POST /api/v1/cart/quote` | Server-priced quote for a cart (lines, promo code, reward, tip) | public/session |
| `POST /api/v1/orders` | Create order from quote (idempotency key) → returns payment session | session/guest |
| `GET /api/v1/orders/:id` · `/events` (SSE) | Status and timeline | owner of order / staff |
| `GET /api/v1/me/loyalty` · `/rewards` | Balance, wallet, history | customer |
| `POST /api/v1/staff/orders/:id/transition` | State change | staff+ |
| `PATCH /api/v1/staff/availability` | Mark sold out | staff+ |
| `/api/v1/admin/*` | Menu, settings, loyalty rules, staff, reports | manager/owner |
| `POST /api/webhooks/payments/:provider` | Provider events | signature |

Web pages may call `services` directly from Server Components and Server Actions. The HTTP API calls the **same services**, so behavior stays identical for the future mobile apps.

## 5. Payment provider evaluation (decision deferred to Phase 6)

Fees below are as publicly reported in 2026 secondary sources and **must be confirmed on each provider's official Canadian pricing page or quote**.

| Provider | Online card fee (reported) | Strengths | Concerns |
|---|---|---|---|
| **Stripe** | ~2.9% + C$0.30 domestic | Best developer experience, Payment Element with Apple/Google Pay, mature webhooks, Stripe Tax not required (GST/QST is simple) | Not a POS for this café. Online orders still need to reach the POS/SRS for the Québec bill (R1). |
| **Square** | ~2.9% + C$0.30 online; 1.5% international card fee since Mar 2026 | If the café **already uses Square POS**, online orders can be pushed to Square Orders so the POS prints and records them. Square publishes WEB-SRM (Québec) guidance. Also offers Loyalty and Gift Cards APIs. | Couples us to the Square catalog model, and its APIs are less flexible for custom loyalty |
| **Moneris** | Quote-based | Canadian; often the incumbent with bank-bundled terminals | Weaker developer tooling; wallet support varies |
| **Helcim** | Interchange-plus | Transparent, often cheaper for small merchants | Smaller ecosystem, less wallet/webhook maturity |
| **Clover (Fiserv)** | Quote-based | Relevant if the café runs Clover POS | Developer platform constraints |

**Recommendation:** pick the provider that matches the café's **existing certified POS** when it has a usable online API (Square or Clover). Without one, use **Stripe** for online payments and solve the SRS bill obligation with a POS integration or professional guidance. Development proceeds against `FakePaymentProvider` plus a Stripe test-mode adapter, so this decision doesn't block Phases 1–5.
