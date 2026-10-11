import { customerProfiles, loyaltyAccounts, notificationPreferences, type Database } from "@ssc/db";
import type { Locale } from "@ssc/domain";

/**
 * Creates the records every account needs: profile, default notification preferences and a
 * loyalty account. Idempotent, so it is safe to call again for an existing user.
 * Defaults are privacy-protective: transactional order emails on, marketing OFF (no consent).
 */
export async function provisionAccount(
  db: Database,
  userId: string,
  locale: Locale = "fr-CA",
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(customerProfiles)
      .values({ userId, preferredLocale: locale })
      .onConflictDoNothing();
    await tx
      .insert(notificationPreferences)
      .values([
        { userId, channel: "email", topic: "order_updates", enabled: true },
        { userId, channel: "email", topic: "marketing", enabled: false },
      ])
      .onConflictDoNothing();
    await tx.insert(loyaltyAccounts).values({ userId }).onConflictDoNothing();
  });
}
