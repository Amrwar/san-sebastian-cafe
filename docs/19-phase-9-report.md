# 19 — Phase 9 Report: Live Queue & Notifications

_2026-10-25. Migration `0006_notifications.sql`. Scope: [04 Phase 7](04-implementation-plan.md#phase-7--staff-console-realtime-notifications)._

**Status in one line:** the counter tablet and the customer's tracking page now update **live**,
within a few seconds of any change, and customers receive **order emails** (confirmed, ready,
cancelled or refused, refunded) in their language, plus **push notifications** on devices where
they turned them on. Emails go out through any SMTP relay; **choosing the email provider (D22) is
the last step before they reach real inboxes.**

## 1. What was built

### Live screens

- **Staff queue** (`/staff`): listens to `GET /api/v1/staff/orders/stream`. A new order appears,
  with the chime and the screen-reader announcement, within about 2 seconds; status changes made
  on another tablet show up the same way. The label reads **"En direct"**.
- **Customer tracking** (order page): listens to `GET /api/v1/orders/:id/stream` (owner, staff, or
  a guest with the order link) and stops once the order is finished.
- **How:** server-sent events. Each stream reloads the state every 2–3 s and sends it only when it
  changed, so it works across server instances without a message broker. A stream ends by itself
  after 4 minutes (within Vercel's function limit) and the browser reconnects. While the stream is
  down, the screens fall back to polling (every 10 s for the queue), as before.
- Unchanged and still tested: two staff tapping the same order (one wins, the other is told it
  changed), pausing online ordering, sold-out toggles.

### Notifications

| Message         | When                                                   | Email | Push |
| --------------- | ------------------------------------------------------ | :---: | :--: |
| Order confirmed | payment accepted (with total and pickup time)          |   ✔   |      |
| Order ready     | the café marks it ready                                |   ✔   |  ✔   |
| Order cancelled | cancelled by the café or the customer (reason, refund) |   ✔   |  ✔   |
| Order refused   | the café can't prepare it (reason, refund)             |   ✔   |  ✔   |
| Refund          | each refund on a served order (amount)                 |   ✔   |      |

- **Who receives them:** account holders at their account email, unless they turned order emails off
  (Mon compte → Communications); guests at the email given with the order. Emails are in the
  order's language; account holders get a "track my order" button. Guests don't, because their
  private tracking link isn't kept on the server.
- **Exactly one per event:** messages are written to an **outbox** in the same transaction as the
  order change, with a unique key per event and channel. A change that doesn't commit sends
  nothing, and a repeated or replayed change queues nothing new.
- **Sending:** right after each change, the request that made it sends what is due
  (`after()`); `GET /api/cron/outbox` (every minute) picks up anything left. Two workers never
  take the same message (row locks with `SKIP LOCKED`). Failures are retried after 1, 5, 25 and 125
  minutes, then marked failed. A worker that stops mid-way is taken over after 2 minutes, so a
  message can rarely go out twice but is never lost.
- **Email transport:** `EMAIL_TRANSPORT=smtp` with `SMTP_URL`. That's **Mailpit** locally
  (`docker compose up -d mailpit`, inbox at http://localhost:8025); when deployed, any provider's
  SMTP relay, with TLS required. The console transport stays for development and tests.
- **Web Push:** the customer turns it on per device in **Mon compte → Communications**, or with
  **"Me prévenir quand c'est prêt"** on an order being prepared. The service worker shows the
  notice and opens the order on tap. Devices the push service reports as gone are forgotten.
  Requires VAPID keys (`npx web-push generate-vapid-keys`). On iPhone, the site must first be
  added to the Home Screen (an Apple rule).
- **Privacy:** push devices are in the customer's data copy. Deleting an account deletes its
  devices and every message about its orders. The retention job deletes sent messages after 30
  days.

## 2. Test results

| Suite                             | Result                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Typecheck · ESLint · Prettier     | ✔ clean                                                                          |
| Unit — web                        | ✔ 47 passed (8 new: email and push templates in both languages, the live stream) |
| Unit — env                        | ✔ 9 passed (SMTP and VAPID settings)                                             |
| Integration — web (real Postgres) | ✔ 193 passed, incl. 11 new notification scenarios (`notifications.int.test.ts`)  |
| E2E — Playwright + axe            | ✔ 77 passed, 2 skipped (Stripe sandbox), incl. the new live tablet test (§2.1)   |

**Notification scenarios:**

- One confirmation and one "ready" email per order; a repeated payment is refused and queues
  nothing.
- A push is added only for customers with a device, only for the notices that need attention.
- Guests are emailed at their order address; a customer who turned emails off gets none.
- A cancellation announces its refund once (no second message when the refund settles); each
  later partial refund gets its own message with the running total.
- Nothing is sent for an unpaid order.
- **Two workers at the same time send each message exactly once**; a second run sends nothing.
- Retries back off (1, 5, 25, 125 minutes), then the message is marked failed.
- A message whose worker stopped is taken over once its claim expires.
- Deleting an account removes its messages.
- Push devices: one account at a time, removed only by their owner, `https` only.

**Template tests:** French and English text, Montréal pickup time, the link for account holders
only, the cancellation reason escaped in HTML, refund amounts.

### 2.1 Browser tests

New `live.spec.ts`, on a landscape tablet (1180 × 820, touch):

- The queue is already open when a guest orders. **The order appears within 6 seconds**, faster
  than the polling fallback, so only the live stream can pass.
- Each step reaches the customer's page live ("En préparation", then "Votre commande est prête!").
- The guest received exactly two emails: "Commande … confirmée", then "Votre commande … est prête".

## 3. Known limitations

- **No real inbox yet:** until D22 is decided and `SMTP_URL` set, deployed environments refuse to
  start with the console transport (as before), and the demo keeps logging emails.
- **Guests' emails have no tracking link** (their link is only shown once, at checkout).
- **Push needs VAPID keys** and, on iPhone, the site added to the Home Screen.
- **Staff get no push**; the open queue chimes and announces new orders instead.
- **Sign-in codes are still sent directly** (not through the outbox): they must go out at once,
  and a retry is the customer asking for a new code.
- **The live streams poll the database** every 2–3 s per open screen. That's fine for a café's
  handful of tablets and customers; Postgres LISTEN/NOTIFY is the upgrade if it ever grows.

## 4. Decisions and inputs needed

1. **D22: email provider and sending domain.** Any SMTP relay works (Postmark, Resend, Amazon
   SES…). Then add `SMTP_URL`, `EMAIL_FROM` on the café's domain, and SPF/DKIM/DMARC records.
2. **VAPID keys** for push: generate once and store as Vercel environment variables.
3. **Schedule** `/api/cron/outbox` every minute (with the other jobs, using `CRON_SECRET`).
