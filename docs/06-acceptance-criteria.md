# 06 — Acceptance Criteria

Given/When/Then format; each maps to PRD IDs ([01](01-product-requirements.md)) and becomes an automated test where feasible (U = unit, I = integration, E = E2E, M = manual).

## Global
- **G1 (E)** Every customer, staff, and admin page renders fully in `fr-CA` and `en-CA`; CI fails if any message key is missing in either catalog.
- **G2 (E)** axe reports zero serious/critical violations on all primary routes at 375 px and 1280 px.
- **G3 (E)** No horizontal scroll at 320 px on any customer route; French strings do not truncate primary actions.
- **G4 (I)** Every mutating API endpoint returns 401/403 for unauthenticated/unauthorized actors (generated matrix test).
- **G5 (U)** All money values are integers; formatting `450` cents → `4,50 $` (fr-CA) and `$4.50` (en-CA).

## Menu & cart (MENU, CART)
- **C1 (I)** Given a product priced 450 with a +75 option, when the client posts a cart claiming 100, then the quote returns 525 and the client value is ignored.
- **C2 (I)** Given a required single-select group (size), when no option is selected, then quote fails with a localized validation error.
- **C3 (I)** Given a product marked sold out after it was added to the cart, when checkout is attempted, then the order is rejected with an item-specific message and the cart highlights the item.
- **C4 (I)** Given the store is closed or paused, when ASAP is requested, then only valid future slots are offered; scheduled time outside hours is rejected.
- **C5 (I)** Given a slot at capacity, when a new order requests it, then it is rejected (tested with concurrent requests: never exceeds capacity).
- **C6 (U)** Tip presets are computed on the pre-tax subtotal after discounts; custom and no-tip options exist; presets have identical visual weight (M).

## Tax (CART-5)
- **T1 (U)** Taxable subtotal 1000 → GST 50, QST 100 (99.75 rounded half-up), total 1150. Rounding rules documented and confirmed by accountant (M).
- **T2 (U)** Items in a zero-rated tax category add no GST/QST; tips are not taxed.
- **T3 (U)** Tax rate changes apply by `effective_from` date of the order.

## Payments & orders (PAY, ORD)
- **P1 (I)** Visiting the success return URL without a confirmed payment does **not** change the order from `awaiting_payment`.
- **P2 (I)** Delivering the same webhook event twice results in exactly one `paid` transition, one stamp earn set, and one notification.
- **P3 (I)** A `payment_failed` event arriving after `succeeded` does not regress the order.
- **P4 (I)** Replaying `POST /orders` with the same idempotency key returns the same order; a different body with the same key returns 409.
- **P5 (I)** Unpaid orders expire after the configured TTL, releasing slot and reserved reward.
- **P6 (U)** Illegal transitions (e.g. `ready → accepted`, customer marking `ready`) are rejected.
- **P7 (I)** Two staff transitioning the same order concurrently: one succeeds, the other receives a 409 conflict with current state.
- **P8 (E)** Full order (guest and signed-in) on the fake provider: browse → customize → cart → pickup slot → pay → tracking shows `paid → … → ready` live as staff advances it.
- **P9 (I)** Raw card data never touches our servers (payment UI is provider-hosted/embedded; request payload audit in E2E).

## Loyalty (LOY)
- **L1 (I)** A paid order with 3 qualifying drinks (qty 2 + qty 1) earns 3 stamps; food earns 0.
- **L2 (I)** Reaching 5 stamps converts to 1 reward; 7 stamps → 1 reward + 2 carried.
- **L3 (I)** Redeeming a reward on an eligible drink discounts it (up to the cap); that line earns 0 stamps.
- **L4 (I)** Two concurrent checkouts reserving the same reward: exactly one succeeds.
- **L5 (I)** Refunding a paid drink reverses its stamp; refund of an order that used a reward restores/revokes per configured policy.
- **L6 (I)** Manual adjustment requires `shift_lead`+, a reason, and writes an audit entry.
- **L7 (U)** Ledger invariant: cached balance equals sum of entries after any random sequence of operations (property test).

## Staff & admin (STAFF, ADM)
- **S1 (E)** New paid order appears in the staff queue within 3 s (SSE) or 10 s (fallback), with an audible/visual alert.
- **S2 (I)** Marking an option sold out removes it from new quotes immediately.
- **A1 (I)** Changing a product price does not alter existing orders’ totals.
- **A2 (I)** Loyalty program change creates a new version; in-progress stamp balances are preserved.
- **A3 (I)** Report totals (sales, GST, QST, tips, refunds) reconcile with fixture orders to the cent.

## Privacy & security
- **X1 (E)** User can request data export and receive a machine-readable file; deletion anonymizes PII while retaining tax-required order records.
- **X2 (I)** Logs contain no emails, phone numbers, tokens, or full addresses (redaction test).
- **X3 (I)** Auth endpoints are rate-limited; session cookies are `HttpOnly; Secure; SameSite=Lax`.
- **X4 (M)** CSP and security headers verified on production build.
