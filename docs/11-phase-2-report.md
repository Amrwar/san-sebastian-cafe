# 11 — Phase 2 Report: Customer Experience & Design System

_Completed 2026-10-11 · Status: **done, awaiting approval for Phase 3**_

**Not production-ready for ordering.** Customers can browse, customize, build a server-priced cart and
review checkout, but **no order can be placed and nothing is charged**: order placement, payments
(provider decision D1/D2) and the Québec SRS billing question (R1) are still open.

## 1. Pages and flows delivered

| #   | Requirement                           | Route(s)                                                                       | Backed by                                                                                                                        |
| --- | ------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Welcome & onboarding                  | `/welcome` (3-step intro), `/onboarding` (after first sign-in)                 | Cookie `ssc_welcomed`; `completeOnboarding` service                                                                              |
| 2   | Home & featured                       | `/` — greeting, active-order banner, featured products, stamp card, categories | DB: featured flag, orders, loyalty ledger                                                                                        |
| 3   | Menu, categories, search              | `/menu?q=&category=`                                                           | Bilingual, accent-insensitive search; GET form (works without JS)                                                                |
| 4   | Product detail & customization        | `/menu/[slug]`                                                                 | **Driven only by menu configuration** (variants, groups, min/max, availability, deltas)                                          |
| 5   | Cart with quantity & modifier editing | `/cart` (edit returns to product with `?edit=`)                                | `POST /api/v1/cart/quote` — server prices every view                                                                             |
| 6   | Pickup / delivery selection           | `/checkout`                                                                    | Pickup slots from configured hours (DST-safe); delivery by active zone + postal code (none active → clearly disabled)            |
| 7   | Checkout interface                    | `/checkout`                                                                    | Contact validation, Québec-compliant tip, server total; **"Order and pay" disabled with explanation**; working "Review my order" |
| 8   | Sign-in, registration, recovery       | `/sign-in`, `/sign-in?mode=register`, `/sign-in/help`                          | Passwordless codes; resend; rate limits; recovery guidance (no password exists to reset)                                         |
| 9   | Profile & preferences                 | `/account`                                                                     | Partial-update settings service                                                                                                  |
| 10  | Favorites & reorder                   | `/favorites`, reorder on `/orders/[id]`                                        | Favorites table (idempotent); reorder re-prices in cart                                                                          |
| 11  | Loyalty card & rewards wallet         | `/rewards`                                                                     | Ledger balance, rewards, history; free drink usable in the cart quote                                                            |
| 12  | Order history & detail                | `/orders`, `/orders/[id]`                                                      | Customer sees only own orders (others → 404)                                                                                     |
| 13  | Live order tracking                   | `/orders/[id]`                                                                 | Polls `/api/v1/me/orders/:id/status`; backoff; pauses offline / tab hidden; stops when done                                      |
| 14  | Notification preferences              | `/account/notifications`                                                       | Email prefs + consent audit; push and SMS shown as **not available yet**                                                         |
| 15  | Gift cards & promotions               | `/gift-cards` (clearly unavailable), `/promotions` (live data)                 | Promotions engine in the quote; gift cards need POS integration                                                                  |

Navigation: bottom tab bar on phones (Home, Menu, Cart with live count, Rewards, Account), header
navigation on desktop, account sub-navigation (incl. Staff/Admin for those roles).

PWA: web manifest, generated icons (original, placeholder until the café's logo), minimal service worker
that **never caches prices, carts, orders or API responses** and shows a localized offline page.

## 2. Backend contracts added

`GET /api/v1/menu?q&category` · `GET /api/v1/products/:slug` · `POST /api/v1/cart/quote` ·
`GET /api/v1/store/fulfilment` · `GET|POST /api/v1/me/favorites` · `DELETE /api/v1/me/favorites/:id` ·
`GET /api/v1/me/orders` · `GET /api/v1/me/orders/:id` · `GET /api/v1/me/orders/:id/status` ·
`GET /api/v1/me/loyalty` · `GET /api/v1/promotions`. All Zod-validated, authorized in services, RFC 9457 errors.

Domain (pure, tested): menu-configuration validation, unit pricing, **quote engine** (promotions with
order/product/category scope, free-drink reward with cap, delivery fee + minimum, tip presets on the
pre-tax amount, GST/QST invoice-level rounding), pickup availability in `America/Toronto`.

Database (migration `0001_storefront`): featured flag, onboarding timestamp, store settings, opening
hours, closures, favorites. Seed now includes demo hours, 6 demo products, 2 demo orders priced by the
real engine, a demo customer with 7 lifetime stamps / 1 free drink / 1 favorite — all labelled demo.

## 3. States covered

Loading skeletons (menu route, cart, checkout summary) · empty states (menu, search, cart, favorites,
orders, rewards, promotions) · validation errors (product groups, checkout contact/slot/tip, profile) ·
retry actions (quote failures, server reference id shown) · slow-network notice (> 2.5 s) · offline
handling (auto-retry on reconnect, offline page) · disabled states (sold-out sizes/options/products,
max reached, delivery unavailable, payment) · unavailable products flagged in cart with fix guidance ·
success states (added/updated, favourite saved, preferences saved, code applied, checkout review OK).

## 4. Test results (run locally 2026-10-11)

| Suite                                                  | Result                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting / types / lint                              | ✔ clean (all workspaces)                                                                                                                                                                                                                             |
| Unit                                                   | ✔ **70 passed** (domain 44, env 5, ui 4, web 17)                                                                                                                                                                                                     |
| Integration (Postgres)                                 | ✔ **63 passed** (db 12, web 51 — incl. reward/order/favorite ownership)                                                                                                                                                                              |
| End-to-end (Playwright + axe, desktop **and** Pixel 7) | ✔ **54 passed** — journeys: customize → cart edit with exact tax math, checkout review, search, sold-out, server error + retry, slow network, welcome, rewards, tracking, reorder, favourite + free drink, onboarding, role access; axe on 14 routes |
| Migration drift                                        | ✔ none                                                                                                                                                                                                                                               |

Defects found and fixed during the phase: unknown pages/products returned **200 instead of 404**
(streaming loading boundary) — boundaries restructured and covered by a test; tracking could schedule a
poll after unmount — fixed; client cart reward logic simplified to a server-chosen reward.

## 5. Known limitations / next decisions

- Ordering cannot complete: Phase 6 (payments, order placement, slot capacity, reward reservation).
- Loyalty is read-only in the UI; earning on payment and redemption commits arrive with Phase 6/8.
- Tracking polls every 10 s; real-time push (SSE / web push) is Phase 7.
- Product photos: none supplied — labelled illustrations are used; `next/image` remote hosts must be
  configured when the owner's photo storage is chosen.
- Delivery fee taxation, tax categories and rounding still need accountant confirmation (⚖ R9).
- Tip presets 10/15/18 % and "no expiry" stamps are defaults pending owner decisions D13/D10.
- Content-Security-Policy still deferred to Phase 15.
- Demo deployment data lives in the US (D21) — demo data only until a PIA is done.
