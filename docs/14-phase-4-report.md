# 14 — Phase 4 Report: Secure Payment Processing

_2026-10-11. Migration `0003_payments.sql`. Runbook, provider comparison and launch checklist:
[13-payments.md](13-payments.md)._

**Status in one line:** Stripe Checkout is fully integrated behind a provider interface and tested
against Stripe's own request and signature formats plus a scripted Stripe double. It has **not** been
verified in the Stripe sandbox, and **production payments are not enabled**. The owner closed the
phase on 2026-10-11 and deferred sandbox verification to the pre-launch stage (see §6).

## 1. Provider decision

**Stripe** (decision D2), because the café's POS is unknown. Stripe gives CAD settlement, hosted
Checkout with Apple Pay and Google Pay, idempotent refunds, saved cards, signed webhooks and a sandbox.
The comparison with Square, Moneris, Helcim and Clover is in [13 §1](13-payments.md#1-provider-evaluation).
**If D1 shows the café runs Square POS, revisit**: the code keeps Stripe behind `PaymentProvider`.

## 2. What was built

- **Provider abstraction**: `modules/payments/provider.ts`.
  - Stripe adapter `stripe.ts` (SDK pinned at `stripe@22.6.2`, API `2026-08-26.dahlia`).
  - Development simulator `fake.ts`, which feeds the same reconciliation code.
- **Server-created hosted checkout** (`POST /api/v1/orders/:id/checkout`):
  - Charges the exact server total in CAD (items, discounts, GST/QST, tip, delivery).
  - One live page per order, enforced by a database index and the order lock.
  - Repeat clicks reuse the page; a page about to expire is closed before a new one opens.
  - The pickup slot is held while the page can be paid.
  - Signed-in customers can opt in to save a card on Stripe's page.
- **Single reconciliation path** (`applyCheckoutInTx`):
  - Feeds: verified webhooks, the return page's authenticated status check, the recovery job.
  - Idempotent per Stripe payment.
  - Late, duplicate and wrong-amount payments are recorded and refunded automatically.
- **Payment states**:
  - Attempt: open, processing, succeeded, failed, expired, cancelled.
  - Payment: succeeded, partially refunded, refunded.
  - Refund: pending, succeeded, failed, cancelled.
  - Customer sees: unpaid, pending, processing, paid, failed, partially refunded, refunded.
  - "Authorized" isn't used: Checkout captures immediately. Manual capture is listed as an option.
- **Webhooks** (`POST /api/webhooks/stripe`): signature verified on the raw body (400 if invalid, nothing
  stored). Each event is processed once through a unique inbox row written in the same transaction as
  its effects, and the latest state is fetched from Stripe.
- **Asynchronous and delayed outcomes**: a settling payment holds the order and keeps it out of the
  kitchen. A webhook that never arrives is covered by the return page's status check and the recovery
  job (`GET /api/cron/payments`, Bearer `CRON_SECRET`).
- **Refunds**: recorded `pending` with requester, reason and source, then sent with the refund id as
  idempotency key, then settled from Stripe's answer or `refund.*` webhooks.
  - Pending refunds count against what can still be refunded.
  - Timeouts are retried by the recovery job without double refunds.
  - Dashboard refunds are recorded too.
  - Shift leads and above only, on the new **Staff → Paiements** screen, which also shows failed or
    stuck refunds, disputes and returned payments.
- **Disputes**: recorded and kept current, with evidence deadline. The order is never changed.
- **Customers**:
  - A Stripe pay button explains that card details never touch our site, with a test-mode notice.
  - A cancelled-payment message, and a return page that confirms with Stripe instead of trusting the
    redirect.
  - A payment section on the order page and a printable receipt (tax numbers as `[À FOURNIR]`
    placeholders; R1 note).
  - _Historique des paiements_ in the account.
- **Rules**: Stripe's C$0.50 minimum is enforced at checkout. An order fully discounted to $0 is
  confirmed without payment, and cancelling it gives back the free drink and stamps.
- **Environment**:
  - `PAYMENT_PROVIDER=stripe` requires both Stripe keys.
  - Live keys are refused unless `APP_ENV=production`, and production refuses test keys.
  - Empty `KEY=` lines count as unset.
- Raw card details and payment credentials are never stored.

## 3. Test results (run locally 2026-10-11)

| Suite                                   | Result                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Typecheck · ESLint · Prettier           | ✔ clean                                                                                                               |
| Unit — domain                           | ✔ 83 passed (8 new payment-rule tests)                                                                                |
| Unit — web                              | ✔ 27 passed, incl. 8 Stripe adapter tests (Stripe's signature scheme; requests checked against a local HTTP stand-in) |
| Unit — env · ui                         | ✔ 7 · 4 passed                                                                                                        |
| Integration — db                        | ✔ 12 passed                                                                                                           |
| Integration — web (real Postgres)       | ✔ 95 passed, incl. **24 new payment scenarios** with a scripted Stripe double                                         |
| E2E — Playwright + axe, desktop + phone | ✔ 59 passed · **2 skipped: Stripe sandbox spec (no test keys)**                                                       |

Payment scenarios covered:

- **Success:** via webhook and via the return page; a redirect without payment is not trusted.
- **Failure:** declined card with retry on the same page, async failure, wrong amount.
- **Duplicate:** the same event twice, the same payment from two paths, two sessions both paid.
- **Delayed:** processing then succeeded, a missed webhook recovered by the job, payment after expiry.
- **Refunded:**
  - partial refund pending until the webhook settles it;
  - concurrent over-refund blocked;
  - timeout retried with the same idempotency key, refunded once;
  - failed refund flagged for staff;
  - dashboard refund recorded;
  - cancel refunds a paid order and closes an unpaid order's page.
- **Also:** disputes, a forged signature rejected with nothing stored, an unknown session ignored,
  preparation blocked without payment, and the C$0.50 minimum.

New E2E coverage:

- Guest payment journey: payment section, receipt with a11y check.
- A manager refunds from Staff → Paiements, with client and server limits.
- Basic staff are denied the payments screen.

**Not run:** the real Stripe sandbox (`STRIPE_E2E=1 npx playwright test stripe-sandbox`) and the manual
sandbox checklist in [13 §7](13-payments.md#7-testing). Both need your test keys.

## 4. Issues found and fixed during the phase

- Making $0 orders paid at placement would have left a cancelled free-drink order holding its reward.
  Cancelling now releases the reward and reverses the stamps, and the integration test was updated.
- The webhook handler asked Stripe about sessions it didn't create. It now checks locally first.
- Visual review:
  - receipt title split the order number at the hyphen;
  - the refund confirmation showed a raw status;
  - the site header, bottom navigation and footer printed on the receipt.

## 5. Known limitations

- Sandbox and live verification outstanding (keys). Vercel has no Stripe variables, so payments there
  remain off.
- The recovery job is not scheduled (Vercel Hobby allows daily cron only). Schedule it every 5–10 min.
- Card-only Checkout; manual capture, an embedded form and saved-card management outside Checkout are
  options.
- No email receipts yet (D22). Stripe's receipt emails can be enabled in the dashboard.
- The legal Québec bill (SRS, R1) and the GST/QST numbers on receipts still need the owner and a
  professional.

## 6. Decisions and inputs needed

1. **Deferred to pre-launch:** Stripe test keys in `.env` (`STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_WEBHOOK_SECRET=whsec_…`,
   `PAYMENT_PROVIDER=stripe`) so the sandbox verification can run.
2. **D1:** the café's POS (Square would change the recommendation).
3. **D16:** cancellation and refund policy (defaults implemented). **D13:** tips.
4. Professional confirmation: SRS billing, tax registration display, refund terms, privacy (Stripe as
   processor, PIA).
