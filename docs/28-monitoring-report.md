# 28 — Monitoring and Alerts Report

_2026-10-28. Migration `0015_monitoring.sql`. Scope: knowing that something is wrong before a
customer says so: server errors, scheduled jobs that stop, notifications that pile up, and a
database left behind the code._

**Status in one line:** server errors and the café's operational signals now reach one alert
webhook (Slack, Discord, Teams or a monitoring service), once when something breaks and once when
it recovers; every scheduled job records its runs; an uptime monitor can read every signal from
`/api/health/details`; the owner sees the same signals on the admin overview.

## 1. What was already there

`/api/health` (database reachable, migrations applied, notification backlog) for an uptime
monitor, structured JSON logs with a request id and no personal data, and three scheduled jobs.
Nothing noticed a job that had stopped running, and errors were visible only to someone reading
the logs. The outage of 2026-10-28 (five migrations never applied in production) showed the gap:
the health check did report it, but nothing told anyone.

## 2. What was added

| Area            | Behaviour                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alerts          | `ALERT_WEBHOOK_URL` (https outside development). Posted as `text` and `content`, so Slack, Teams and Discord all read it. Never throws; without a webhook an alert is a log line.                                                |
| Server errors   | Any 5xx from an API route, and any page, server action or proxy crash (`onRequestError`), alerts with the route, the request id and a scrubbed message. Once per 10 minutes per route and error.                                 |
| Scrubbing       | Alert texts lose emails, phone numbers, ids, API keys, bearer tokens and URL credentials; the query string is dropped from routes.                                                                                               |
| Job heartbeats  | `job_runs`: each job's last start, success, failure (with a short scrubbed error), run and failure counts. The outbox job counts a failed run even though it doesn't throw.                                                      |
| Signals         | Database schema, notification delay (10 min warning, 30 min problem), notifications that gave up in 24 h, and each scheduled job (never ran, late, very late, last run failed). Jobs are watched only when `CRON_SECRET` is set. |
| Monitor job     | `GET /api/cron/monitor` (every 5–10 min, `CRON_SECRET`): compares the signals with `monitor_signals` and alerts on a change only. A problem first seen at startup alerts at once; an undelivered alert is retried.               |
| Detailed health | `GET /api/health/details` with `Authorization: Bearer $MONITORING_TOKEN` (404 when unset): all signals and job runs; 503 when a signal fails.                                                                                    |
| Admin overview  | **System status** panel: overall state, each signal with its detail, and notes when alerts or scheduled jobs aren't set up. French and English.                                                                                  |

## 3. Tests

- Unit (`alerts.test.ts`, 5): scrubbing, alert format, webhook down or missing, error
  deduplication and the quiet window.
- Integration (`monitoring.int.test.ts`, 6, real Postgres): job heartbeats, every signal
  threshold, nothing personal in signals, alert-on-change, first-seen problems, retry after a
  failed delivery without resetting how long the problem has lasted.
- E2E (`monitoring.spec.ts`, 3): the detailed health report refuses the wrong token, the monitor
  job needs the scheduler secret and records its run, the owner sees the panel (with an axe
  check). The E2E server gets test-only secrets (`e2e/secrets.ts`).

## 4. To switch it on in production

See [22 §3](22-operations-runbook.md#3-monitoring-and-alerts): set `ALERT_WEBHOOK_URL`,
`MONITORING_TOKEN` and `CRON_SECRET` in Vercel, schedule the jobs, run the migrations, and point
the uptime monitor at the two health URLs. Until the jobs are scheduled, the admin overview says
so instead of showing them as broken.

## 5. Not done

- Alerts go to one webhook; there is no paging or on-call rotation (a monitoring service on the
  other end of the webhook can provide it).
- Error deduplication is per server instance: several instances may each send the first alert.
- Without a webhook, a bad signal is logged again on every monitor run until it recovers.
