import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./index";
import {
  categories,
  deliveryZones,
  loyaltyAccounts,
  modifierGroups,
  openingHours,
  orders,
  payments,
  products,
  refunds,
  promotions,
  rewardRedemptions,
  rewards,
  storeClosures,
  storeSettings,
  users,
} from "./schema/index";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Seeding, purging and resetting are refused against deployed environments. */
export function assertNonProductionDatabase(appEnv: string | undefined): void {
  if (appEnv === "production" || appEnv === "staging") {
    throw new Error(`Refusing to modify development data when APP_ENV=${appEnv}`);
  }
}

/**
 * Deletes every record flagged is_demo (and their dependants). Real records are untouched.
 * Runs in one transaction, so it either removes all demo data or nothing.
 */
export async function purgeDemoData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    const demoOrders = tx.select({ id: orders.id }).from(orders).where(eq(orders.isDemo, true));
    const demoAccounts = tx
      .select({ id: loyaltyAccounts.id })
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.isDemo, true));
    const demoRewards = tx
      .select({ id: rewards.id })
      .from(rewards)
      .where(inArray(rewards.accountId, demoAccounts));

    await tx
      .delete(rewardRedemptions)
      .where(
        sql`${rewardRedemptions.orderId} in ${demoOrders} or ${rewardRedemptions.rewardId} in ${demoRewards}`,
      );
    await tx.delete(loyaltyAccounts).where(eq(loyaltyAccounts.isDemo, true));
    await tx.delete(refunds).where(inArray(refunds.orderId, demoOrders));
    await tx.delete(payments).where(inArray(payments.orderId, demoOrders));
    await tx.delete(orders).where(eq(orders.isDemo, true));
    await tx.delete(promotions).where(eq(promotions.isDemo, true));
    await tx.delete(deliveryZones).where(eq(deliveryZones.isDemo, true));
    await tx.delete(products).where(eq(products.isDemo, true));
    await tx.delete(modifierGroups).where(eq(modifierGroups.isDemo, true));
    await tx.delete(categories).where(eq(categories.isDemo, true));
    await tx.delete(users).where(eq(users.isDemo, true));
    await tx.delete(openingHours).where(eq(openingHours.isDemo, true));
    await tx.delete(storeClosures).where(eq(storeClosures.isDemo, true));
    await tx.delete(storeSettings).where(eq(storeSettings.isDemo, true));
  });
}
