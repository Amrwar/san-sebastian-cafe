# 17 — Phase 7 Report: Reporting

_2026-10-25. No migration (reports read the existing order, payment, refund and loyalty tables).
Scope: [04 Phase 10](04-implementation-plan.md#phase-10--reporting), requirement ADM-5,
acceptance criterion A3._

**Status in one line:** managers and the owner have a **Rapports** page. It covers sales, GST
and QST, tips, refunds, sales by day, hour, product and category, and loyalty (including an
estimated liability), with four CSV exports for the accountant. The tests check the totals
against the order and payment records to the cent. **The way refunded taxes are split needs your
accountant's confirmation** (§4).

## 1. What was built

**Rapports page** (`/admin/reports`, manager and owner). Choose a period with the quick links
(today, yesterday, last 7 days, this month, last month) or two dates, up to a year. The page shows:

| Block                | What it shows                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headline figures     | Sales, net after refunds (with the number of refunds), paid orders, average order                                                                                   |
| Payments check       | "Sales and payments match" with the amount collected, or the list of paid orders whose payment is missing or different. Late or duplicate payments are listed apart |
| Taxes and tips       | Sales, refunds and net, each split into goods, GST, QST and tips. Discounts and free drinks given                                                                   |
| By day, by hour      | Column charts (hover shows the figures), each with a table view                                                                                                     |
| By product, category | Quantity, free units and sales after discounts (before refunds)                                                                                                     |
| By tax category      | Taxable, zero-rated and exempt sales                                                                                                                                |
| Refunds by source    | By the team, customer cancellation, automatic, from Stripe                                                                                                          |
| Loyalty              | Free drinks earned, used (and their value), withdrawn, owed today; estimated liability; stamps in progress                                                          |
| Exports (CSV)        | Sales by day · orders · refunds · sales by product                                                                                                                  |

**Rules the figures follow:**

- **Times are Montréal times**, and days have their real length across daylight-saving changes.
  An order paid at 23:30 counts on that day, even though it's already the next day in UTC.
- **A sale counts on the day it was paid**, even if the order is cancelled later.
- **A refund counts on the day it settles**, on its own line. Sales are never rewritten.
- **Unpaid and expired orders never count.**
- **Late or duplicate payments**, which are refunded automatically, count as neither sales nor
  refunds. They are reported apart so the money still adds up.
- **Demo data is left out by default.** Orders with demo products are demo orders, and so are
  the demo customer's loyalty card and the seeded orders. Today the menu holds only demo
  products, so on the demo site the report is empty unless **"Inclure les commandes de
  démonstration"** is ticked. A warning then says the figures aren't real.

**CSV exports.** UTF-8 with a byte-order mark (accents display correctly in Excel), commas,
amounts like `12.34`, Montréal dates and times. They contain no customer names or emails. Text
that a spreadsheet would run as a formula (a refund reason starting with `=`) is defused. Each
export is recorded in the audit log under a new **Rapports** area.

**API:** `GET /api/v1/admin/reports/sales?from&to[&demo=1]` (JSON) and
`GET /api/v1/admin/reports/export?kind=days|orders|refunds|products&from&to&locale[&demo=1]`.

## 2. Test results

| Suite                             | Result                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| Typecheck · ESLint · Prettier     | ✔ clean                                                                                 |
| Unit — web                        | ✔ 38 passed (9 new: refund split, date ranges and presets)                              |
| Integration — web (real Postgres) | ✔ 167 passed, incl. 12 new report scenarios (`reports.int.test.ts`)                     |
| E2E — Playwright + axe            | ✔ admin spec 15 passed (2 new: the reports page with export download; baristas refused) |

**Report scenarios (A3: totals reconcile to the cent).** A week of orders is placed and paid
through the real ordering and payment services (development simulator):

- Sales, GST, QST and tips equal the sums of the order records. The amount collected equals the
  order payments, and nothing is flagged as mismatched.
- An order paid at 23:30 counts on its Montréal day. Hours are Montréal hours.
- A 2,30 $ order refunded in two parts (1,00 $ then 1,30 $) on different days. Each day's report
  shows its part split pro rata. Together they return exactly the order's 0,10 $ GST and 0,20 $
  QST.
- Sales by product, category and tax category.
- A payment changed to the wrong amount is flagged.
- Demo orders are left out by default and included on request.
- Loyalty: free drinks earned, used (with value), owed, the estimated liability, and the
  reward-paid drink shown as a free unit.
- CSV: headers, amounts, refund status, no customer details, formula defused, audit entry.
- Permissions: staff and shift leads are refused; invalid periods are refused.

## 3. Issues found and fixed during the phase

- **Demo orders would have hidden everything.** On the demo site every order contains demo
  products, so excluding demo data alone gave an empty report. Added the "include demo orders"
  option, which the page, the API and the exports all honour.
- **Negative amounts in CSV were defused as formulas** (`-1.50` became `'-1.50`). Plain numbers
  are now left alone.

## 4. Known limitations

- **Refunded taxes are split pro rata.** A refund stores only its amount. Its GST, QST and tip
  shares are proportional to the order. Several partial refunds that make up a whole order return
  exactly its taxes. **Confirm this treatment with your accountant** (see
  [08](08-compliance-notes.md): CPA). Refunds that name specific items still use the pro-rata
  split.
- **Product and category figures are before refunds**, since refunds aren't tied to amounts per
  item. Names and categories are today's, so a renamed product shows its new name.
- **The loyalty liability is an estimate:** free drinks owed × the average value of free drinks
  used so far. Earned, used and withdrawn counts use each reward's current status, so a free
  drink given back after a refund no longer counts as used.
- **Comma-separated files.** A French-language Excel may expect semicolons. Opening the file
  through Excel's import (Data → From Text/CSV) handles it, and accounting software reads commas.
- **No comparison with a previous period yet** (e.g. this week vs last week).

## 5. Decisions and inputs needed

1. **Accountant review** of the tax lines and the refund split (§4), before the first return
   filed from these figures.
2. **Semicolon CSV:** say if the accountant prefers semicolon-separated files with decimal
   commas, and a French variant of the exports will be added.
