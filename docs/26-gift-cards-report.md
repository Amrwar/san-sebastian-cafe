# 26 — Gift Cards Report

_2026-10-26. Migration `0012_gift_cards.sql`. Scope: the gift card part of
[04 Phase 14](04-implementation-plan.md#phase-14--optional-modules-each-needs-an-owner-go-ahead),
"counter first" (owner's choice the same day): cards are sold at the counter and used online and
at the counter. Selling cards online is left for later._

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

- **Selling cards online** (Stripe purchase flow, code emailed to a recipient).
- **Physical card printing** beyond the browser's print button (card stock, QR code).
- **POS-native gift cards** if D1 brings a POS that has its own program.
- The privacy policy and terms should mention gift cards (lawyer review pending anyway).
