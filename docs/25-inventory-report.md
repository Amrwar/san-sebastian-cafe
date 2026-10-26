# 25 — Inventory and Auto-86 Report

_2026-10-26. Migration `0010_inventory.sql`. Scope: the inventory part of
[04 Phase 14](04-implementation-plan.md#phase-14--optional-modules-each-needs-an-owner-go-ahead),
started on the owner's go-ahead the same day._

**Status in one line:** staff can count stock for any product or option; a count at zero takes
the item off sale everywhere by itself, orders take stock as they are placed and can never take
more than is left, and an order stopped before preparation puts its stock back. Counting is
optional: an item left blank works exactly as before.

## 1. What was done

### How it behaves

| Situation                                            | What happens                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Item not counted (blank)                             | On sale as before; only the manual "Épuisé" / pause buttons apply                 |
| Count reaches 0                                      | Sold out on the menu, the product page, the cart and at checkout ("auto-86")      |
| Customer asks for more than is left                  | The cart says how many remain ("Il n’en reste que 2 : réduisez la quantité")      |
| Order placed                                         | Its units are taken from each counted product and option, in the same transaction |
| Two customers take the last units at the same moment | Exactly the units left are sold; the other order is refused, nothing goes below 0 |
| Unpaid order expires                                 | Its stock comes back                                                              |
| Order cancelled or refused before preparation begins | Its stock comes back                                                              |
| Order cancelled once it is being made (or later)     | Stock stays used: the ingredients are gone                                        |
| Late payment on an expired order                     | Refunded automatically (unchanged); the order stays expired, stock stays back     |

Each unit of a line uses one unit of its product and one unit of every option chosen for it (so
"oat milk" can be counted on its own and sells out across every drink that offers it).

### Staff screen

**Personnel → Disponibilité** now has, for each product and option, a "Unités en stock" field:
enter the count on hand and **Enregistrer le stock**; **Ne plus compter** clears it. The badge
shows "N en stock", or "Épuisé (stock à 0)". The French staff guide has a new section.

### Ledger and audit

- `products.stock_quantity`, `modifier_options.stock_quantity`: the current count, null = not
  counted, never negative (database check).
- `stock_movements`: every change, in the same transaction: `sale` (order placed), `release`
  (order stopped), `restock` / `adjustment` (staff count), with the order, the staff member and the
  count after. An order's stock is returned from its own ledger rows (sales minus releases), so it
  can never be returned twice.
- Each staff count is also in the audit log (`catalog.product_stock_set` /
  `catalog.option_stock_set`, from and to).

### Code

- Domain (pure): `catalog/stock.ts` (out-of-stock rule, what a cart uses, which lines the stock
  can't serve), `stockReturnsOn` in the order state machine, and the quote marks over-stock lines.
- Server: `modules/inventory/stock.ts` — `takeStock` (guarded decrement, items locked in id order
  so simultaneous orders can't deadlock), `releaseStock`, `setStock`;
  `PUT /api/v1/staff/stock` (permission `catalog:toggle_availability`, same as the 86 buttons).

### Also fixed

Local end-to-end runs failed to start after any new migration: Playwright starts the app before
its setup migrates the test database, and the health check (correctly) refuses a database behind
the code. The E2E web server now migrates its database first.

## 2. Test results

| Suite                         | Result                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck · ESLint · Prettier | ✔ clean                                                                                                                                                                                                                                                                                   |
| Domain unit                   | ✔ 139 (new: auto-86, cart-wide stock, a property test that served lines never exceed stock, when stock returns); coverage 96.5 % branches                                                                                                                                                 |
| Integration (real Postgres)   | ✔ 228 web + 12 db (new `inventory.int.test.ts`, 11: menu sold out at 0, option at 0, ledger, over-stock refusal, 6 simultaneous orders for 3 units → exactly 3, expiry returns once, cancel before/after preparation, tracking turned off meanwhile, staff counts and audit, permissions) |
| E2E — Playwright + axe        | ✔ 91 passed, 7 skipped (Stripe sandbox, opt-in); new: staff counts Cappuccino to 0 → a guest sees it unavailable; clearing the count puts it back                                                                                                                                         |

## 3. Not done (options)

- **Low-stock warning** (e.g. a badge on the queue at 3 left) and a stock history screen: the
  ledger already holds the data.
- **Recipes** (one latte uses 250 ml of milk) and units other than "pieces": counts are per
  product or option.
- **Per-size stock** (counting small and large cups separately).
- **POS sync** of counts depends on D1.
