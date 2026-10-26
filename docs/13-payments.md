# 13 — Payments: Provider Decision, Setup and Operations

_Phase 4 (2026-10-11). Status: **implemented, and verified end-to-end in the Stripe sandbox on
2026-10-26** (§7: payment, declines, 3-D Secure, refunds, replay and a dispute, all automated).
Production payments are not enabled and must not be until the launch checklist (§8) is complete._

## 1. Provider evaluation

Fees are **as publicly reported** and must be confirmed on each provider's Canadian pricing page or a
quote before launch.

| Criterion                           | **Stripe**                                                     | Square                                       | Moneris                           | Helcim           | Clover (Fiserv)         |
| ----------------------------------- | -------------------------------------------------------------- | -------------------------------------------- | --------------------------------- | ---------------- | ----------------------- |
| Available to Canadian businesses    | Yes                                                            | Yes                                          | Yes (Canadian)                    | Yes (Canadian)   | Yes                     |
| CAD settlement                      | Yes                                                            | Yes                                          | Yes                               | Yes              | Yes                     |
| Online card fee (reported)          | ~2.9 % + C$0.30 domestic                                       | ~2.9 % + C$0.30 online                       | Quote-based                       | Interchange-plus | Quote-based             |
| Refunds by API, partial refunds     | Yes, idempotent                                                | Yes                                          | Yes                               | Yes              | Limited                 |
| Saved payment methods               | Yes (Customers + Checkout opt-in)                              | Yes (Cards on file)                          | Vault (varies)                    | Yes              | Varies                  |
| Apple Pay / Google Pay              | Yes, on hosted Checkout without domain setup                   | Yes (Web Payments SDK)                       | Varies                            | Varies           | Varies                  |
| Hosted, PCI SAQ-A-eligible checkout | Checkout (hosted page)                                         | Checkout API / payment links                 | Hosted pay page                   | HelcimPay.js     | Hosted checkout         |
| Signed webhooks + sandbox           | Yes / Yes                                                      | Yes / Yes                                    | Partial                           | Yes / Yes        | Partial                 |
| Fit with the café's POS             | **Not a POS.** Online sales must still reach the SRS bill (R1) | **Best if the café already uses Square POS** | If it's the bank-bundled terminal | Has its own POS  | If the café runs Clover |

**Decision (D2): Stripe**, because the café's POS is unknown (owner answer on 2026-10-11: "don't know /
none yet"). This follows the Phase 0 rule: match an existing certified POS when it has a usable online
API, otherwise use Stripe. **Revisit if the café turns out to run Square**: in that case Square would let
online orders print and be recorded on the till. All payment logic sits behind the `PaymentProvider`
interface, so a Square adapter is one file plus webhook mapping.

Refund economics to confirm with Stripe: the original processing fee is generally **not returned** on
refunds, and **disputes carry a fee**. Both argue for the café's quick-reject policy (an order rejected
before preparation is refunded immediately).

## 2. How a payment works

```
Customer           App server                                  Stripe
   │ Commander et payer → order awaiting_payment (server prices, held 15 min)
   │ Payer 1,30 $ ───────▶ POST /orders/:id/checkout
   │                        lock order · reuse open session? ───▶ Checkout Session (CAD, exact total,
   │                        else create (idempotency key)          metadata order_id/attempt_id)
   │ ◀── redirect to Stripe-hosted page (card / Apple Pay / Google Pay; no card data touches us)
   │ pays on Stripe ──────────────────────────────────────────────▶ charge
   │                        POST /api/webhooks/stripe ◀──────────── checkout.session.completed (signed)
   │                        verify signature · inbox (once) · GET session (authenticated) ·
   │                        record payment · order → paid (→ accepted if auto-accept)
   │ ◀── redirect /checkout/return/:id ── polls POST /orders/:id/payment → asks Stripe directly
   │ order page: tracking + "Payée … visa •••• 4242" + receipt
```

- **Never trusted:** the redirect back, any amount from the browser, any payment state from the browser.
- **Single path to "paid":** `applyCheckoutInTx` (`apps/web/src/server/modules/payments/checkout.ts`).
  Verified webhooks, the return page's status check, the recovery job and the development simulator all
  feed it, and it is idempotent per Stripe PaymentIntent.
- **One payment page per order:** a partial unique index allows one open or processing attempt per order.
  Repeat clicks get the same URL. A page about to expire is closed at Stripe before a new one opens.
- **Money that can't pay for the order is returned automatically:** a payment after expiry or
  cancellation (`late`), a second payment (`duplicate`) or a wrong amount (`amount_mismatch`) is recorded
  and refunded in full.
- **No preparation before payment:** the state machine only lets an order be accepted from `paid`, and
  the staff queue only shows paid orders.
- **Asynchronous outcomes:** if Stripe completes a session but the money is still settling, the attempt
  becomes `processing`. The order is then held (no expiry), stays out of the kitchen, and a second page
  can't be opened; it resolves on `async_payment_succeeded` or `async_payment_failed`. With card-only
  Checkout this is rare.
- **Minimums:** Stripe won't charge under C$0.50, so totals of 1–49 ¢ are refused at checkout
  (`below_minimum_charge`). An order discounted to exactly $0 (e.g. a free drink) is confirmed with no
  payment step.

### Payment states

| Level               | States                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout attempt    | `open` → `processing` → `succeeded` / `failed` / `expired` / `cancelled`                                                                             |
| Payment (captured)  | `succeeded` → `partially_refunded` → `refunded`                                                                                                      |
| Refund              | `pending` → `succeeded` / `failed` / `cancelled`                                                                                                     |
| Customer sees       | unpaid · pending · processing · paid · failed · partially refunded · refunded                                                                        |
| "Authorized" (held) | **Not used**: Checkout captures immediately. Manual capture would avoid refund fees when the café rejects an order; it's an option to evaluate (§9). |

## 3. Environment setup

| Variable                | Where                           | Notes                                                                                                                                         |
| ----------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_PROVIDER`      | all                             | `stripe` to use Stripe; `fake` = development simulator (refused in staging/production)                                                        |
| `STRIPE_SECRET_KEY`     | server only (Vercel: Sensitive) | `sk_test_…`/`rk_test_…` everywhere except production; **live keys are refused unless `APP_ENV=production`**, and production refuses test keys |
| `STRIPE_WEBHOOK_SECRET` | server only (Sensitive)         | The endpoint's signing secret (`whsec_…`)                                                                                                     |
| `CRON_SECRET`           | server only (Sensitive)         | ≥ 32 random chars; enables `GET /api/cron/payments` (Bearer auth)                                                                             |

No publishable key is needed: the browser never talks to Stripe's API, it is redirected to Stripe's
hosted page.

**Restricted key (recommended)** with write access to: Checkout Sessions, PaymentIntents (read),
Refunds, Customers. Read access to Charges and Disputes is enough.

### Local sandbox

1. Stripe Dashboard → test mode → Developers → API keys → copy the secret key into `.env`
   (`STRIPE_SECRET_KEY=sk_test_…`) and set `PAYMENT_PROVIDER=stripe`.
2. Install the Stripe CLI, then `stripe listen --forward-to localhost:3000/api/webhooks/stripe`. Put the
   printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
3. `npm run dev`, order something, and pay with test card `4242 4242 4242 4242` (any future date, any CVC).
4. Without `stripe listen`, payments are still confirmed by the return page's authenticated status check.
   Refund and dispute updates then need the recovery job (§6). Any `whsec_` value works for the app to
   start; the sandbox E2E delivers real events itself, signed with it (§7).

## 4. Webhook configuration

Dashboard → Developers → Webhooks → **Add endpoint** `https://<domain>/api/webhooks/stripe`, API version
`2026-08-26.dahlia` (pinned by `stripe@22.6.2`), events:

```
checkout.session.completed            checkout.session.async_payment_succeeded
checkout.session.async_payment_failed checkout.session.expired
payment_intent.payment_failed
refund.created  refund.updated  refund.failed  charge.refund.updated
charge.dispute.created  charge.dispute.updated  charge.dispute.closed
charge.dispute.funds_withdrawn  charge.dispute.funds_reinstated
```

Processing (`modules/payments/webhooks.ts`):

1. Raw body + `Stripe-Signature` are verified with the endpoint secret (HMAC, 5-minute tolerance). A bad
   signature returns 400 and nothing is stored.
2. An event id that was already processed returns 200 without doing anything (Stripe retries, duplicate
   deliveries).
3. The current state is fetched from Stripe (authenticated), because events can arrive out of order.
4. The inbox row (`payment_events`, unique per event id) and all effects are committed in **one
   transaction**. On error the response is 500 and Stripe retries; nothing half-applied remains.
5. Only ids are stored from payloads (no customer details).

## 5. Refunds

- **Who:** shift lead, manager or owner (`orders:refund`), on **Staff → Paiements**. Basic staff cannot.
- **When:** for orders that are completed, cancelled, rejected or partially refunded. An order still in
  the kitchen is **cancelled** instead (from the queue, with a reason), which refunds it in full.
- **Automatic full refunds:** customer cancellation before acceptance, staff cancel or reject of a paid
  order, and late, duplicate or wrong-amount payments.
- **How (`modules/payments/refunds.ts`):**
  1. A `pending` refund is recorded first, with requester, reason and source. Amount checks count pending
     refunds, so two concurrent refunds can't exceed what was paid.
  2. Stripe is called with our refund id as the **idempotency key**.
  3. The refund is settled from Stripe's answer, or later from `refund.*` webhooks or the recovery job.
- **Audit trail:** each refund row carries `requested_by`, `reason`, `source`, `status`,
  `failure_reason`, `submitted_at` and `settled_at`. `order_events` records `refund_requested` /
  `refund_recorded` / `refund_failed`, and `audit_events` records `payment.refund_requested` /
  `payment.refund_failed`. Refunds made in the Stripe dashboard are recorded too (source `provider`).
- **Failed refunds** (e.g. closed card) leave the order unchanged and show under _À surveiller_. The café
  then refunds by another means and records it.
- Customers see refunds on the order page, the receipt and _Historique des paiements_ ("5 to 10 business
  days").

## 6. Failure recovery

| Situation                                        | What happens                                                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Customer closes the tab on Stripe                | Order stays `awaiting_payment` until its hold ends; "Payer maintenant" reopens the **same** page                                          |
| Customer clicks "back" on Stripe (cancel URL)    | Pay page says "Paiement annulé. Aucun montant n'a été prélevé"; paying again reuses the page                                              |
| Card declined                                    | Stripe shows the error and the page stays open; a `payment_failed` event is recorded                                                      |
| Webhook late or never delivered                  | Return page checks Stripe directly (8 polls), then says "pas encore de confirmation"; recovery job checks open sessions older than 2 min  |
| Refund call times out                            | Refund stays `pending` (`provider_unreachable`); recovery job resubmits it with the same idempotency key (Stripe returns the same refund) |
| Payment after the order expired or was cancelled | Recorded as `late` and refunded automatically                                                                                             |
| Paid in two tabs                                 | Second payment recorded as `duplicate` and refunded automatically                                                                         |
| Dispute (chargeback)                             | Recorded and kept current; listed under _À surveiller_ with the evidence deadline; answer it in the Stripe dashboard                      |

**Recovery job:** `GET /api/cron/payments` with `Authorization: Bearer $CRON_SECRET`. It is idempotent
and safe to run concurrently. Schedule it **every 5–10 minutes** with Vercel Cron (Pro plan; Hobby only
allows daily runs) or any external scheduler. It is not scheduled in this repository yet.

## 7. Testing

| Scenario (brief)        | Where                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Successful              | `payments.int.test.ts` (webhook and return-page paths); E2E guest journey (simulator)                                                   |
| Failed                  | declined card event; async failure; amount mismatch                                                                                     |
| Duplicate               | same event twice; same payment via webhook + status check; two sessions both paid                                                       |
| Delayed                 | processing → succeeded; missed webhook → recovery job; late payment after expiry                                                        |
| Refunded                | partial pending → webhook; concurrent over-refund blocked; timeout → idempotent retry; failed refund; dashboard refund; cancel → refund |
| Signature verification  | `stripe.test.ts` with Stripe's own test-header generator: valid, tampered, wrong secret, stale, missing                                 |
| Requests sent to Stripe | `stripe.test.ts` against a local HTTP stand-in: amounts, CAD, metadata, idempotency keys, no card fields                                |
| **Real Stripe sandbox** | `e2e/stripe-sandbox.spec.ts` (`STRIPE_E2E=1`, test keys): the checklist below, automated. **7/7 passed 2026-10-26**                     |

Integration tests use `src/test/stripe-double.ts`, a scripted stand-in for Stripe. They verify our
reconciliation, not Stripe; that is what the sandbox run and the checklist below are for.

**Sandbox run:** `STRIPE_E2E=1 npx playwright test stripe-sandbox --project=desktop` (test keys in
`.env`). It needs no `stripe listen`: webhook scenarios fetch the real events from Stripe's API and
deliver them to the endpoint signed with `STRIPE_WEBHOOK_SECRET`, as the CLI does, and the app reads
the current state back from Stripe as usual. **2026-10-26: 7/7 passed.**

| Scenario                            | Card / action                    | Result                                          |
| ----------------------------------- | -------------------------------- | ----------------------------------------------- |
| Payment                             | `4242 4242 4242 4242`            | paid, confirmed by Stripe (not the redirect)    |
| Declined                            | `4000 0000 0000 0002`            | refused on Stripe's page, order unpaid          |
| Insufficient funds                  | `4000 0000 0000 9995`            | refused on Stripe's page                        |
| 3-D Secure                          | `4000 0027 6000 3184` → Complete | paid after authentication                       |
| Partial refund of a completed order | Staff refund 0,50 $              | refund succeeded, payment `partially_refunded`  |
| Replayed event                      | same `refund.*` event again      | recorded as duplicate, nothing changes          |
| Paid order cancelled by staff       | Staff → Annuler                  | refunded in full through Stripe                 |
| Chargeback on a real order          | `4000 0000 0000 0259`            | dispute recorded on that order, _Litige ouvert_ |

Stripe test-mode refunds succeed at once, so the refund is settled from Stripe's answer and the
webhook re-applies it idempotently. A refund that stays pending until its webhook is covered by the
integration tests with the Stripe double. Still to do on the staging deployment with a real
endpoint: the same run with Stripe delivering webhooks itself (§8).

## 8. Production launch checklist

- [ ] **Owner decisions:** D1 (POS) and D2 (confirm Stripe, or Square if the café runs Square POS). D16
      cancellation and refund policy. D13 tips.
- [ ] **Legal and tax (professional):** Québec SRS/WEB-SRM billing for online sales (R1, launch
      blocker); GST/QST registration numbers on receipts (placeholders now); refund and cancellation
      terms; privacy policy covering Stripe as a processor (data may be processed outside Québec; PIA,
      D21).
- [ ] Stripe account activated for the café's legal entity, payout bank account, statement descriptor,
      support phone/email, branding (logo/colours from the owner, not invented).
- [ ] Apple Pay and Google Pay enabled in Dashboard → Settings → Payment methods (cards stay on).
- [ ] Live **restricted** key and live webhook endpoint (§4) stored as **Sensitive** env vars; never in
      the repo or logs.
- [ ] `APP_ENV=production` with a live key. Env validation refuses test keys there and live keys
      anywhere else.
- [ ] Recovery job scheduled every 5–10 min with `CRON_SECRET`.
- [ ] Sandbox checklist (§7) passed on the staging deployment with test keys.
- [ ] One real low-value live payment and refund, then compare Stripe dashboard ↔ `payments`/`refunds`.
- [ ] Email receipts (D22: email provider) — Stripe's own receipt emails can be enabled meanwhile.
- [ ] Radar rules reviewed; dispute response owner named.
- [ ] Monitoring/alerting on webhook 4xx/5xx and on _À surveiller_ items.
- [ ] Staff trained: queue (accept only paid orders), cancel vs refund, failed-refund handling.

## 9. Not done / options

- Manual capture (authorize at checkout, capture on acceptance) to avoid refund fees on rejected orders.
- Embedded Checkout or Payment Element (on-site form) instead of the redirect.
- Customer-facing saved-card management outside Checkout. Cards are saved by opting in on Stripe's page
  and removed there.
- Tips added after the order (tips are part of the checkout total today, D13).
- Square adapter if D1 reveals Square POS.
