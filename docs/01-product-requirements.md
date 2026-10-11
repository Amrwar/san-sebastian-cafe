# 01 — Product Requirements Document

_Status: Draft for owner review · Version 0.1 · 2026-10-10_

## 1. Summary

San Sebastian Café (Montréal, QC) needs a first-party ordering and loyalty platform made of:

1. **Customer PWA** (installable, mobile-first, FR/EN). Customers browse, customize, order ahead, pay, track, and earn rewards.
2. **Staff & owner console**: a live order queue, menu and availability control, rewards, customers, promotions, payments and reporting.
3. **Backend**: the single source of truth for prices, taxes, discounts, loyalty, payment state, order state and permissions.

## 2. Goals and non-goals

### Goals (v1)

- Order-ahead **pickup** with ASAP and scheduled times, and online payment.
- Digital stamp card: **5 qualifying paid drinks → 1 eligible free drink**.
- French-first bilingual experience, equally polished in EN.
- An operationally simple staff queue that works on a tablet behind the counter.
- Owner self-service for the menu, prices, hours, availability and reward rules.
- Production-grade security, privacy (Québec Law 25) and accessibility (WCAG 2.2 AA target).

### Later (designed for, built in later phases)

- Delivery (own couriers or a third party such as Uber Direct or DoorDash Drive)
- Gift cards, referral codes, advanced promotions, inventory/ingredient tracking
- Native iOS/Android apps using the same versioned API

### Non-goals (v1)

- Replacing the in-store POS. The platform will **integrate** with the POS, not replace it (see Risk R1, Québec mandatory billing).
- Table service and dine-in ordering at the table
- Multi-location franchising. The data model stays location-aware so this remains possible.

## 3. Personas

| Persona                | Needs                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Regular commuter**   | Re-order "my usual" in under 15 s, skip the line, see stamp progress                                                      |
| **New/guest customer** | Browse without an account, check out quickly, be invited to join loyalty after paying                                     |
| **Barista / staff**    | Clear queue on a tablet, large touch targets, audible new-order alert, one-tap status changes, mark items sold out ("86") |
| **Shift lead**         | Refund/cancel with reason, adjust loyalty with audit trail, pause online ordering when slammed                            |
| **Owner**              | Edit menu/prices/hours, set reward rules, see sales/loyalty reports, export data for the accountant                       |

## 4. Functional requirements

IDs are referenced by acceptance criteria ([06](06-acceptance-criteria.md)) and the roadmap ([04](04-implementation-plan.md)).

### 4.1 Accounts & identity (ACC)

- ACC-1 Sign up and sign in with email using a one-time code or magic link. Passwords are optional, passkeys come later. Social login is an owner decision.
- ACC-2 Guest checkout with email (required for receipt) and optional phone. After payment, offer to create an account. Stamps from the guest order are credited if the account is created within N days (configurable).
- ACC-3 Profile: name, preferred language, communication consents (separate, unticked, CASL-compliant), notification preferences.
- ACC-4 Self-service data export and account deletion request (Law 25), with retention exceptions for tax records.
- ACC-5 Roles: `customer`, `staff`, `shift_lead`, `manager`, `owner`. Permissions are enforced server-side.

### 4.2 Menu & catalog (MENU)

- MENU-1 Categories with ordering, bilingual names and descriptions, and an image.
- MENU-2 Products with bilingual content, photos, base price, tax category, dietary/allergen tags, availability (in stock / sold out / hidden) and schedule windows (e.g. breakfast hours).
- MENU-3 Modifier groups with min/max selection, defaults and price deltas. Examples: size, temperature (hot/iced), milk, syrups, extra shots, extras. A modifier option can be marked sold out independently.
- MENU-4 Variant-aware pricing (e.g. size affects base price; an iced surcharge is configurable).
- MENU-5 Product flags: `is_drink` and `loyalty_qualifying`, plus a reward-eligible flag and value cap.
- MENU-6 No real menu data is invented. Seed data is labelled placeholder data.

### 4.3 Cart & checkout (CART)

- CART-1 The cart stores product and modifier **IDs and quantities only**. The server reprices on every read and at checkout.
- CART-2 Validation: required modifiers, min/max, availability, and store open/closed state with lead time.
- CART-3 Pickup time: ASAP (estimated prep time) or a scheduled slot within opening hours, with configurable slot capacity.
- CART-4 Order notes (length-limited) and pickup name.
- CART-5 Price breakdown: subtotal, discounts, rewards, GST, QST, tip, total, all in CAD.
- CART-6 Optional tip. Suggestions are **computed on the pre-tax amount**, shown with equal visual weight, and offer custom and no-tip options (Québec CPA as amended 2025; see [08](08-compliance-notes.md)).
- CART-7 Delivery address and zone validation, when delivery is enabled (later phase).

### 4.4 Payments (PAY)

- PAY-1 Card and wallet (Apple Pay / Google Pay) payments through a PCI-compliant hosted or embedded provider UI. The platform never handles raw card data.
- PAY-2 Payment state is updated **only from verified provider webhooks** or server-side retrieval, never from a browser redirect.
- PAY-3 Webhooks are idempotent: each event is stored once, processing is retry-safe, and events are handled correctly when they arrive out of order.
- PAY-4 Full and partial refunds by authorized roles, with a reason. Refunds reverse loyalty stamps and reward redemptions as configured.
- PAY-5 Payment provider sits behind an adapter interface. A **dev-mode fake provider** allows full local flows without credentials.
- PAY-6 Unpaid orders expire after a configurable time and release reserved rewards and slots.

### 4.5 Orders (ORD)

- ORD-1 State machine: `draft → awaiting_payment → paid → accepted → in_preparation → ready → picked_up`, with `cancelled`, `refunded`, `partially_refunded` and `expired` branches. Only valid transitions are allowed, and each transition is authorized per role.
- ORD-2 Every transition is recorded with actor, time and reason.
- ORD-3 Real-time status for customers and staff, with a polling fallback.
- ORD-4 "Order ready" notification by web push (installed PWA), email, and SMS (optional, owner decision).
- ORD-5 Receipt/bill. **The legal bill may need to come from the café's certified POS/SRS** (Risk R1). The platform's own receipt is labelled as an order confirmation until this is confirmed.
- ORD-6 Order history, reorder and favorites.

### 4.6 Loyalty (LOY)

- LOY-1 Ledger-based stamps (append-only entries, balance derived and cached transactionally).
- LOY-2 Earning: each paid qualifying drink line unit earns 1 stamp when the order reaches `paid`. Pending decision: earn at `paid` or at `picked_up`.
- LOY-3 Every 5 stamps convert into 1 reward in the wallet. This is configurable (N stamps → reward), and leftover stamps carry forward.
- LOY-4 Redemption makes one eligible drink free, up to a configurable value cap. Owner decides which modifiers are included. Redemption is reserved at checkout and committed on payment (or on order creation for a $0 order). Reservations are released on expiry or cancellation.
- LOY-5 Drinks paid for with a reward, comped or 100% discounted **do not earn** stamps (configurable).
- LOY-6 Refunds reverse the stamps earned on refunded lines. If a reward was already issued and used, the balance may go negative per policy (owner decision).
- LOY-7 Staff manual adjustments require `shift_lead`+ and a reason, and are audited.
- LOY-8 Expiry rules follow the Québec CPA (no time-based expiry; inactivity expiry only with notice). Defaults to **no expiry** until legal review.
- LOY-9 In-store (non-app) purchases earn stamps only through POS integration or a scan-to-earn code, depending on the POS decision (Phase 12+).

### 4.7 Staff console (STAFF)

- STAFF-1 Live queue grouped by status, a new-order sound or visual alert, and large touch targets for tablet use.
- STAFF-2 Accept, start, ready and picked-up actions; cancel or refund with reason (by role).
- STAFF-3 Toggle sold out for a product or modifier option, pause online ordering, and adjust prep time.
- STAFF-4 Customer lookup for loyalty support, showing minimum PII.

### 4.8 Admin / owner (ADM)

- ADM-1 Menu CRUD with bilingual fields, image upload, preview, and reordering.
- ADM-2 Store settings: hours, holiday closures, lead times, slot capacity, tax registration numbers, tip settings, legal pages.
- ADM-3 Loyalty rule configuration (versioned; changes are not retroactive).
- ADM-4 Staff management and role assignment.
- ADM-5 Reports: sales by day/product/category, taxes collected (GST/QST), tips, refunds, loyalty issued/redeemed/outstanding liability, and CSV export.
- ADM-6 Audit log viewer.

### 4.9 Growth (later phases) (GRO)

- GRO-1 Promotions: percentage/amount off, item- or order-level, with date windows, usage caps and per-customer limits. Stacking rules with loyalty are defined.
- GRO-2 Referral codes: rewards for both parties after the referee's first paid order, with fraud limits.
- GRO-3 Gift cards (Québec: **no expiry, no fees**), and a liability ledger. A POS-native gift card program is preferred if the POS supports one.
- GRO-4 Customer communications: transactional email, and consented marketing (CASL) with unsubscribe.
- GRO-5 Inventory: simple stock counts that auto-mark items sold out first, with ingredient-level tracking later.
- GRO-6 Delivery: zones, fees, minimums, and a third-party courier integration.

## 5. Non-functional requirements

| Area          | Requirement                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Performance   | Menu page LCP < 2.5 s on a mid-range phone over 4G. Interaction to Next Paint < 200 ms. JS budget per route enforced in CI (target < 170 KB gzip for customer routes). |
| Availability  | 99.9% target. Ordering degrades gracefully: if realtime is down, polling is used. If payments are down, a clear message is shown and orders are not created.           |
| Security      | OWASP ASVS L2 as a guide. CSRF protection, rate limits, secure cookies, CSP, server-side authorization on every mutation, secrets only in env.                         |
| Privacy       | Law 25: privacy officer designated, privacy policy, consent management, PIA for any processing outside Québec, incident register, data minimization.                   |
| Accessibility | WCAG 2.2 AA target. Automated axe checks in E2E, and a manual screen-reader pass before launch.                                                                        |
| i18n          | `fr-CA` default, `en-CA` secondary. All UI strings, emails, notifications and errors are localized. Prices are formatted per locale (`4,50 $` vs `$4.50`).             |
| Observability | Structured JSON logs with request IDs, error tracking, and payment/webhook audit trail.                                                                                |
| Money         | Integer cents everywhere, CAD only, deterministic rounding rules documented and tested.                                                                                |

## 6. Success metrics (proposed)

- Share of transactions placed online; repeat-order rate within 30 days
- Median time from opening the app to a paid order, for returning users
- Loyalty enrolment rate among online customers
- Order-ready → picked-up time; number of orders cancelled due to sold-out items
