import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  and,
  auditEvents,
  eq,
  orders,
  outboxMessages,
  sql,
  users,
  type CatalogProduct,
  type Database,
  type DbHandle,
} from "@ssc/db";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "@ssc/db/seed";
import { createTestDatabase } from "@ssc/db/testing";
import type { Actor } from "../authz";
import { AppError } from "../errors";
import type { NotificationPayload, NotificationTemplate } from "../notifications/outbox";
import { renderEmail } from "../notifications/templates";
import { listDeliveryZones, saveDeliveryZone } from "./admin/delivery";
import { getProductBySlug } from "./catalog/storefront";
import { getOrderDetail } from "./ordering/customer-orders";
import { quoteCart } from "./ordering/cart-quote";
import { transitionOrderAsStaff } from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { getStaffQueue } from "./ordering/staff-queue";
import { simulateFakePayment } from "./payments/checkout";
import { exportPersonalData } from "./privacy/export";
import { RETENTION, runRetention } from "./privacy/retention";
import { getSalesReport } from "./reports/sales";
import { getFulfilmentOptions } from "./store/pickup";

/*
 * Delivery against a real database: zones set up by a manager (off until switched on, no two
 * zones serving the same postal code), delivery orders with a fee, a phone number and an
 * estimated arrival, the courier step (ready → out for delivery → delivered) with its own
 * customer notice, delivery fees in the reports, and addresses erased by the retention job.
 */

// Monday 2026-10-12 10:00 EDT — the demo café is open 07:00–18:00.
const NOW = new Date("2026-10-12T14:00:00Z");
const DAY = "2026-10-12";
const opts = { provider: "fake" as const, now: NOW };

let handle: DbHandle;
let db: Database;
let customer: Actor;
let staff: Actor;
let lead: Actor;
let manager: Actor;
let latte: CatalogProduct;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events, outbox_messages restart identity cascade`,
  );
  await seedDemoData(db, NOW);
  const byEmail = async (local: string) =>
    (
      await db
        .select()
        .from(users)
        .where(eq(users.email, `${local}@${DEMO_EMAIL_DOMAIN}`))
    )[0]!;
  customer = { userId: (await byEmail("customer")).id, role: "customer" };
  staff = { userId: (await byEmail("staff")).id, role: "staff" };
  lead = { userId: (await byEmail("lead")).id, role: "shift_lead" };
  manager = { userId: (await byEmail("manager")).id, role: "manager" };
  latte = (await getProductBySlug(db, "demo-latte"))!;
});

const zone = (patch: Record<string, unknown> = {}) => ({
  nameFr: "Mile End",
  nameEn: "Mile End",
  postalPrefixes: ["h2t", "H2V", "H2T"],
  feeCents: 499,
  minimumOrderCents: 0,
  estimatedMinutes: 25,
  isActive: true,
  ...patch,
});

const optionId = (nameEn: string) =>
  latte.groups.flatMap((g) => g.options).find((o) => o.nameEn === nameEn)!.id;
const lines = () => [
  {
    lineId: randomUUID(),
    productId: latte.id,
    variantId: latte.variants[1]!.id,
    optionIds: [optionId("Hot"), optionId("Whole milk")],
    quantity: 2,
  },
];
const address = { line1: "5555 av. du Parc", line2: "App. 3", city: "Montréal" };

async function deliveryInput(postalCode = "H2T 1S6", phone: string | null = "514-555-0199") {
  const cart = lines();
  const quote = await quoteCart(
    db,
    customer,
    { lines: cart, fulfilment: { method: "delivery", postalCode } },
    NOW,
  );
  return {
    idempotencyKey: randomUUID(),
    lines: cart,
    fulfilment: {
      method: "delivery",
      address: { ...address, postalCode, instructions: "Sonnez deux fois" },
    },
    contact: { name: "Alex", ...(phone ? { phone } : {}) },
    expectedTotalCents: quote.quote.totalCents,
    locale: "fr-CA",
  };
}

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    if (e instanceof AppError) return e.reason ?? e.code;
    throw e;
  }
}

async function paidDeliveryOrder() {
  const placed = await placeOrder(db, customer, await deliveryInput(), opts);
  await simulateFakePayment(db, placed.orderId, "approve", {
    locale: "fr",
    guestToken: null,
    userId: customer.userId,
    now: NOW,
  });
  return placed.orderId;
}

async function moveTo(orderId: string, to: string, by: Actor = staff, reason?: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  return transitionOrderAsStaff(
    db,
    by,
    orderId,
    { to, reason, expectedVersion: order!.version },
    NOW,
  );
}

const messages = (orderId: string, template: NotificationTemplate) =>
  db
    .select()
    .from(outboxMessages)
    .where(and(eq(outboxMessages.orderId, orderId), eq(outboxMessages.template, template)));

describe("delivery zones (administration)", () => {
  it("delivery is offered at checkout only while a zone is on", async () => {
    expect((await getFulfilmentOptions(db, NOW)).deliveryOffered).toBe(false);
    const { id } = await saveDeliveryZone(db, manager, zone({ isActive: false }));
    expect((await getFulfilmentOptions(db, NOW)).deliveryOffered).toBe(false);
    await saveDeliveryZone(db, manager, zone(), id);
    expect((await getFulfilmentOptions(db, NOW)).deliveryOffered).toBe(true);

    // Prefixes are stored in capitals, once each; the change is audited.
    const [listed] = (await listDeliveryZones(db, manager)).filter((z) => z.id === id);
    expect(listed).toMatchObject({ postalPrefixes: ["H2T", "H2V"], isActive: true, orders: 0 });
    const audits = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, id));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "delivery_zone.created",
      "delivery_zone.updated",
    ]);
  });

  it("two zones that are on can't serve the same postal code", async () => {
    await saveDeliveryZone(db, manager, zone());
    expect(
      await failure(
        saveDeliveryZone(db, manager, zone({ nameFr: "Autre", postalPrefixes: ["H2V"] })),
      ),
    ).toBe("prefix_taken");
    // Switched off, it can be prepared ahead.
    expect(
      await failure(
        saveDeliveryZone(
          db,
          manager,
          zone({ nameFr: "Autre", postalPrefixes: ["H2V"], isActive: false }),
        ),
      ),
    ).toBeNull();
  });

  it("only managers set zones up, and invalid prefixes or fees are refused", async () => {
    expect(await failure(saveDeliveryZone(db, lead, zone()))).toBe("forbidden");
    expect(await failure(listDeliveryZones(db, staff))).toBe("forbidden");
    for (const bad of [
      { postalPrefixes: ["H2"] },
      { postalPrefixes: ["Z2T"] }, // no Canadian postal code starts with Z
      { postalPrefixes: [] },
      { feeCents: -1 },
      { estimatedMinutes: 0 },
    ])
      expect(await failure(saveDeliveryZone(db, manager, zone(bad)))).toBe("validation_failed");
  });
});

describe("delivery orders", () => {
  beforeEach(async () => {
    await saveDeliveryZone(db, manager, zone());
  });

  it("charge the zone's fee, need a phone number and carry an estimated arrival", async () => {
    expect(
      await failure(placeOrder(db, customer, await deliveryInput("H2T 1S6", null), opts)),
    ).toBe("validation_failed");
    expect(await failure(placeOrder(db, customer, await deliveryInput("H3A 0G4"), opts))).toBe(
      "cart_invalid",
    ); // outside every zone

    const placed = await placeOrder(db, customer, await deliveryInput(), opts);
    const [order] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(order).toMatchObject({
      fulfilment: "delivery",
      deliveryFeeCents: 499,
      guestPhone: "514-555-0199",
    });
    expect(order!.deliveryAddress).toMatchObject({ line1: address.line1, postalCode: "H2T 1S6" });
    const snapshot = order!.pricingSnapshot as { readyAt: string; deliverBy: string };
    expect(new Date(snapshot.deliverBy).getTime() - new Date(snapshot.readyAt).getTime()).toBe(
      25 * 60_000,
    );
    const detail = await getOrderDetail(db, customer, placed.orderId, null, NOW);
    expect(detail.deliverBy?.toISOString()).toBe(snapshot.deliverBy);
  });

  it("go to the courier before they are delivered, with an 'on its way' notice", async () => {
    const orderId = await paidDeliveryOrder();
    // The confirmation gives the delivery time, not a pickup time.
    const [confirmed] = await messages(orderId, "order_confirmed");
    expect((confirmed!.payload as unknown as NotificationPayload).deliverBy).toBeTruthy();
    const confirmation = renderEmail(
      {
        id: confirmed!.id,
        channel: "email",
        recipient: confirmed!.recipient,
        locale: "fr",
        template: "order_confirmed",
        payload: confirmed!.payload as unknown as NotificationPayload,
      },
      "https://cafe.test",
    );
    expect(confirmation.text).toContain("Livraison prévue vers");

    for (const to of ["accepted", "in_preparation", "ready"]) await moveTo(orderId, to);
    // Waiting for the courier is not "ready at the counter": no such notice.
    expect(await messages(orderId, "order_ready")).toHaveLength(0);

    // The queue shows where it goes and how to reach the customer; the only step is the courier.
    const queued = (await getStaffQueue(db, staff, NOW)).orders.find((o) => o.id === orderId)!;
    expect(queued.delivery).toMatchObject({
      line1: address.line1,
      line2: address.line2,
      postalCode: "H2T 1S6",
      instructions: "Sonnez deux fois",
      phone: "514-555-0199",
    });
    expect(queued.actions).toEqual(["out_for_delivery"]);
    expect(await failure(moveTo(orderId, "completed"))).toBe("conflict");

    await moveTo(orderId, "out_for_delivery");
    const [onTheWay] = await messages(orderId, "order_on_the_way");
    expect(onTheWay).toMatchObject({ channel: "email" });
    const email = renderEmail(
      {
        id: onTheWay!.id,
        channel: "email",
        recipient: onTheWay!.recipient,
        locale: "fr",
        template: "order_on_the_way",
        payload: onTheWay!.payload as unknown as NotificationPayload,
      },
      "https://cafe.test",
    );
    expect(email.subject).toMatch(/en route/);
    const [left] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(left!.outForDeliveryAt).toEqual(NOW);
    // Still on the queue until it is delivered.
    expect((await getStaffQueue(db, staff, NOW)).orders.map((o) => o.id)).toContain(orderId);

    await moveTo(orderId, "completed");
    const [done] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(done!.status).toBe("completed");
  });

  it("a failed delivery is cancelled by a shift lead with a reason, and refunded", async () => {
    const orderId = await paidDeliveryOrder();
    for (const to of ["accepted", "in_preparation", "ready", "out_for_delivery"])
      await moveTo(orderId, to);
    expect(await failure(moveTo(orderId, "cancelled", staff, "Personne"))).toBe("forbidden");
    await moveTo(orderId, "cancelled", lead, "Personne à l’adresse");
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    // Cancelling a paid order refunds it in full (settled at once by the payment simulator).
    expect(order).toMatchObject({
      status: "refunded",
      cancellationReason: "Personne à l’adresse",
    });
    expect(await messages(orderId, "order_cancelled")).toHaveLength(1);
  });

  it("delivery fees show in the sales report", async () => {
    const report = () => getSalesReport(db, manager, { from: DAY, to: DAY, includeDemo: true });
    const before = await report();
    const orderId = await paidDeliveryOrder();
    const after = await report();
    expect(after.sales.deliveryFeeCents - before.sales.deliveryFeeCents).toBe(499);
    expect(after.sales.deliveryOrders - before.sales.deliveryOrders).toBe(1);
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    // Goods include the fee; the breakdown still adds up.
    expect(after.sales.goodsCents - before.sales.goodsCents).toBe(
      order!.subtotalCents - order!.discountCents - order!.rewardDiscountCents + 499,
    );
  });

  it("the address is in the customer's data export, then erased after the retention period", async () => {
    const orderId = await paidDeliveryOrder();
    for (const to of ["accepted", "in_preparation", "ready", "out_for_delivery", "completed"])
      await moveTo(orderId, to);
    const exported = JSON.stringify(await exportPersonalData(db, customer));
    expect(exported).toContain(address.line1);

    const day = 86_400_000;
    const early = await runRetention(
      db,
      new Date(NOW.getTime() + (RETENTION.deliveryAddressDays - 1) * day),
    );
    expect(early.deliveryAddressesErased).toBe(0);
    const later = await runRetention(
      db,
      new Date(NOW.getTime() + (RETENTION.deliveryAddressDays + 1) * day),
    );
    expect(later.deliveryAddressesErased).toBe(1);
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    // The order stays (tax records), still marked as a delivery, without the address.
    expect(order).toMatchObject({
      fulfilment: "delivery",
      deliveryAddress: { anonymized: true },
      deliveryFeeCents: 499,
    });
    const detail = await getOrderDetail(db, customer, orderId, null, NOW);
    expect(detail.deliveryAddress).toBeNull();
    // Running again changes nothing.
    expect(
      (await runRetention(db, new Date(NOW.getTime() + (RETENTION.deliveryAddressDays + 2) * day)))
        .deliveryAddressesErased,
    ).toBe(0);
  });
});
