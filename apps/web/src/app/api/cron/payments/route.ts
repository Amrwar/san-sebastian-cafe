import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { AppError, notFound } from "@/server/errors";
import { apiRoute } from "@/server/http";
import { runPaymentRecovery } from "@/server/modules/payments/recovery";

export const dynamic = "force-dynamic";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * GET /api/cron/payments — payment recovery job (Vercel Cron or any scheduler). Requires
 * `Authorization: Bearer $CRON_SECRET`; disabled (404) when CRON_SECRET isn't set.
 */
export const GET = apiRoute(async (req, { log }) => {
  const secret = env().CRON_SECRET;
  if (!secret) throw notFound("Route");
  const given = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`)))
    throw new AppError("unauthenticated", "Invalid cron credentials");
  const summary = await runPaymentRecovery(db());
  log.info(summary, "payment recovery run");
  return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
});
