import { and, eq, pushSubscriptions, type Database } from "@ssc/db";
import { z } from "zod";
import { authorize, type Actor } from "../authz";
import { fromZodError } from "../errors";

/*
 * Devices where a signed-in customer turned on Web Push. A device belongs to one account at a
 * time: signing in to another account on it and turning push on moves it there.
 */

export const pushSubscriptionInput = z
  .object({
    endpoint: z
      .url()
      .max(2000)
      .refine((v) => v.startsWith("https://"), "https only"),
    keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
  })
  .loose();

export async function savePushSubscription(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  userAgent: string | null,
): Promise<void> {
  authorize(actor, "profile:update_own");
  const parsed = pushSubscriptionInput.safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  const { endpoint, keys } = parsed.data;
  const values = {
    userId: actor.userId,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent: userAgent?.slice(0, 300) ?? null,
  };
  await db
    .insert(pushSubscriptions)
    .values({ endpoint, ...values })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { ...values, updatedAt: new Date() },
    });
}

export async function removePushSubscription(
  db: Database,
  actor: Actor | null,
  raw: unknown,
): Promise<void> {
  authorize(actor, "profile:update_own");
  const parsed = z.object({ endpoint: z.string().max(2000) }).safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, parsed.data.endpoint),
        eq(pushSubscriptions.userId, actor.userId),
      ),
    );
}
