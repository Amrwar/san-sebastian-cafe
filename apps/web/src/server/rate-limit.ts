import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { rateLimits, sql, type Database } from "@ssc/db";
import type { NextRequest } from "next/server";
import { env } from "./env";
import { AppError } from "./errors";

/*
 * Request limits for abuse-prone actions (placing orders, guessing codes, exports…). Counters live
 * in the database (the same table as the sign-in limits, with an "app:" prefix), so every server
 * instance shares them. A fixed window per key: simple, and enough to stop scripted abuse.
 * Old counters are cleared by the retention job.
 */

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  windowSeconds: number;
}

/** Limits by action. Generous for people, tight for scripts. */
export const LIMITS = {
  placeOrder: { max: 10, windowSeconds: 60 },
  cartQuote: { max: 120, windowSeconds: 60 },
  referralCode: { max: 10, windowSeconds: 3600 },
  unsubscribe: { max: 30, windowSeconds: 3600 },
  dataExport: { max: 5, windowSeconds: 3600 },
  accountDeletion: { max: 5, windowSeconds: 3600 },
  reportExport: { max: 60, windowSeconds: 3600 },
  pushSubscription: { max: 20, windowSeconds: 3600 },
  /** Gift card balance checks: a person checks a card or two; guessing codes needs millions. */
  giftCardLookup: { max: 20, windowSeconds: 3600 },
  /** Online gift card purchases: card-testing fraud tries many small payments quickly. */
  giftCardPurchase: { max: 5, windowSeconds: 3600 },
} as const satisfies Record<string, Limit>;

/** Who is asking: the account when signed in, otherwise a hash of the address (never stored raw). */
export function requester(req: NextRequest, userId: string | null | undefined): string {
  if (userId) return `user:${userId}`;
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  return `ip:${createHash("sha256").update(ip).digest("base64url").slice(0, 22)}`;
}

/** Counts one request; throws a 429 problem once the window's budget is spent. */
export async function enforceLimit(
  db: Database,
  action: keyof typeof LIMITS,
  who: string,
  now = Date.now(),
): Promise<void> {
  const { windowSeconds } = LIMITS[action];
  // End-to-end tests send everything from one address: looser there, same logic.
  const max = LIMITS[action].max * (env().APP_ENV === "test" ? 20 : 1);
  const key = `app:${action}:${who}`;
  const windowStart = now - windowSeconds * 1000;
  const [row] = await db
    .insert(rateLimits)
    .values({ id: randomUUID(), key, count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        // A new window starts once the previous one is over.
        count: sql`case when ${rateLimits.lastRequest} < ${windowStart} then 1 else ${rateLimits.count} + 1 end`,
        lastRequest: sql`case when ${rateLimits.lastRequest} < ${windowStart} then ${now} else ${rateLimits.lastRequest} end`,
      },
    })
    .returning({ count: rateLimits.count });
  if ((row?.count ?? 0) > max)
    throw new AppError("rate_limited", `Too many ${action} requests`, [], "rate_limited");
}
