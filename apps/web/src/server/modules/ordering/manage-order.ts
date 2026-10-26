import { and, count, eq, ne, orders, sql, type Database } from "@ssc/db";
import {
  customerCanCancel,
  customerCanModify,
  ORDER_STATUSES,
  REFUNDABLE_ORDER_STATUSES,
  refundRequiredOnCancel,
} from "@ssc/domain";
import { z } from "zod";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound, required, unprocessable } from "../../errors";
import { computeAvailability, holdsSlot, loadStoreConfig } from "../store/pickup";
import { closeOpenCheckouts } from "../payments/checkout";
import {
  primaryPayment,
  refundableForOrder,
  refundToGiftCard,
  requestRefund,
  submitRefunds,
} from "../payments/refunds";
import { applyTransition, lockOrder, recordOrderEvent, type OrderActor } from "./lifecycle";
import { resolveOrderAccess } from "./order-access";

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

function staffActor(actor: Actor): OrderActor {
  return { kind: "staff", userId: actor.userId, role: actor.role };
}

/** Current status after post-commit work (refund settlement) has run. */
async function statusOf(db: Database, orderId: string) {
  const order = required(
    await db.query.orders.findFirst({ where: eq(orders.id, orderId) }),
    "order",
  );
  return { status: order.status, version: order.version };
}

/**
 * Customer cancellation (policy: until the café accepts). Paid orders are refunded in full: the
 * refund is recorded with the cancellation, then sent to the provider once both are committed.
 */
export async function cancelOrderAsCustomer(
  db: Database,
  actor: Actor | null,
  orderId: string,
  guestToken?: string | null,
  now = new Date(),
) {
  const access = await resolveOrderAccess(db, actor, orderId, guestToken);
  if (access.via === "staff") throw notFound("Order"); // staff use the staff actions instead
  const refundIds = await db.transaction(async (tx) => {
    const order = required(await lockOrder(tx, orderId), "order");
    if (!customerCanCancel(order.status)) throw unprocessable("cancel_not_allowed");
    const customer: OrderActor = { kind: "customer", userId: actor?.userId ?? null };
    const updated = await applyTransition(tx, order, "cancelled", customer, {
      reason: "Cancelled by customer",
      guestVerified: access.via === "guest_token",
      now,
    });
    return refundInFull(
      tx,
      updated,
      "Cancelled by customer",
      "customer_cancel",
      { kind: "system" },
      now,
    );
  });
  await submitRefunds(db, refundIds, now);
  await closeOpenCheckouts(db, orderId);
  return { status: (await statusOf(db, orderId)).status };
}

/**
 * Gives back everything a stopped order paid: its card payment (returned as refund ids to submit
 * after commit) and the part its gift card paid (credited back to the card at once).
 */
async function refundInFull(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  order: {
    id: string;
    status: (typeof ORDER_STATUSES)[number];
    paidAt: Date | null;
  },
  reason: string,
  source: "customer_cancel" | "staff",
  actor: OrderActor,
  now = new Date(),
): Promise<string[]> {
  if (!order.paidAt) return [];
  const refundIds: string[] = [];
  const payment = await primaryPayment(tx, order.id);
  if (payment) {
    const amount = refundRequiredOnCancel({
      paid: true,
      totalCents: payment.amountCents,
      refundedCents: payment.refundedCents,
    });
    if (amount > 0) {
      refundIds.push(
        await requestRefund(tx, {
          payment,
          orderStatus: order.status,
          amountCents: amount,
          reason,
          source,
          actor,
        }),
      );
    }
  }
  const current = required(await lockOrder(tx, order.id), "order");
  const { giftCardCents } = await refundableForOrder(tx, current);
  if (giftCardCents > 0) {
    await refundToGiftCard(tx, {
      orderId: order.id,
      amountCents: giftCardCents,
      reason,
      source,
      actor,
      now,
    });
  }
  return refundIds;
}

export const customerUpdateInput = z
  .object({
    /** New scheduled pickup time (must be an offered slot). */
    scheduledFor: z.iso.datetime().optional(),
    notes: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.scheduledFor !== undefined || v.notes !== undefined, {
    message: "Nothing to update",
  });

/**
 * Modification policy: pickup time and instructions only, before acceptance and at least 15 min
 * before the scheduled time. A new time must be an offered slot with capacity (slot locked).
 */
export async function updateOrderAsCustomer(
  db: Database,
  actor: Actor | null,
  orderId: string,
  raw: unknown,
  guestToken?: string | null,
  now = new Date(),
) {
  const input = parse(customerUpdateInput, raw);
  const access = await resolveOrderAccess(db, actor, orderId, guestToken);
  if (access.via === "staff") throw notFound("Order");
  return db.transaction(async (tx) => {
    const order = required(await lockOrder(tx, orderId), "order");
    if (!customerCanModify(order, now)) throw unprocessable("modify_not_allowed");
    const changes: Partial<typeof orders.$inferInsert> = {};
    if (input.notes !== undefined) changes.notes = input.notes || null;
    if (input.scheduledFor !== undefined) {
      const at = new Date(input.scheduledFor);
      const config = await loadStoreConfig(tx);
      const availability = await computeAvailability(tx, config, now);
      if (!availability.slots.some((s) => s.startsAt === at.toISOString()))
        throw unprocessable("slot_unavailable");
      if (config.settings.maxOrdersPerSlot) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`slot:${at.toISOString()}`}))`,
        );
        const [held] = await tx
          .select({ n: count() })
          .from(orders)
          .where(and(eq(orders.slotStart, at), holdsSlot(now), ne(orders.id, order.id)));
        if ((held?.n ?? 0) >= config.settings.maxOrdersPerSlot) throw unprocessable("slot_full");
      }
      changes.scheduledFor = at;
      changes.slotStart = at;
    }
    const [updated] = await tx
      .update(orders)
      .set({ ...changes, version: sql`${orders.version} + 1` })
      .where(eq(orders.id, order.id))
      .returning();
    await recordOrderEvent(
      tx,
      order.id,
      "customer_updated",
      { kind: "customer", userId: actor?.userId ?? null },
      {
        ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
        ...(input.notes !== undefined ? { notesChanged: true } : {}),
      },
    );
    const row = required(updated, "order");
    return { status: row.status, scheduledFor: row.scheduledFor };
  });
}

export const staffTransitionInput = z.object({
  to: z.enum(ORDER_STATUSES),
  reason: z.string().trim().max(300).optional(),
  /** Version shown on the staff screen; a concurrent change returns 409. */
  expectedVersion: z.number().int().nonnegative(),
});

/** Staff status change. Cancelling or rejecting a paid order refunds it in full automatically. */
export async function transitionOrderAsStaff(
  db: Database,
  actor: Actor | null,
  orderId: string,
  raw: unknown,
  now = new Date(),
) {
  authorize(actor, "orders:transition");
  const input = parse(staffTransitionInput, raw);
  if (input.to === "refunded" || input.to === "partially_refunded") {
    throw new AppError("validation_failed", "Use the refund action", [
      { path: "to", code: "use_refund" },
    ]);
  }
  const refundIds = await db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw notFound("Order");
    const staff = staffActor(actor);
    const updated = await applyTransition(tx, order, input.to, staff, {
      reason: input.reason ?? null,
      expectedVersion: input.expectedVersion,
      now,
    });
    // Cancelling or rejecting a paid order refunds it in full, requested by this staff member.
    return input.to === "cancelled" || input.to === "rejected"
      ? refundInFull(tx, updated, input.reason ?? input.to, "staff", staff, now)
      : [];
  });
  await submitRefunds(db, refundIds, now);
  if (input.to === "cancelled") await closeOpenCheckouts(db, orderId);
  return statusOf(db, orderId);
}

export const staffRefundInput = z.object({
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(3).max(300),
  /** Drinks/items being paid back; their loyalty stamps are reversed when the refund succeeds. */
  items: z
    .array(z.object({ orderItemId: z.uuid(), quantity: z.number().int().min(1).max(20) }).strict())
    .max(50)
    .optional(),
});

/** Full or partial refund by a shift lead or above. */
export async function refundOrderAsStaff(
  db: Database,
  actor: Actor | null,
  orderId: string,
  raw: unknown,
  now = new Date(),
) {
  authorize(actor, "orders:refund");
  const input = parse(staffRefundInput, raw);
  // Card money is given back first, then the gift card's part.
  const { cardRefundId, giftCardRefundId } = await db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw notFound("Order");
    const available = await refundableForOrder(tx, order);
    if (!available.payment && !order.giftCardId) throw unprocessable("not_paid");
    // An order still in the kitchen is cancelled instead (which refunds it in full).
    if (!REFUNDABLE_ORDER_STATUSES.includes(order.status))
      throw unprocessable("refund_not_allowed");
    if (input.amountCents > available.cardCents + available.giftCardCents) {
      throw new AppError("validation_failed", "Refund amount not available", [
        { path: "amountCents", code: "amount_invalid" },
      ]);
    }
    const byCard = Math.min(input.amountCents, available.cardCents);
    const toGiftCard = input.amountCents - byCard;
    const common = { reason: input.reason, source: "staff" as const, actor: staffActor(actor) };
    const card =
      available.payment && byCard > 0
        ? await requestRefund(tx, {
            ...common,
            payment: available.payment,
            orderStatus: order.status,
            amountCents: byCard,
            items: input.items,
            now,
          })
        : null;
    const gift =
      toGiftCard > 0
        ? await refundToGiftCard(tx, {
            ...common,
            orderId,
            amountCents: toGiftCard,
            items: card ? [] : input.items,
            now,
          })
        : null;
    return { cardRefundId: card, giftCardRefundId: gift };
  });
  const [cardStatus] = cardRefundId ? await submitRefunds(db, [cardRefundId], now) : [];
  return {
    ...(await statusOf(db, orderId)),
    refundId: cardRefundId ?? giftCardRefundId,
    refundStatus: cardStatus ?? "succeeded",
    ...(giftCardRefundId ? { giftCardRefundId } : {}),
  };
}

export const staffNotesInput = z.object({ staffNotes: z.string().trim().max(500) });

/** Internal preparation notes (never shown to the customer). */
export async function updateStaffNotes(
  db: Database,
  actor: Actor | null,
  orderId: string,
  raw: unknown,
) {
  authorize(actor, "orders:transition");
  const input = parse(staffNotesInput, raw);
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw notFound("Order");
    const [updated] = await tx
      .update(orders)
      .set({ staffNotes: input.staffNotes || null, version: sql`${orders.version} + 1` })
      .where(eq(orders.id, orderId))
      .returning({ version: orders.version });
    await recordOrderEvent(tx, orderId, "staff_note_updated", staffActor(actor), {
      length: input.staffNotes.length,
    });
    return { version: required(updated, "order").version };
  });
}
