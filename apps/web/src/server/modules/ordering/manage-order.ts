import { and, count, eq, ne, orders, sql, type Database } from "@ssc/db";
import {
  customerCanCancel,
  customerCanModify,
  ORDER_STATUSES,
  refundRequiredOnCancel,
} from "@ssc/domain";
import { z } from "zod";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound, required, unprocessable } from "../../errors";
import { computeAvailability, holdsSlot, loadStoreConfig } from "../store/pickup";
import {
  applyTransition,
  lockOrder,
  recordOrderEvent,
  refundInTransaction,
  type OrderActor,
} from "./lifecycle";
import { resolveOrderAccess } from "./order-access";

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

function staffActor(actor: Actor): OrderActor {
  return { kind: "staff", userId: actor.userId, role: actor.role };
}

/** Customer cancellation (policy: until the café accepts). Paid orders are refunded in full. */
export async function cancelOrderAsCustomer(
  db: Database,
  actor: Actor | null,
  orderId: string,
  guestToken?: string | null,
  now = new Date(),
) {
  const access = await resolveOrderAccess(db, actor, orderId, guestToken);
  if (access.via === "staff") throw notFound("Order"); // staff use the staff actions instead
  return db.transaction(async (tx) => {
    const order = required(await lockOrder(tx, orderId), "order");
    if (!customerCanCancel(order.status)) throw unprocessable("cancel_not_allowed");
    const customer: OrderActor = { kind: "customer", userId: actor?.userId ?? null };
    let updated = await applyTransition(tx, order, "cancelled", customer, {
      reason: "Cancelled by customer",
      guestVerified: access.via === "guest_token",
      now,
    });
    const refund = refundRequiredOnCancel({
      paid: order.paidAt !== null,
      totalCents: order.totalCents,
      refundedCents: 0,
    });
    if (refund > 0)
      updated = await refundInTransaction(
        tx,
        updated,
        refund,
        "Cancelled by customer",
        { kind: "system" },
        { kind: "system" },
        now,
      );
    return { status: updated.status };
  });
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
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw notFound("Order");
    const staff = staffActor(actor);
    let updated = await applyTransition(tx, order, input.to, staff, {
      reason: input.reason ?? null,
      expectedVersion: input.expectedVersion,
      now,
    });
    if ((input.to === "cancelled" || input.to === "rejected") && order.paidAt) {
      // Automatic full refund: requested by this staff member, performed by the system.
      updated = await refundInTransaction(
        tx,
        updated,
        order.totalCents,
        input.reason ?? input.to,
        staff,
        { kind: "system" },
        now,
      );
    }
    return { status: updated.status, version: updated.version };
  });
}

export const staffRefundInput = z.object({
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(3).max(300),
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
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw notFound("Order");
    const staff = staffActor(actor);
    const updated = await refundInTransaction(
      tx,
      order,
      input.amountCents,
      input.reason,
      staff,
      staff,
      now,
    );
    return { status: updated.status, version: updated.version };
  });
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
