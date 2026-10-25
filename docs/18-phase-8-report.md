# 18 — Phase 8 Report: Privacy & Compliance (Law 25)

_2026-10-25. Migration `0005_privacy.sql`. Scope: [04 Phase 11](04-implementation-plan.md#phase-11--privacy--compliance-features)._

**Status in one line:** customers can download all their data and delete their account
themselves; the café has a privacy page and terms, a privacy officer, a log of privacy requests
with their 30-day deadlines, a register of confidentiality incidents, and a daily retention job.
**The privacy policy and terms are drafts that your lawyer must review** (§5). Logs are tested to
never contain personal data.

## 1. What was built

### For customers

| Where                        | What                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mon compte → Mes données** | **Download my data:** one JSON file with the account, profile, communication choices and consent history, orders (including those placed as a guest with the same email) with items, payments and refunds, the loyalty card and its history, favorites, cart, and active sign-ins (date, IP, browser). |
|                              | **Delete my account:** retype the email to confirm. Immediate and final (details below). Refused, with a clear message, while an order is still in progress or a refund is on its way. Team accounts are removed from the Team page first.                                                             |
| **Footer → Confidentialité** | Privacy policy: who we are, the privacy officer and how to reach them, what is collected and why, consent, providers (Vercel, Neon, Stripe, email provider TBD), where data is kept (US for now, PIA required), retention periods, rights, security, incidents, and the list of cookies.               |
| **Footer → Conditions**      | Terms of use and sale: orders, prices and taxes, payment and tip, pickup, cancellation and refunds, the loyalty card, the account, allergies, governing law.                                                                                                                                           |

**What deleting an account does:**

- **Deleted:** the account, profile, preferences and consents, sign-in sessions, loyalty card (stamps,
  unused free drinks, history, counter visits), favorites and cart.
- **Kept, anonymized:** orders and their payments and refunds, which must stay in the books
  (Revenu Québec: 6 years). They lose their link to the account, and their name, email, phone,
  address and customer notes. Amounts, taxes and items stay, so **reports don't change** (tested).
- Guest orders placed earlier with the same email are anonymized too.
- The deletion is logged as a completed privacy request and audited, without the email.

### For the café (Administration → Confidentialité, manager and owner)

- **Privacy officer:** name or title and a contact email, published on the privacy page.
  Law 25 makes the owner the officer by default.
- **Privacy requests:** requests received by email, phone, in person or by mail are logged with
  the requester's contact; a customer's email links the request to their account. Each is due **30
  days** after it arrived; open requests are listed first by due date, and overdue ones are flagged.
  Closing one records what was done (or why it was refused). Self-service copies and deletions
  appear here automatically, already completed.
- **Incident register:** every confidentiality incident: when it was discovered (and happened),
  what happened, the information involved, how many people, the risk of serious injury, the measures
  taken, and when the Commission d'accès à l'information and the people concerned were notified.
  Entries are corrected, never deleted. **A serious incident can't be closed until both
  notifications are dated**, and none can be closed before its risk is assessed.
- **Retention:** the periods in force, and whether the job is scheduled.

Every action here is audited under a new **Confidentialité** area of the audit log. The audit
trail records which fields changed, never an incident's content.

### Behind the scenes

- **Retention job** `GET /api/cron/retention` (Bearer `CRON_SECRET`, daily), idempotent:
  - deletes expired sessions (with their IP and browser), sign-in codes, loyalty card codes and
    old rate-limit counters;
  - **guest orders older than 365 days** (finished ones): removes name, email, phone and notes;
  - **Stripe webhook payloads older than 90 days**: replaced by `{"redacted": true}` (they contain
    the payer's email and address); the row stays, so a late duplicate is still recognised.
- **Log redaction:** guest names and phones, contact fields, IP addresses and browsers were added
  to the redacted keys. A test writes a log entry full of personal data and checks none of it is
  output, while ids stay.
- **Cookies:** the site only sets essential cookies (session, language, welcome page) and keeps
  the cart in local storage. There is no tracking, so no consent banner is needed; an E2E test
  checks every cookie set is one the policy lists.
- **Payments check fix (Reporting):** a 0,00 $ order (a free drink covering it all) is confirmed
  without a payment, and was wrongly flagged as a mismatch. Found by the deletion test; fixed.

## 2. Test results

| Suite                             | Result                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck · ESLint · Prettier     | ✔ clean                                                                                                                                                        |
| Unit — web                        | ✔ 39 passed, incl. the new log-redaction test                                                                                                                  |
| Integration — web (real Postgres) | ✔ 182 passed, incl. 15 new privacy scenarios (`privacy.int.test.ts`)                                                                                           |
| E2E — Playwright + axe            | ✔ 76 passed, 2 skipped (Stripe sandbox), incl. 4 new: export and deletion by a new customer; legal pages and cookies; privacy administration; baristas refused |

**Privacy scenarios:**

- The copy holds the account's own and guest orders, payments, loyalty, favorites, consents and
  sign-ins; nobody else's order; no session token; no internal staff note. It is logged and audited.
- Deletion removes the account and its data, anonymizes three orders (including one paid with a
  free drink, whose reward link must go first), leaves another customer's order alone, and **the
  sales report is identical before and after**.
- Deletion is refused for a wrong email, a staff account, an order in progress, a pending refund.
- Requests: 30-day due date, overdue first, linked to the account by email, closed once, no
  future dates.
- Incidents: can't close unassessed or serious-without-notices; corrections audited by field name.
- Privacy officer saved and normalised.
- Retention: expired session removed, old finished guest order anonymized (totals unchanged), a
  recent one, an account order and an unpaid one left alone, old webhook payload redacted, second
  run changes nothing.
- Every privacy function refuses customers, baristas and shift leads.

## 3. Known limitations

- **Legal text is a draft.** It describes what the platform actually does, but it isn't legal
  advice and must be reviewed (and adapted) by the café's lawyer before launch.
- **Stripe keeps its own records.** Deleting an account removes our link to the Stripe customer,
  but not the customer object at Stripe, which keeps payment records under its own obligations.
  Deleting it through Stripe's API can be added.
- **Orders are kept 6 years, but not yet deleted after that.** A purge of financial records past
  the legal period is a later job.
- **Staff-written texts on orders** (cancellation reasons, refund reasons, staff notes) are kept
  on anonymized orders; they rarely name the customer. They aren't in the customer's copy.
- **The retention job isn't scheduled on Vercel yet** (like the payment recovery job): set
  `CRON_SECRET` and add a daily cron.
- **Rectification** is done by the customer for their name and language; other corrections are
  handled by staff through the request log.

## 4. Still open from earlier phases

- **Live updates and notifications (plan Phase 7):** the staff queue still refreshes by polling,
  and there are no push or email notifications (email provider: D22).
- **POS connection (plan Phase 12):** blocked on D1.

## 5. Decisions and inputs needed

1. **Lawyer review** of the privacy policy and terms (both are marked as drafts on the site).
2. **Name the privacy officer** in Administration → Confidentialité (by default, the owner).
3. **Privacy impact assessment** before real customer data is stored in the US (D21, risk R6).
4. **Confirm retention periods** with counsel: guest contact details 365 days, Stripe payloads 90
   days, financial records 6 years.
5. **Schedule the jobs** on Vercel: `/api/cron/retention` daily and `/api/cron/payments` every
   5–10 minutes, with `CRON_SECRET`.
