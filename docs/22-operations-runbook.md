# 22 — Operations Runbook

What to do, step by step, to deploy safely, keep the platform healthy and handle the incidents
that matter for a café that takes orders and payments online. Written for whoever runs the
platform (owner, or a developer on call).

## 1. Deploying

Vercel deploys `main` automatically. **The build does not migrate the database**, so a deploy
whose code needs a new migration must be preceded by that migration.

1. On your machine, with the change merged locally, check that it passes:
   `npm run check && npm run test:integration` (and `npm run test:e2e` for anything visible).
2. If the change adds a file in `packages/db/migrations/`, migrate production **first**:
   1. `npx vercel@latest env pull .env.production.local --environment=production --yes`
   2. Run the migrations against `DATABASE_URL_UNPOOLED` from that file (never the `-pooler`
      host): `DATABASE_URL=<unpooled url> npm run db:migrate`.
   3. Delete `.env.production.local`.

   Migrations only add (tables, columns with defaults), so the old code keeps working on the
   new schema while the deploy rolls out.

3. `git push origin main`.
4. Check `https://<site>/api/health`: `"status": "ok"` and `schema.applied` = `schema.expected`.
   A 503 with `schema.ok: false` means step 2 was missed: run it now.

**Rolling back:** in Vercel → Deployments, promote the previous deployment. Schema changes stay
(they are additive), so the older code still runs.

## 2. Scheduled jobs

Set `CRON_SECRET` (32+ random characters) in Vercel. Vercel Cron sends it as
`Authorization: Bearer …` automatically.

| Job                       | Schedule          | What it does                                                                  |
| ------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| `GET /api/cron/outbox`    | every minute      | Sends notifications not sent right after the change (retries)                 |
| `GET /api/cron/payments`  | every 5–10 min    | Reconciles payments stuck in checkout, resubmits pending refunds              |
| `GET /api/cron/retention` | daily (e.g. 3:00) | Deletes expired sign-in data, old guest contact details, old webhook payloads |

Vercel's **Hobby plan allows only daily cron jobs**. On Hobby, schedule the retention job on
Vercel and the two others with an external scheduler (e.g. cron-job.org or GitHub Actions)
calling the URLs with the bearer secret, or move to Pro. Example `vercel.json` for Pro:

```json
{
  "crons": [
    { "path": "/api/cron/outbox", "schedule": "* * * * *" },
    { "path": "/api/cron/payments", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/retention", "schedule": "0 7 * * *" }
  ]
}
```

(Times are UTC: 7:00 UTC is 3:00 in Montréal in summer, 2:00 in winter.)

## 3. Monitoring and alerts

| Watch                          | How                                                                                          | Alert when                     |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------ |
| Site and database up, migrated | Uptime monitor (e.g. Better Stack, UptimeRobot) on `/api/health`, every minute               | non-200 twice in a row         |
| Notifications flowing          | Same monitor, keyword check `"delayed":false`                                                | `delayed: true` for 15 minutes |
| Errors                         | Vercel → Logs, filter `level:error`; or a log drain to the monitoring tool                   | any `request failed` burst     |
| Payments                       | Staff → Paiements shows anything needing attention; Stripe Dashboard → Developers → Webhooks | failed webhook deliveries      |

Logs are JSON, carry a request id (`x-request-id` header on every API response, also shown to
customers on errors), and never contain contact details (tested).

## 4. Incidents

### Payment provider outage (Stripe down or erroring)

1. Symptoms: customers can't reach the payment page, or errors mention Stripe in the logs.
2. Staff → Pause online ordering (top of the queue) with a duration. Customers see that ordering
   is paused; nothing is charged.
3. Check https://status.stripe.com.
4. When it's back, resume ordering. Orders left unpaid expire on their own and free their slots.
   The payment job reconciles any checkout that succeeded during the outage.

### Webhook backlog (payments not confirmed)

1. Symptoms: customers paid, but orders stay "awaiting payment".
2. Stripe Dashboard → Developers → Webhooks: check the endpoint's failures. Fix the cause (wrong
   `STRIPE_WEBHOOK_SECRET` after a key rotation is the usual one), then **Resend** failed events.
   Processing is idempotent, so resending is always safe.
3. The payment recovery job (every 5–10 min) also asks Stripe directly about stuck checkouts, so
   orders confirm even if webhooks stay down.

### Refunds

- Day to day: Staff → Paiements, find the order, refund all or part with a reason (shift lead and
  up). Each refund is audited and the customer is emailed.
- A refund stuck "pending": the payment job resubmits it with the same idempotency key, so it can
  never pay out twice. If it stays pending for over an hour, look it up in Stripe.
- Never refund from the Stripe Dashboard if you can avoid it: it works (the webhook records it), but
  the reason isn't captured.

### Confidentiality incident (Law 25)

1. Contain it (revoke access in Équipe, rotate a leaked secret, take the page down).
2. Record it the same day in Administration → Confidentialité → Registre des incidents.
3. Assess the risk of serious injury (sensitivity, consequences, likelihood).
4. If serious: notify the Commission d'accès à l'information and the people concerned promptly,
   then date both notifications in the register. A serious incident can't be closed without them.

### Secret leaked or staff member leaving

- Remove a staff member's access in Administration → Équipe (their sessions end at once).
- Rotate in Vercel, then redeploy: `BETTER_AUTH_SECRET` (signs everyone out and invalidates
  unsubscribe links), `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (update both sides),
  `CRON_SECRET` (update the external scheduler), the database password (Neon console, then
  `vercel env pull` to check).

## 5. Backups and restore drill

Two layers:

- **Neon's history** (point-in-time restore; the window depends on the plan, check Neon → Project
  settings). The first resort: nothing to run, restores to any second in the window.
- **Logical dumps** (`npm run db:backup`): a file of the whole database with a manifest beside it
  (source without password, schema version, rows per table counted in the dump's own snapshot,
  SHA-256). For keeping a copy outside Neon (e.g. weekly, and before risky migrations). **A dump
  holds customers' personal information:** store it encrypted, in Canada, never in the repository
  (`backups/` and `*.dump` are git-ignored), and delete old ones on the retention schedule.

The tools use `pg_dump`/`pg_restore` when installed, otherwise the `postgres:17` Docker image
(nothing to install). On Neon, use the **direct** connection string (`DATABASE_URL_UNPOOLED`):
dumps can't go through the pooler.

| Command                                                     | What it does                                                                                                                                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run db:verify`                                         | Integrity checks on `DATABASE_URL`: migrations, constraints, loyalty and gift card balances against their ledgers, refunds against payments, paid orders against money received, stock counts against their movements |
| `npm run db:backup [-- --out <dir>]`                        | Dump of `BACKUP_DATABASE_URL` (or `DATABASE_URL`) to `backups/` with its manifest                                                                                                                                     |
| `npm run db:restore -- <file.dump> --target <empty db url>` | Checks the file against its manifest, restores into an **empty** database (refuses a non-empty one and `DATABASE_URL`), then checks the copy                                                                          |
| `npm run db:restore-drill [-- --target <url>] [--keep]`     | The drill in one step: dump → restore into a scratch database → integrity checks and row counts against the dump → timing report in `backups/` → scratch database dropped. The source is only read                    |

**Drill (once before launch, then every quarter, and after any change to the schema tooling):**

1. `BACKUP_DATABASE_URL=<production direct url> npm run db:restore-drill`. It creates
   `<database>_restore_drill` next to the source and drops it afterwards (on Neon: in the same
   branch; if the role can't create databases, create an empty one in the Neon console and pass it
   with `--target`).
2. It must end with `PASSED`. Keep the report (`backups/drill_*.json`: timings, row counts, checks;
   no personal data) with the date.
3. Neon history: Neon console → Branches → create a branch from a past point in time (e.g. one hour
   ago), then `DATABASE_URL=<branch direct url> npm run db:verify` and look up a few known orders.
   Write down how long it took and the point in time used. Delete the branch.

**Drill results:**

| Date       | Source                         | Size   | Rows | Backup | Restore + checks | Result |
| ---------- | ------------------------------ | ------ | ---- | ------ | ---------------- | ------ |
| 2026-10-28 | local E2E database (52 tables) | 182 KB | 372  | 1.7 s  | 1.8 s            | PASSED |

Not yet run against Neon (no production data yet): do step 1 and 3 on the production project
before launch.

**Real restore:**

- _From Neon's history:_ create the branch from just before the problem, run `db:verify` on it,
  then in Vercel point `DATABASE_URL` / `DATABASE_URL_UNPOOLED` at it (or restore the main branch in
  Neon) and redeploy.
- _From a dump:_ create an empty database (or Neon project), `npm run db:restore -- <file> --target
<its direct url>`, which must report every check `ok`, then point Vercel at it and redeploy. Run
  `npm run db:migrate` if the dump is older than the code.
- Either way, payments taken since that point stay in Stripe: reconcile them with Staff → Paiements
  and the Stripe Dashboard, and gift cards sold since then with the Stripe Dashboard.

## 6. Load test

`npm run test:load -w @ssc/web` builds the app, starts it on port 3200 against its own database
(`DATABASE_URL_LOAD`, created if missing and wiped every run) and plays four scenarios:

| Scenario | What happens                                                       | Must hold                                  |
| -------- | ------------------------------------------------------------------ | ------------------------------------------ |
| rush     | 300 guests quote, order, open checkout and pay, 30 at a time       | p95 within budget, no errors               |
| one-slot | 18 guests aim at one 6-order pickup slot at the same instant       | exactly 6 orders; the rest told it's taken |
| retries  | 50 checkouts, each submitted three times at once                   | one order per checkout                     |
| webhooks | 200 signed payment events, each delivered three times concurrently | each stored once, all answered 200         |

Afterwards it checks the database: no slot over capacity, order and payment counts match what was
answered over HTTP, every webhook event stored and processed once. Any 5xx, network error, broken
check or p95 over budget fails the run. Tune with `LOAD_CUSTOMERS`, `LOAD_CONCURRENCY`,
`LOAD_WEBHOOKS`, `LOAD_PORT`.

It uses the payment simulator, and its webhook events name sessions the app never created, so
Stripe is never called. Once the Stripe sandbox is set up, also check a webhook burst there.

**Baseline (2026-10-26, Windows laptop, local Docker Postgres):** 2,152 requests in 23 s, no
errors, every check held.

| Step (rush, 30 at a time) | p50    | p95    | Budget (p95) |
| ------------------------- | ------ | ------ | ------------ |
| Quote                     | 213 ms | 334 ms | 500 ms       |
| Place order               | 455 ms | 704 ms | 1,000 ms     |
| Open checkout             | 235 ms | 374 ms | 500 ms       |
| Pay (simulator)           | 594 ms | 807 ms | 1,000 ms     |
| Webhook delivery          | 131 ms | 182 ms | 300 ms       |

For scale: 300 paid orders in about 15 seconds, far above a café's real peak. Run it again
before launch and after changes to ordering or payments; a staging copy on Neon would give
production-like numbers.

## 7. Soft-launch checklist

Owner decisions and inputs:

- [ ] D1: POS / mandatory billing (SRS) answered with Revenu Québec or the CPA. **No live sales
      before this** (risk R1).
- [ ] D21: privacy impact assessment for data hosted in the US, or move to Canadian regions.
- [ ] D22: email provider and sending domain (SPF, DKIM, DMARC); `EMAIL_TRANSPORT=smtp`.
- [ ] Lawyer review of the privacy policy and terms; privacy officer named.
- [ ] GST/QST numbers on receipts; tax categories confirmed by the accountant.
- [ ] Real menu, prices, hours and photos entered; `npm run db:purge-demo` run against production.

Platform:

- [ ] `APP_ENV=production`, live Stripe keys, Stripe sandbox checklist done (docs/13).
- [ ] `STORAGE_DRIVER=vercel-blob` with a public Blob store; `CRON_SECRET` and the three jobs
      scheduled; VAPID keys if push is wanted.
- [ ] Uptime monitor on `/api/health` with alerts to the owner's phone.
- [ ] Restore drill done once against production (`npm run db:restore-drill`, local drill passed
      2026-10-28), and Neon point-in-time branch checked with `db:verify`.
- [ ] A test order end to end with a real card, refunded.
- [ ] Staff trained (docs/23-staff-guide.md).
