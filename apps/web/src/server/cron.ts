import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { env } from "./env";
import { AppError, notFound } from "./errors";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Scheduled jobs (Vercel Cron or any scheduler) send `Authorization: Bearer $CRON_SECRET`. Without
 * CRON_SECRET the job routes don't exist (404).
 */
export function assertCronRequest(req: NextRequest): void {
  assertBearer(req, env().CRON_SECRET, "Invalid cron credentials");
}

/**
 * The detailed health report is for the uptime monitor: `Authorization: Bearer
 * $MONITORING_TOKEN`. Without MONITORING_TOKEN the route doesn't exist (404).
 */
export function assertMonitoringRequest(req: NextRequest): void {
  assertBearer(req, env().MONITORING_TOKEN, "Invalid monitoring credentials");
}

function assertBearer(req: NextRequest, secret: string | undefined, message: string): void {
  if (!secret) throw notFound("Route");
  const given = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`)))
    throw new AppError("unauthenticated", message);
}
