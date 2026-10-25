import {
  and,
  eq,
  inArray,
  loyaltyAccounts,
  loyaltyInStoreVisits,
  orderItems,
  orders,
  refunds,
  rewardRedemptions,
  rewards,
  sql,
  users,
  type Tx,
  type Database,
} from "@ssc/db";
import { z } from "zod";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound, unprocessable } from "../../errors";
import { ownOrderIds } from "./export";
import { recordSelfServiceRequest } from "./requests";

/*
 * Account deletion (Law 25). The account and everything tied only to it are deleted: profile,
 * preferences and consents, sign-in sessions, loyalty card and history, favorites, cart.
 *
 * Orders are financial records the café must keep for tax purposes (Revenu Québec: 6 years), so
 * they stay, anonymized: no account link, no name, email, phone, address or customer notes. Their
 * amounts, taxes and items remain, which is all the books need.
 */

/** Stands in for the customer's email on anonymized orders (an order must name a customer). */
export const ANONYMIZED_EMAIL = "anonymized@deleted.invalid";

/** Statuses during which the café is still preparing or charging the order. */
const IN_PROGRESS = ["awaiting_payment", "paid", "accepted", "in_preparation", "ready"] as const;

export const deletionInput = z.object({ confirmEmail: z.string().trim().min(3).max(320) }).strict();

/** Removes a customer's contact details from orders (kept for the books). */
export async function anonymizeOrders(tx: Tx, orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) return 0;
  const updated = await tx
    .update(orders)
    .set({
      userId: null,
      guestEmail: ANONYMIZED_EMAIL,
      guestName: null,
      guestPhone: null,
      guestAccessTokenHash: null,
      notes: null,
      deliveryAddress: sql`case when ${orders.deliveryAddress} is null then null else '{"anonymized":true}'::jsonb end`,
      updatedAt: new Date(),
    })
    .where(inArray(orders.id, orderIds))
    .returning({ id: orders.id });
  await tx.update(orderItems).set({ notes: null }).where(inArray(orderItems.orderId, orderIds));
  return updated.length;
}

/**
 * Deletes the signed-in customer's account after they retype its email. Refused while an order is
 * still being prepared or paid, or a refund is on its way (the café may need to reach them).
 * Staff accounts are removed by the owner from the team page instead.
 */
export async function deleteOwnAccount(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  now = new Date(),
): Promise<{ ordersAnonymized: number }> {
  authorize(actor, "profile:update_own");
  const parsed = deletionInput.safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  if (actor.role !== "customer") throw unprocessable("staff_account");
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user) throw notFound("Account");
  if (parsed.data.confirmEmail.toLowerCase() !== user.email.toLowerCase())
    throw new AppError("validation_failed", "Email does not match", [
      { path: "confirmEmail", code: "mismatch" },
    ]);

  const orderIds = await ownOrderIds(db, user.id, user.email);
  const result = await db.transaction(async (tx) => {
    // Lock the orders so none starts or changes while the account goes.
    const locked =
      orderIds.length === 0
        ? []
        : await tx
            .select({ id: orders.id, status: orders.status })
            .from(orders)
            .where(inArray(orders.id, orderIds))
            .for("update");
    if (locked.some((o) => (IN_PROGRESS as readonly string[]).includes(o.status)))
      throw unprocessable("orders_in_progress");
    const [pending] =
      orderIds.length === 0
        ? []
        : await tx
            .select({ id: refunds.id })
            .from(refunds)
            .where(and(inArray(refunds.orderId, orderIds), eq(refunds.status, "pending")))
            .limit(1);
    if (pending) throw unprocessable("refund_pending");

    const ordersAnonymized = await anonymizeOrders(tx, orderIds);

    // Free drinks used on orders or at the counter: the orders keep their discount amounts; the
    // link to the deleted card goes.
    const [account] = await tx
      .select({ id: loyaltyAccounts.id })
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.userId, user.id));
    if (account) {
      await tx.delete(rewardRedemptions).where(
        sql`${rewardRedemptions.rewardId} in (select ${rewards.id} from ${rewards} where ${rewards.accountId} = ${account.id})
          or ${rewardRedemptions.inStoreVisitId} in (select ${loyaltyInStoreVisits.id} from ${loyaltyInStoreVisits} where ${loyaltyInStoreVisits.accountId} = ${account.id})`,
      );
    }
    // Everything else tied to the account is removed by the database (ON DELETE CASCADE).
    await tx.delete(users).where(eq(users.id, user.id));
    await recordSelfServiceRequest(tx, null, "deletion", now, { ordersAnonymized });
    return { ordersAnonymized };
  });
  return result;
}
