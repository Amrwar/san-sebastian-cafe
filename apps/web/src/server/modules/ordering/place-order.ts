import { createHash, randomBytes } from "node:crypto";
import {
  and,
  count,
  eq,
  inArray,
  not,
  orderCounters,
  orderItems,
  orderStatusEvents,
  orders,
  sql,
  type Database,
  type Tx,
} from "@ssc/db";
import {
  checkPickupRequest,
  LOCALES,
  localParts,
  MIN_CARD_CHARGE_CENTS,
  optionPriceForVariant,
  type OrderStatus,
  type PaymentProviderName,
} from "@ssc/domain";
import { z } from "zod";
import type { Actor } from "../../authz";
import { AppError, fromZodError, required, unprocessable } from "../../errors";
import { reserveReward } from "../loyalty/ledger";
import { computeAvailability, holdsSlot, loadStoreConfig } from "../store/pickup";
import { cartLineInput, priceCart } from "./cart-quote";
import { applyTransition, expireStaleOrders, lockOrder, recordOrderEvent } from "./lifecycle";

const tipInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("percent"), basisPoints: z.number().int() }),
  z.object({ kind: z.literal("amount"), cents: z.number().int() }),
]);

export const placeOrderInput = z.object({
  /** Client-generated per checkout attempt; retries with the same key return the same order. */
  idempotencyKey: z.uuid(),
  lines: z.array(cartLineInput).min(1).max(30),
  promoCode: z.string().trim().max(32).optional(),
  useReward: z.boolean().optional(),
  rewardLineId: z.string().max(64).optional(),
  fulfilment: z.discriminatedUnion("method", [
    z.object({
      method: z.literal("pickup"),
      when: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("asap") }),
        z.object({ kind: z.literal("scheduled"), at: z.iso.datetime() }),
      ]),
    }),
    z.object({
      method: z.literal("delivery"),
      address: z.object({
        line1: z.string().trim().min(3).max(120),
        line2: z.string().trim().max(120).optional(),
        city: z.string().trim().min(2).max(80),
        postalCode: z.string().trim().min(6).max(7),
        instructions: z.string().trim().max(200).optional(),
      }),
    }),
  ]),
  tip: tipInput.default({ kind: "none" }),
  contact: z.object({
    /** Name called out at the counter. */
    name: z.string().trim().min(1).max(80),
    /** Required for guests (receipt and tracking link). */
    email: z.email().max(254).optional(),
    phone: z.string().trim().max(20).optional(),
  }),
  notes: z.string().trim().max(200).optional(),
  /** The total the customer was shown. If prices changed meanwhile, the order is refused (422). */
  expectedTotalCents: z.number().int().nonnegative(),
  locale: z.enum(LOCALES),
});
export type PlaceOrderInput = z.infer<typeof placeOrderInput>;

export interface PlacedOrder {
  orderId: string;
  number: string;
  /** awaiting_payment, or paid/accepted for an order fully covered by discounts (nothing to pay). */
  status: OrderStatus;
  totalCents: number;
  expiresAt: string;
  /** Returned once to guests; required to view and pay for the order. Only its hash is stored. */
  guestToken: string | null;
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function requestHash(input: PlaceOrderInput, actor: Actor | null): string {
  const rest: Omit<PlaceOrderInput, "idempotencyKey"> & { idempotencyKey?: string } = { ...input };
  delete rest.idempotencyKey;
  return createHash("sha256")
    .update(JSON.stringify({ actor: actor?.userId ?? null, ...rest }))
    .digest("hex");
}

/** Short, unique, human-friendly number per local day: "MMDD-NNN" (e.g. "1011-007"). */
async function nextOrderNumber(tx: Tx, now: Date): Promise<string> {
  const p = localParts(now);
  const localDate = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const [row] = await tx
    .insert(orderCounters)
    .values({ localDate, lastValue: 1 })
    .onConflictDoUpdate({
      target: orderCounters.localDate,
      set: { lastValue: sql`${orderCounters.lastValue} + 1` },
    })
    .returning({ value: orderCounters.lastValue });
  return `${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}-${String(required(row, "order counter").value).padStart(3, "0")}`;
}

/** Statuses that count against promotion usage limits. */
const PROMOTION_COUNTING = not(
  inArray(orders.status, ["cancelled", "expired", "rejected", "refunded"]),
);

async function findReplay(
  db: Database | Tx,
  input: PlaceOrderInput,
  actor: Actor | null,
): Promise<PlacedOrder | null> {
  const existing = await db.query.orders.findFirst({
    where: eq(orders.idempotencyKey, input.idempotencyKey),
  });
  if (!existing) return null;
  const snapshot = existing.pricingSnapshot as { requestHash?: string };
  if (snapshot.requestHash !== requestHash(input, actor)) {
    throw new AppError(
      "conflict",
      "Idempotency key reused with a different request",
      [],
      "idempotency_key_reused",
    );
  }
  return {
    orderId: existing.id,
    number: existing.number,
    status: existing.status,
    totalCents: existing.totalCents,
    expiresAt: (existing.expiresAt ?? existing.placedAt).toISOString(),
    guestToken: null, // never re-issued; the original response carried it
    replayed: true,
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const e = current as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (
      e.code === "23505" &&
      (e.constraint_name ?? e.constraint ?? "").toLowerCase().includes(constraint)
    )
      return true;
    current = e.cause;
  }
  return false;
}

/**
 * Creates an order in `awaiting_payment` from ids only. Everything that determines money or
 * capacity is recomputed here, inside one transaction:
 *  - pickup time re-validated against live hours, cutoff, pause and capacity (slot locked);
 *  - prices, taxes, promotion and reward re-computed with menu availability at the pickup time;
 *  - `expectedTotalCents` must equal the server total (else 422 price_changed);
 *  - promotion usage limits and reward ownership enforced under locks;
 *  - purchase-time snapshots of every item, a unique order number and the event history written.
 */
export async function placeOrder(
  db: Database,
  actor: Actor | null,
  rawInput: unknown,
  options: { provider: PaymentProviderName | "none"; now?: Date },
): Promise<PlacedOrder> {
  const parsed = placeOrderInput.safeParse(rawInput);
  if (!parsed.success) throw fromZodError(parsed.error);
  const input = parsed.data;
  if (options.provider === "none")
    throw unprocessable("payments_unavailable", "Online payment is not available yet");
  if (!actor && !input.contact.email) {
    throw new AppError("validation_failed", "Guests must provide an email", [
      { path: "contact.email", code: "required" },
    ]);
  }
  const now = options.now ?? new Date();

  const replay = await findReplay(db, input, actor);
  if (replay) return replay;

  try {
    return await db.transaction(async (tx) => {
      await expireStaleOrders(tx, now);
      const config = await loadStoreConfig(tx);
      const availability = await computeAvailability(tx, config, now);

      // 1. When will this order be prepared?
      let readyAt: Date;
      let slotStart: Date | null = null;
      let scheduledFor: Date | null = null;
      if (input.fulfilment.method === "pickup") {
        const when = input.fulfilment.when;
        const pickup = checkPickupRequest(
          availability,
          when.kind === "asap" ? { kind: "asap" } : { kind: "scheduled", at: new Date(when.at) },
          config.settings.slotMinutes,
        );
        if (!pickup.ok) throw unprocessable(pickup.error);
        ({ readyAt, slotStart, scheduledFor } = pickup);

        // 2. Capacity: serialize orders for this slot, then re-count under the lock.
        const capacity = config.settings.maxOrdersPerSlot;
        if (capacity) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`slot:${slotStart.toISOString()}`}))`,
          );
          const [held] = await tx
            .select({ n: count() })
            .from(orders)
            .where(and(eq(orders.slotStart, slotStart), holdsSlot(now)));
          if ((held?.n ?? 0) >= capacity) throw unprocessable("slot_full");
        }
      } else {
        if (availability.reason || !availability.asapReadyAt)
          throw unprocessable("ordering_unavailable");
        readyAt = new Date(availability.asapReadyAt);
      }

      // 3. Price on the server, with availability at the preparation time.
      const priced = await priceCart(
        tx,
        actor,
        {
          lines: input.lines,
          promoCode: input.promoCode,
          useReward: input.useReward,
          rewardLineId: input.rewardLineId,
          fulfilment:
            input.fulfilment.method === "pickup"
              ? { method: "pickup" }
              : { method: "delivery", postalCode: input.fulfilment.address.postalCode },
          tip: input.tip,
        },
        { now, availableAt: readyAt },
      );
      const { quote } = priced.result;
      if (!quote.canCheckout)
        throw unprocessable("cart_invalid", "The cart has items that can't be ordered");
      if (quote.totalCents !== input.expectedTotalCents) throw unprocessable("price_changed");
      if (quote.totalCents > 0 && quote.totalCents < MIN_CARD_CHARGE_CENTS)
        throw unprocessable("below_minimum_charge");
      if (input.useReward && quote.reward?.status !== "applied")
        throw unprocessable("reward_unavailable");

      // 4. Promotion usage limits (serialized per promotion).
      const promotion = quote.promotion?.status === "applied" ? priced.promotion : null;
      if (promotion) {
        const limits = await tx.query.promotions.findFirst({
          where: (p, { eq: e }) => e(p.id, promotion.id),
        });
        if (limits?.maxRedemptions || limits?.maxRedemptionsPerCustomer) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`promotion:${promotion.id}`}))`,
          );
          const [total] = await tx
            .select({ n: count() })
            .from(orders)
            .where(and(eq(orders.promotionId, promotion.id), PROMOTION_COUNTING));
          if (limits.maxRedemptions && (total?.n ?? 0) >= limits.maxRedemptions)
            throw unprocessable("promotion_exhausted");
          if (limits.maxRedemptionsPerCustomer) {
            const [mine] = await tx
              .select({ n: count() })
              .from(orders)
              .where(
                and(
                  eq(orders.promotionId, promotion.id),
                  PROMOTION_COUNTING,
                  actor
                    ? eq(orders.userId, actor.userId)
                    : eq(orders.guestEmail, input.contact.email ?? ""),
                ),
              );
            if ((mine?.n ?? 0) >= limits.maxRedemptionsPerCustomer)
              throw unprocessable("promotion_limit_reached");
          }
        }
      }

      // 5. Order + purchase-time snapshots.
      const guestToken = actor ? null : randomBytes(24).toString("base64url");
      const number = await nextOrderNumber(tx, now);
      const expiresAt = new Date(now.getTime() + config.settings.unpaidTtlMinutes * 60_000);
      const isDemo = [...priced.catalog.values()].some((p) => p.isDemo);
      const address = input.fulfilment.method === "delivery" ? input.fulfilment.address : null;
      const [inserted] = await tx
        .insert(orders)
        .values({
          number,
          userId: actor?.userId ?? null,
          guestName: input.contact.name,
          guestEmail: actor ? null : (input.contact.email ?? null),
          guestPhone: input.contact.phone ?? null,
          guestAccessTokenHash: guestToken ? hashToken(guestToken) : null,
          status: "awaiting_payment",
          fulfilment: input.fulfilment.method,
          deliveryZoneId: address ? priced.deliveryZoneId : null,
          deliveryAddress: address,
          scheduledFor,
          slotStart,
          expiresAt,
          locale: input.locale,
          notes: input.notes || null,
          promotionId: promotion?.id ?? null,
          subtotalCents: quote.subtotalCents,
          discountCents: quote.discountCents,
          rewardDiscountCents: quote.rewardDiscountCents,
          deliveryFeeCents: quote.deliveryFeeCents,
          gstCents: quote.gstCents,
          qstCents: quote.qstCents,
          tipCents: quote.tipCents,
          totalCents: quote.totalCents,
          pricingSnapshot: {
            quote,
            requestHash: requestHash(input, actor),
            readyAt: readyAt.toISOString(),
            rewardedOrderItemId: null,
          },
          idempotencyKey: input.idempotencyKey,
          placedAt: now,
          isDemo,
        })
        .returning();
      const order = required(inserted, "order");

      const itemIdByLine = new Map<string, string>();
      for (const line of quote.lines) {
        const product = required(priced.catalog.get(line.productId), "product");
        const variant = required(
          product.variants.find((v) => v.id === line.variantId),
          "variant",
        );
        const note = input.lines.find((l) => l.lineId === line.lineId)?.notes;
        const [item] = await tx
          .insert(orderItems)
          .values({
            orderId: order.id,
            productId: product.id,
            variantId: variant.id,
            productNameFr: product.nameFr,
            productNameEn: product.nameEn,
            variantNameFr: variant.nameFr,
            variantNameEn: variant.nameEn,
            modifiers: product.groups.flatMap((g) =>
              g.options
                .filter((o) => line.optionIds.includes(o.id))
                .map((o) => ({
                  optionId: o.id,
                  groupNameFr: g.nameFr,
                  groupNameEn: g.nameEn,
                  nameFr: o.nameFr,
                  nameEn: o.nameEn,
                  priceDeltaCents: optionPriceForVariant(variant, o),
                })),
            ),
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            lineTotalCents: line.lineTotalCents,
            discountCents: line.discountCents,
            rewardDiscountCents: line.rewardDiscountCents,
            taxCategory: product.taxCategory,
            isDrink: product.isDrink,
            loyaltyQualifying: product.loyaltyQualifying,
            notes: note || null,
          })
          .returning({ id: orderItems.id });
        itemIdByLine.set(line.lineId, required(item, "order item").id);
      }

      // 6. Reserve the free-drink reward (released if the order expires or is cancelled).
      if (quote.reward?.status === "applied" && actor && priced.reward) {
        const itemId = required(itemIdByLine.get(quote.reward.lineId ?? ""), "rewarded item");
        const reserved = await reserveReward(
          tx,
          priced.reward.id,
          actor.userId,
          order.id,
          itemId,
          quote.reward.discountCents,
          now,
        );
        if (!reserved) throw unprocessable("reward_unavailable");
        await tx
          .update(orders)
          .set({
            pricingSnapshot: { ...(order.pricingSnapshot as object), rewardedOrderItemId: itemId },
          })
          .where(eq(orders.id, order.id));
      }

      const customer = { kind: "customer" as const, userId: actor?.userId ?? null };
      await recordOrderEvent(tx, order.id, "created", customer, {
        totalCents: quote.totalCents,
        items: quote.lines.reduce((n, l) => n + l.quantity, 0),
        fulfilment: input.fulfilment.method,
        scheduledFor: scheduledFor?.toISOString() ?? null,
      });
      await tx.insert(orderStatusEvents).values({
        orderId: order.id,
        fromStatus: null,
        toStatus: "awaiting_payment",
        actorKind: "customer",
        actorUserId: actor?.userId ?? null,
        createdAt: now,
      });

      // Fully covered by discounts (e.g. a free drink): there is nothing to pay.
      let status: OrderStatus = "awaiting_payment";
      if (quote.totalCents === 0) {
        const system = { kind: "system" as const };
        await recordOrderEvent(tx, order.id, "payment_recorded", system, {
          amountCents: 0,
          noPaymentRequired: true,
        });
        let updated = await applyTransition(
          tx,
          required(await lockOrder(tx, order.id), "order"),
          "paid",
          system,
          { now },
        );
        if (config.settings.autoAccept)
          updated = await applyTransition(tx, updated, "accepted", system, { now });
        status = updated.status;
      }

      return {
        orderId: order.id,
        number,
        status,
        totalCents: quote.totalCents,
        expiresAt: expiresAt.toISOString(),
        guestToken,
        replayed: false,
      };
    });
  } catch (error) {
    // A concurrent request with the same key won the race: return its order instead.
    if (isUniqueViolation(error, "idempotency")) {
      const winner = await findReplay(db, input, actor);
      if (winner) return winner;
    }
    throw error;
  }
}
