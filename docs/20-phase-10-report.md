# 20 — Phase 10 Report: Guest Stamp Claim & Accounts Close-out

_2026-10-25. Migration `0007_guest_claim.sql`. Scope: the remaining items of
[04 Phase 8](04-implementation-plan.md#phase-8--loyalty--customer-history) (guest-order stamp
claim, ACC-2) and [04 Phase 4](04-implementation-plan.md#phase-4--auth-accounts-roles) (sign-up,
sign-in and sign-out tested in both languages)._

**Status in one line:** a guest who pays and then creates an account with the same email within
14 days (configurable) gets those orders in their history and their stamps on the card. With
this, plan Phases 4 and 8 are complete.

## 1. What was built

- **Claim at sign-up.** When an account is created, which with sign-in codes means its email is
  verified, the café's paid guest orders placed with that address in the last `guestClaimDays`
  join the account:
  - the orders appear in the account's history;
  - they earn their stamps exactly as if placed signed in, once only;
  - with "earn on completion", an order still being prepared earns when it is completed;
  - cancelled, refused, refunded and unpaid orders are left as they are;
  - the claim is audited (`loyalty.guest_orders_claimed`).
- **A program rule.** **"Jours pour réclamer une commande invitée"** in Administration → Fidélité:
  14 days by default (decision D11), 0 turns it off, at most 90. Versioned like the other rules.
- **Guest order page.** A guest viewing their order through its private link sees "Créez un
  compte avec l'adresse courriel de cette commande d'ici le {date} : ses tampons seront ajoutés à
  votre carte fidélité", with a **Créer mon compte** button.
- A failed claim never blocks the sign-up; it is logged.

## 2. Test results

| Suite                             | Result                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Typecheck · ESLint · Prettier     | ✔ clean                                                                           |
| Unit                              | ✔ web 47, domain 107, env 9, ui 4                                                 |
| Integration — web (real Postgres) | ✔ 198 passed, incl. 5 new claim scenarios (`guest-claim.int.test.ts`)             |
| E2E — Playwright + axe            | ✔ 78 passed, 2 skipped (Stripe sandbox), incl. the new English sign-up with claim |

**Claim scenarios:**

- An account gets its recent guest order and 2 stamps, regardless of email case. The order joins
  its history, and claiming again gives nothing more.
- Left out: orders past the window, cancelled, unpaid, or placed with another email.
- With "earn on completion", the stamps come when the café completes the order.
- Claiming turned off (0 days): nothing.
- The window is a versioned rule, refused above 90 days.

**New E2E (English):** a guest orders an Americano, sees the claim offer, signs up in English
with the same email (onboarding in English), finds **"Stamp card: 1 of 5 stamps"** and the
order in their history, then signs out and is asked to sign in again. French sign-up, sign-in
and sign-out were already covered.

**Phase 8 and 4 exit criteria**, already covered by earlier suites:

- two simultaneous redemptions of one reward: exactly one succeeds;
- refund reversal;
- reward-paid drinks don't earn;
- every privileged service refuses unauthorized actors (permission matrices in each module's
  tests).

## 3. Known limitations

- **Only orders within the window are linked.** Older guest orders with the same address stay
  as guest orders (they still count in the café's reports).
- **The guest's order emails don't mention the claim yet**; the order page does.
