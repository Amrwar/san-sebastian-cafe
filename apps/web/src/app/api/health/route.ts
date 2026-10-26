import { NextResponse } from "next/server";
import { and, inArray, outboxMessages, sql } from "@ssc/db";
// Its own entry: it reads the migrations journal (JSON), which plain Node scripts can't import.
import { appliedMigrations, EXPECTED_MIGRATIONS } from "@ssc/db/schema-version";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";

export const dynamic = "force-dynamic";

/** A notification still waiting after this long means the worker isn't running. */
const OUTBOX_DELAY_WARNING_MINUTES = 10;

/**
 * Health for uptime monitoring. 503 when the database is unreachable or behind the code (a
 * deploy whose migrations weren't run). Notification delays are reported but don't fail it: the
 * site still works. Counts only; never personal data.
 */
export const GET = apiRoute(async (_req, { log }) => {
  const headers = { "cache-control": "no-store" };
  try {
    await db().execute(sql`select 1`);
  } catch (err) {
    log.error({ err }, "health check: database unreachable");
    return NextResponse.json({ status: "down", database: "unreachable" }, { status: 503, headers });
  }

  const [applied, [backlog]] = await Promise.all([
    appliedMigrations(db()),
    db()
      .select({
        pending: sql<number>`count(*)::int`,
        oldestMinutes: sql<
          number | null
        >`floor(extract(epoch from (now() - min(${outboxMessages.nextAttemptAt}))) / 60)::int`,
      })
      .from(outboxMessages)
      .where(and(inArray(outboxMessages.status, ["pending", "sending"]))),
  ]);
  const schemaOk = applied >= EXPECTED_MIGRATIONS;
  const delayed = (backlog?.oldestMinutes ?? 0) >= OUTBOX_DELAY_WARNING_MINUTES;
  if (!schemaOk)
    log.error({ applied, expected: EXPECTED_MIGRATIONS }, "health check: migrations not applied");
  if (delayed) log.warn({ ...backlog }, "health check: notifications delayed");

  return NextResponse.json(
    {
      status: !schemaOk ? "down" : delayed ? "degraded" : "ok",
      database: "ok",
      schema: { applied, expected: EXPECTED_MIGRATIONS, ok: schemaOk },
      notifications: {
        pending: backlog?.pending ?? 0,
        oldestMinutes: Math.max(0, backlog?.oldestMinutes ?? 0),
        delayed,
      },
    },
    { status: schemaOk ? 200 : 503, headers },
  );
});
