# 26 — Gift Cards Report

_2026-10-26. Migration `0012_gift_cards.sql`. Scope: the gift card part of
[04 Phase 14](04-implementation-plan.md#phase-14--optional-modules-each-needs-an-owner-go-ahead),
"counter first" (owner's choice the same day): cards are sold at the counter and used online and
at the counter. **Online sale added the same day** (§4, migration `0013_gift_card_purchases.sql`)._

**Status in one line:** staff sell a card once it is paid at the till and get a code to write or
print; customers check the balance on the site and pay with it at checkout (all or part of the
order, after tax); staff use it at the counter, block it or correct it; refunds go back to the
card; the reports reconcile it and show what the café owes on cards.

## 1. What was done

### Rules (Québec)

- **No expiry date and no fees of any kind.** A balance only goes down by purchases and back up
  by refunds; there is no inactivity charge and nothing in the code can add one.
- **A gift card is a way to pay, not a sale:** no GST/QST when it is sold (the till rings it as a
  non-taxable item); taxes apply to what it buys, exactly as with any other payment.
- Cards from 5 $ to 500 $. No customer data is kept on a card.

### How a card works

| Step                             | What happens                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sold (shift lead and up)         | Paid at the till, then created on **Personnel → Cartes-cadeaux**. The 16-character code (no 0/O/1/I/L) is shown once to write or print; only its SHA-256 hash is stored            |
| Balance check (anyone)           | **/gift-cards**: code → balance and whether it can be used. The code is sent in the request body, never the address; 20 checks per hour per visitor                                |
| Paying online                    | At checkout, "Code de carte-cadeau" → the summary shows the card's part and "À payer par carte". The card pays the total after tax (tip included); Stripe is charged only the rest |
| Fully covered                    | No card payment at all: the order is paid at once                                                                                                                                  |
| Small remainder                  | The card never leaves less than 0,50 $ (Stripe's minimum) to charge: it then pays a little less                                                                                    |
| Balance changed meanwhile        | The order is refused ("the amount changed") rather than charging more than the customer saw                                                                                        |
| Unpaid order expires / cancelled | The card's hold goes back, once                                                                                                                                                    |
| Paid order cancelled / refused   | Card payment refunded in full, the gift card's part credited back at once                                                                                                          |
| Partial refund (completed order) | Card money first, then the gift card                                                                                                                                               |
| At the counter (staff)           | Look a card up by code, take a purchase off it (the till rings it as paid by gift card), see its history                                                                           |
| Lost or stolen (shift lead+)     | Block the card (balance kept), unblock it later                                                                                                                                    |
| Correction (manager)             | Add or remove an amount, with a reason; never below zero                                                                                                                           |

### Ledger, audit and reports

- `gift_cards` holds the balance; `gift_card_transactions` records every change (issue, redeem,
  release, refund, adjustment) with the order, the staff member and the balance after, in the same
  transaction. A guarded update means a balance can't go below zero even when the card is used
  twice at once (tested).
- Refunds to a gift card are rows in `refunds` (with `gift_card_id`, settled at once), so refund
  totals and net sales count them like any other refund. An order is fully refunded when card
  refunds plus gift card refunds reach its total.
- Each issue, counter use, block and correction is in the audit log.
- **Sales report:** the payments check now adds card payments and gift cards ("4,00 $ encaissés
  par carte et 12,30 $ payés par carte-cadeau"); a new **Cartes-cadeaux** section shows the
  balances owed today, cards sold, amounts spent and corrections in the period.

## 2. Test results

| Suite                         | Result                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck · ESLint · Prettier | ✔ clean                                                                                                                                                                                                                                                                                                                                                                 |
| Domain unit                   | ✔ 145 (new: codes, rejection-sampled generation and round trip, how much a card pays, the 0,50 $ rule, quote property: card + amount due = total); 96.7 % branches                                                                                                                                                                                                      |
| Integration (real Postgres)   | ✔ 248 web + 12 db (new `gift-cards.int.test.ts`, 17: issue with only the hash stored, balance check, roles and limits, counter use, blocked card, simultaneous use never below zero, partial and full cover, the 0,50 $ rule, changed balance refused, expiry releases once, cancel and partial refunds card-first, gift-only refund, report reconciliation, liability) |
| E2E — Playwright + axe        | ✔ 94 passed, 7 skipped (Stripe sandbox, opt-in); new: a manager sells a card → a guest checks it and pays an order with it → staff see the payment in its history; staff without the role can't sell                                                                                                                                                                    |

The Stripe sandbox run (report 13 §7) was not repeated for gift cards: a partly covered order
sends Stripe a smaller amount through the same code path, which the integration tests cover with
the payment simulator.

## 3. Not done (options)

- **Physical card printing** beyond the browser's print button (card stock, QR code).
- **POS-native gift cards** if D1 brings a POS that has its own program.
- The privacy policy and terms should mention gift cards (lawyer review pending anyway).

## 4. Selling cards online (added 2026-10-26)

**On /gift-cards, "Offrir une carte-cadeau":** amount (25 $, 50 $, 100 $ or 10–200 $), the
recipient's name and email, an optional note (300 characters), the purchaser's name (and email
for guests). Payment happens on Stripe's page; the card is issued only when Stripe confirms the
money.

| Step                                                             | What happens                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Payment confirmed                                                | By the verified webhook or the return page's authenticated status check, whichever comes first; the card is issued **once**                                                                                                    |
| The code                                                         | Emailed to the recipient only (FR/EN), then **erased from the email queue once sent**; never stored, never shown on the site                                                                                                   |
| The purchaser                                                    | Gets a receipt without the code ("not taxable"), and a page showing the card was sent                                                                                                                                          |
| Paid after the page expired, a second payment, or a wrong amount | Refunded automatically through Stripe; no card is issued                                                                                                                                                                       |
| Refund (shift lead and up)                                       | From the staff gift card screen, while the card is unused: the card is emptied and blocked, the money goes back through Stripe                                                                                                 |
| Fraud                                                            | 5 purchases per visitor per hour; online amounts limited to 10–200 $ (card-testing favours small payments); Stripe Radar                                                                                                       |
| Personal data (Law 25)                                           | Purchaser and recipient names, emails and the note: in the purchaser's data export (and the recipient's, without the code); removed with the account; cleared by the retention job after one year. The card (money owed) stays |
| Reports                                                          | The gift card section shows cards bought online and the money received in the period                                                                                                                                           |

Stripe tags these sessions as gift card purchases (`gift_card_purchase_id` in metadata, "Carte-cadeau" as
the line); they never touch the order tables, the kitchen queue or loyalty.

**Found and fixed while testing:** queued emails are due from the database clock, which can run
slightly ahead of the app's; the first purchase on a fresh server could then miss the immediate
send. Gift card emails are now due from the app's clock, as order notices already were.

**Tests:** `gift-card-purchases.int.test.ts` (12): form limits, card issued once with the code
only in the recipient's email, access by link token or account, the code erased after sending,
webhook and return-page paths (either order), late and wrong-amount payments refunded, staff
refund of an unused card (and refused once used, and for staff without the role), data export
and anonymization, retention. E2E: a guest buys a card, the simulator pays, the recipient's email
holds a code that works on the balance page. Totals with this addition: integration 258 web + 12
db, E2E 95 passed (7 skipped, Stripe sandbox).
