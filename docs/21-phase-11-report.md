# 21 — Phase 11 Report: Growth

_2026-10-25. Migrations `0008_marketing.sql`, `0009_referrals.sql`. Scope:
[04 Phase 13](04-implementation-plan.md#phase-13--growth)._

**Status in one line:** managers run their own **promo codes**; the café can send **marketing
emails** to customers who opted in, with the sender identified and a one-click unsubscribe
(CASL); and a **referral program** is built and tested but **off until you set its terms
(D17)**.

## 1. What was built

### Promotions (Administration → Promotions, manager and owner)

The promo engine and promo codes at checkout already existed (Phase 3); this phase adds the admin.

- **Create and edit** a promotion:
  - code: letters, digits, dashes, stored in capitals and unique whatever the case;
  - names in French and English;
  - percentage (up to 100 %) or fixed amount;
  - whole order, chosen categories, or chosen products;
  - minimum purchase;
  - first and last day (inclusive, Montréal time);
  - overall and per-customer limits;
  - whether it combines with a free drink.
- **Never deleted:** switch it off instead. Orders that used it keep their discount (tested).
- **The list shows** each promotion's state (running, upcoming, ended, off), how many paid orders
  used it, and the total discount given.
- Audited (`promotion.created`, `promotion.updated` with the fields changed).

### Marketing email (Administration → Courriels, manager and owner)

- **Sender identity:** the business name and mailing address appear in every email. Sending is
  refused until both are set.
- **Campaigns:** subject and message in French and English (plain text, paragraphs). Drafts can
  be edited and sent as a **test to yourself**. **Sending** queues one email per consenting
  customer, in their language, once; the campaign then becomes "sent" and can't change. The list
  shows delivered, not sent (unsubscribed meanwhile) and pending counts.
- **Consent only:** customers who ticked the (never pre-ticked) offers box. Demo accounts never
  receive marketing. Consent is **checked again when each email goes out**, so someone who
  unsubscribes after a campaign is queued gets nothing.
- **Unsubscribe:**
  - every email has a signed link to a page with a **Me désabonner** button (opening the page
    alone changes nothing, since mail scanners open links);
  - every email also carries `List-Unsubscribe` and `List-Unsubscribe-Post` headers, so Gmail's
    and Apple Mail's unsubscribe button works in one click (RFC 8058);
  - the unsubscribe takes effect at once, well within CASL's 10 business days, and is recorded as
    a consent withdrawal in the audit log.
- Sent through the outbox (Phase 9), with its retries. A deleted account's queued emails are
  removed.

### Referrals (off by default; terms in Administration → Fidélité)

- **Each customer** gets a 7-character code on their Rewards page (no 0/O or 1/I, so it can be
  read aloud).
- **A newcomer** enters a code from their Rewards page. When their **first order of at least the
  minimum (before tip) is completed**, the referrer and the newcomer both get stamps on their card,
  shown in their history as referral stamps.
- **Abuse limits:**
  - newcomers only (account under 30 days old, no paid order yet), one code each;
  - no referring yourself;
  - the referrer must be a real customer (at least one paid order);
  - at most N rewarded referrals per referrer in any 30 days, after which a referral is declined;
  - the reward waits for completion, so a cancelled order earns nothing.
- **Rules (versioned with the loyalty program):** on/off (off), referrer stamps (2), newcomer
  stamps (1), minimum first order (5,00 $), monthly cap (5). These defaults are suggestions until
  you decide D17.

## 2. Test results

| Suite                             | Result                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Typecheck · ESLint · Prettier     | ✔ clean                                                                                                            |
| Unit                              | ✔ web 47, domain 107, env 9, ui 4                                                                                  |
| Integration — web (real Postgres) | ✔ 215 passed, incl. 17 new (promotions 5, marketing 7, referrals 5)                                                |
| E2E — Playwright + axe            | ◐ new growth.spec passed (with the setup, 7/7); the full-suite rerun was stopped for low memory and is still to do |

**Promotions:** the code applies at checkout as set, in any case, through the last day
(23:30 counts, the next morning doesn't); uses and discount counted; an edit or switching off
never changes a placed order; targets must exist; duplicates, more than 100 %, inconsistent
targets and reversed dates refused; managers only.

**Marketing:** only consenting customers, each in their language, once; refused without the
sender; unsubscribe at once even for a queued email (it is skipped); forged links refused; a
second click changes nothing; test sends go to staff only and leave the draft; every email has
the sender's address and the unsubscribe link; account deletion removes queued emails; managers
only.

**Referrals:** off by default; both sides rewarded once on the newcomer's first qualifying
completed order; waits for the minimum and for completion; own code, second code, older or
active customers and inactive referrers refused; the monthly cap declines the extra referral
(no stamps for either side).

### 2.1 Browser tests

New `growth.spec.ts`:

- a manager creates a 20 % code and a guest gets "Code appliqué." in the cart;
- a new customer opts in, a manager sets the sender and sends a campaign, the email arrives with
  the café's address, and the customer unsubscribes with the link (then finds the box unticked).

## 3. Known limitations

- **No referral browser test yet:** the program is off by default; the integration tests cover it.
- **Marketing email is plain text** (paragraphs). There are no images, no scheduling, and no
  segments beyond "everyone who consented".
- **Referral stamps aren't taken back** if the newcomer's first order is refunded after
  completion.
- **Real inboxes still need the email provider (D22).**

## 4. Decisions and inputs needed

1. **D17, referral terms:** what each side gets (stamps, or something else), the minimum first
   order and the monthly cap. Then turn the program on in Administration → Fidélité.
2. **Sender identity:** the café's legal business name and mailing address, in Administration →
   Courriels.
3. **Before the first campaign:** have counsel confirm the consent wording (Phase 2) and that
   implied-consent customers are excluded (the app only uses express consent).
