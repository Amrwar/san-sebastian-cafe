# 15 — Phase 5 Report: Loyalty Engine

_2026-10-16. Migration `0004_loyalty_engine.sql`. Rules: [01 §4.6](01-product-requirements.md#46-loyalty-loy).
Decisions: [07](07-open-decisions.md) (D5–D10)._

**Status in one line:** the stamp-card programme now runs on an append-only ledger with versioned
rules. It covers online orders and counter purchases, refunds and cancellations, staff corrections, a
customer history that explains every entry, and a staff loyalty screen. Everything is tested
end to end. D9 is settled: counter stamps stay on (§6).

## 1. What was built

**Rules (domain, pure):** `packages/domain/src/loyalty/loyalty.ts`

- Stamps per drink unit, not per order. Free, excluded or under-paid drinks earn nothing, and the
  reason is recorded per line. Optional per-purchase cap.
- Full cards convert to rewards, and leftover stamps carry forward. New stamps first settle any
  stamps owed.
- Refund reversal works in this order: stamp balance first, then unused rewards (newest first), then
  the shortfall policy. That policy is `carry_forward` (stamps owed) or `forgive` (written off). The
  balance never goes negative.
- Reward value: the size price, plus extras when covered, up to an optional cap. Optional expiry
  (off by default because of the Québec CPA).
- Short-lived counter codes use an 8-character alphabet with no ambiguous characters.

**Ledger and program (server):** `apps/web/src/server/modules/loyalty/`

- `ledger.ts`: every write locks the account row, and an idempotency key per source makes repeats
  harmless. Each entry stores `balanceAfter` and `debtAfter`.
- `program.ts`: owner-only, gapless and audited program versions. Each entry and reward records its
  version, so changes are never retroactive.
- `earning.ts`: lifecycle hooks:
  - earning on `paid` (or `completed`, per program);
  - reversal per refunded line, then the rest on a full refund or cancellation;
  - free drinks committed on payment and given back on cancellation or refund
    (`reinstate` / `keep_redeemed` policy).
- `in-store.ts` _(new)_: counter purchases.
  - Lookup by customer code (first name and card only).
  - Recording a receipt: catalog facts are read on the server, and each receipt number can be used
    once. Repeats with the same key are idempotent. Stamps are capped per visit and per café day
    (America/Toronto). An optional free drink goes on the most expensive eligible drink.
  - Voiding a visit (shift lead and above) reverses its stamps and gives back its free drink.
- `staff.ts` _(new)_: customer lookup by exact email or code, returning the masked email only. The
  card view includes recent counter visits. Corrections are shift lead and above, need a reason, are
  idempotent and audited, and staff can't correct their own card:
  - add or remove stamps;
  - forgive stamps owed;
  - withdraw an unused reward.

**API:**

- `POST /api/v1/me/loyalty/card-code`
- `POST /api/v1/staff/loyalty/lookup`
- `POST /api/v1/staff/loyalty/visits`
- `POST /api/v1/staff/loyalty/visits/:id/void`
- `POST /api/v1/staff/loyalty/customers/:id/adjust`

**Screens:**

- **Rewards page:**
  - "Show my code" panel with expiry;
  - notice for stamps owed;
  - reward expiry dates;
  - each history entry explained (drinks counted and not counted with the reason, receipt or order,
    cause, staff reason);
  - history pagination.
- **Staff → Fidélité** (linked from the queue):
  - counter purchase form (code, receipt, items, free drink);
  - customer search;
  - card view with history and recent visits;
  - shift-lead corrections and cancellations.
- FR/EN copy for all of it.

## 2. Test results (run locally 2026-10-16)

| Suite                                   | Result                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| Typecheck · ESLint · Prettier           | ✔ clean                                                                      |
| Unit — domain                           | ✔ 107 passed (incl. the new loyalty rule tests)                              |
| Unit — web                              | ✔ 27 passed (incl. FR/EN catalog parity)                                     |
| Integration — db                        | ✔ 12 passed                                                                  |
| Integration — web (real Postgres)       | ✔ 116 passed, incl. **21 new loyalty scenarios** (`loyalty.int.test.ts`)     |
| E2E — Playwright + axe, desktop + phone | ✔ 60 passed (new: counter code → stamp → cancel) · 2 skipped: Stripe sandbox |

Loyalty scenarios covered:

- **Earning:**
  - per drink unit;
  - card conversion;
  - a free drink earns nothing while the paid drink beside it does;
  - two simultaneous payments for one customer;
  - earning on completion.
- **Refunds and cancellations:**
  - a partial refund reverses only the refunded drinks and can't exceed what was bought;
  - an unused reward covers a refund before stamps are owed;
  - carry-forward debt, then repayment;
  - the forgive policy;
  - free drink given back vs. kept;
  - a rejected paid order reverses once.
- **Program:** owner-only versions, validation, `no_changes`, audit, non-retroactive terms,
  expiry only under a program that sets it.
- **Counter:**
  - code lookup and expiry;
  - one stamp per receipt;
  - idempotent replay;
  - free drink on the most expensive eligible item;
  - per-visit and per-day caps;
  - switch-off;
  - voiding (shift lead and above, once).
- **Staff:** minimum-PII lookup, corrections with reasons, retry safety, audit, no self-correction,
  debt forgiveness.
- **Every scenario** checks the ledger invariant: running totals chain entry to entry and match the
  cached balance, and lifetime stamps equal the sum of `earn` entries.

The concurrent-redemption exit criterion (two orders, one free drink → exactly one succeeds) is
covered in `ordering.int.test.ts`.

## 3. Issues found and fixed during the phase

- **Date-dependent payment tests:**
  - **Problem:** two recovery tests pinned the clock to 2026-10-12, but the database stamped rows with
    the real time. They began failing once the real date passed the pinned one.
  - **Fix:** payment attempts and refunds now record the service's clock (`now`).
- **Missing history labels:** the rewards page had labels for only 4 of the 9 ledger kinds. A
  redemption, repayment, reinstatement or expiry would have broken the customer's history page.
- **Schema test:** it still used the Phase 3 ledger shape (no `balanceAfter` or idempotency key).
- **Lint:** errors in the new loyalty modules, such as non-null assertions and unsafe spreads.

## 4. Known limitations

- **No admin screen yet for program rules (Phase 9).** `saveProgramVersion` exists and is tested;
  until the screen is built, rules change only through code or SQL.
- The counter code is shown as text, not a QR code; staff type it in.
- Counter purchases are entered by hand from the till receipt. POS integration (D1, Phase 12) would
  replace this.
- Guest-order stamp claim (D11), favorites and reorder polish from Phase 8 are not part of this
  phase.

## 5. Coverage target

The Phase 3 ≥95 % branch-coverage and property-based-test targets are still open: there is no
coverage tooling or fast-check yet.

## 6. Decisions and inputs needed

1. **D9 decided (2026-10-16):** the owner kept counter stamps **on**; the decision record now matches program version 1.
2. **D6/D8:** free-drink scope (extras charged, no cap) and the promo rule are implemented as the
   defaults; confirm.
3. **Legal:** expiry stays off (CPA). Confirm the wording of the rewards terms before launch.
