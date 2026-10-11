# 12 — Phase 3 Report: Menu & Order-Management Domain, Staff Queue

_Completed 2026-10-11. Migration `0002_ordering_domain.sql`. Scope: the owner's Phase 3 brief (full menu
and order-management domain and the staff order queue), ending "ready for the separate payment
integration phase"._

**No real payment provider is integrated.** Orders can be placed and paid only through a clearly labelled
**development payment simulator** (`PAYMENT_PROVIDER=fake`), which no-ops on money and is refused by
environment validation in staging and production. With the default `PAYMENT_PROVIDER=none`, checkout
shows the total but cannot send the order, as in Phase 2.

## 1. What was built

### Menu domain

- **Availability schedules**: weekly local-time windows per product (seeded example: `[DÉMO] Bol
déjeuner`, weekdays 07:00–11:00). Availability is evaluated **at the pickup time**, so a breakfast item
  can be pre-ordered for tomorrow morning but not for this afternoon.
- **Temporary disabling ("86")** of products and options until a given time, which lapses automatically.
- **Size-specific option rules**: a different price for one size (small latte extra shot +0,50 $) or an
  option not offered for a size (no iced small latte). The customizer drops excluded options when the
  size changes, and the server rejects them (`option_not_allowed_for_size`).
- Reason-specific badges and messages on the menu, product and cart (sold out, temporarily unavailable,
  outside hours).

### Order domain

- **Placement in one transaction**, re-priced on the server. A changed total gives `price_changed`.
  Placement also covers idempotency keys, concurrency-safe slot capacity and promotion caps, reward
  reservation, order numbers `MMDD-NNN`, and item/price snapshots. See [02 §6](02-architecture.md).
- **Pickup rules**: staff pause, last-order cutoff before closing, minimum lead time, capacity per slot
  (demo: 6). "As soon as possible" reports _busy_ when its slot is full.
- **State machine** with actor permissions, required reasons, and system-only `paid`. Optimistic versions
  apply to every transition, and an append-only `order_events` history is kept. See
  [03 — Order lifecycle](03-data-model.md#order-lifecycle-state-machine--packagesdomainsrcorderingstate-machinets).
- **Customer self-service**: cancel before acceptance (paid orders are refunded in full automatically),
  change a scheduled pickup time up to 15 min before it, plus notes per order and per item.
- **Refunds**: full or partial by shift lead and above. A refund never exceeds what was paid, and
  loyalty stamps are reversed on a full refund.
- **Unpaid expiry**: an unpaid order holds its slot and reward for 15 min, then becomes `expired`.
- **Guest orders**: guests track their order through a private link token, stored only as a hash.
- **Saved carts** follow a signed-in customer across devices (ids and quantities only, versioned).

### Staff screens

- **Order queue** `/[locale]/staff`, built for a counter tablet:
  - New / Accepted / Preparing / Ready columns. A landscape tablet shows all four; narrower screens use
    column toggles.
  - Large one-tap actions, due-time countdowns with late highlighting, and customer and item notes.
  - Internal notes, reject/cancel with a required reason in a dialog, and an optional new-order chime.
  - Pause ordering (15/30/60 min) and resume.
  - Polls every 5 s. Two staff tapping at once is handled (409 plus refresh).
- **Product availability** `/[locale]/staff/availability`: products and options with On sale / Sold
  out / Pause 1 h toggles.

### Customer screens

- Checkout:
  - Places the order, with contact name, optional phone and delivery-address fields (delivery is still
    not offered).
  - Shows a specific message for each refusal reason.
  - Retries reuse the same idempotency key.
- Payment step `/checkout/pay/[id]` with the labelled simulator: approve or decline, and decline can be
  retried.
- Order page: live tracking (`rejected` state included), cancel dialog, change-time form, notes, and
  pay-now and expired notices. Guests use it through the private link.

## 2. API added

| Method & path                              | Who                        | Notes                                                       |
| ------------------------------------------ | -------------------------- | ----------------------------------------------------------- |
| `POST /api/v1/orders`                      | guest or customer          | 201 created · 200 replay · 409 key reuse · 422 `reason`     |
| `GET` / `PATCH /api/v1/orders/:id`         | owner, staff, token        | Detail incl. `canCancel`/`canModify`; PATCH = time, notes   |
| `GET /api/v1/orders/:id/status`            | owner, staff, token        | Polled by tracking                                          |
| `POST /api/v1/orders/:id/cancel`           | owner, token               | Auto-refund when paid                                       |
| `GET` / `PUT /api/v1/me/cart`              | customer                   | `expectedVersion` → 409 `cart_version_conflict`             |
| `GET /api/v1/staff/orders`                 | staff+                     | Queue, recent hand-overs, pause state                       |
| `POST /api/v1/staff/orders/:id/transition` | staff+ (role-dependent)    | `{ to, reason?, expectedVersion }`                          |
| `POST /api/v1/staff/orders/:id/refund`     | shift lead+                | `{ amountCents, reason }`                                   |
| `PUT /api/v1/staff/orders/:id/notes`       | staff+                     | Internal notes                                              |
| `POST /api/v1/staff/pause`                 | per `store:pause_ordering` | `{ minutes }` or resume                                     |
| `GET` / `PUT /api/v1/staff/availability`   | staff+                     | 86 / restore products and options                           |
| `POST /api/dev/fake-payments`              | owner or token             | **Exists only with `PAYMENT_PROVIDER=fake`**; 404 otherwise |

All non-GET routes pass the same-origin (CSRF) check. Errors are RFC 9457 problems with a machine
`reason`.

## 3. Test results (run locally 2026-10-11)

| Suite                                   | Result                                       |
| --------------------------------------- | -------------------------------------------- |
| Typecheck · ESLint · Prettier           | ✔ clean                                      |
| Unit — domain                           | ✔ 75 passed                                  |
| Unit — web · env · ui                   | ✔ 19 · 6 · 4 passed                          |
| Integration — db                        | ✔ 12 passed                                  |
| Integration — web (real Postgres)       | ✔ 71 passed, incl. 20 ordering tests (below) |
| E2E — Playwright + axe, desktop + phone | ✔ 57 passed                                  |

Ordering integration tests cover:

- Tampered totals and prices.
- Idempotent retries and same-key races.
- Two customers racing for the last slot.
- Two orders racing for one free drink (and its release on cancel).
- Promotion caps under concurrency.
- Pause and closed hours.
- Schedule windows at the pickup time.
- Payment amount mismatch and duplicate payment events.
- Two staff tapping at once.
- Rejecting a paid order refunds it.
- The cancel policy, including the customer's own cancellation storing no reason.
- Partial refunds never exceeding the amount paid.
- Unpaid expiry.
- Pickup-time changes.
- Guest token access and probing returning 404.
- Saved-cart version conflicts.

New E2E journeys:

- **Guest (desktop and phone):** customize → checkout validation → place order → declined then approved
  simulated payment → the counter (tablet viewport) accepts, starts and marks the order ready → the
  customer's page shows "Votre commande est prête!" on its own → handed over.
- **Signed-in customer:** pays, then cancels before acceptance, with the confirmation dialog.
- **Staff (desktop):** takes a product off sale, a guest sees it unavailable, then it is restored.

The E2E run found and fixed three real issues:

- The cancel confirmation vanished.
- A French page showed the English internal reason "Cancelled by customer".
- Order numbers wrapped at the hyphen on the queue cards, and far-future pickups showed "Dans 831 min".

## 4. Known limitations

- **Not production-ready for payments**: no real provider, webhooks or receipts. That is the next phase
  (provider ⛔ D1/D2).
- **Polling, not push**: the queue polls every 5 s and tracking polls on its own interval. SSE/WebSockets
  are planned with Phase 7, along with notifications (email/SMS/push, ⛔ D22).
- **Expiry runs lazily**: stale unpaid orders expire when an order is placed or the staff queue refreshes.
  A scheduled job is still needed so expiry doesn't depend on traffic.
- **The plan's Phase 3 exit criteria are not met yet**: ≥95 % branch coverage on `domain` and
  property-based (fast-check) tests. No coverage tooling is set up yet, so this carries forward.
- **No admin UI** for availability windows, size rules, capacity, cutoff or auto-accept. They're data-only
  until Phase 9.
- **Delivery** stays disabled: address fields exist, but no zone or fee rules are confirmed.

## 5. Needs owner or professional confirmation

- **D16 cancellation and refund policy.** Defaults implemented: cancel until accepted, full refund if
  paid, no item changes after ordering, time changes up to 15 min before.
- **D13 tips.** Defaults kept from Phase 2.
- Capacity per slot, last-order cutoff, unpaid hold time and auto-accept are **placeholders**, not café
  data.
- **Tax** (GST/QST treatment, rounding, refunds of tax) needs an accountant's confirmation.
- **Québec SRS / sales-recording obligations** (risk R1) need professional advice before real sales.
- **Privacy**: guest phone and notes are now stored, and Neon is hosted in the US (PIA requirement, D21).
