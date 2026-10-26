import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  eq,
  orders,
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
import { listAdminPromotions, savePromotion, type PromotionInput } from "./admin/promotions";
import { getProductBySlug } from "./catalog/storefront";
import { quoteCart } from "./ordering/cart-quote";
import { placeOrder } from "./ordering/place-order";
import { simulateFakePayment } from "./payments/checkout";

/*
 * Promotions administration: what managers set is exactly what checkout applies, edits never
 * touch orders already placed, and every change is audited.
 */

// Monday 2026-10-12 10:00 EDT.
const NOW = new Date("2026-10-12T14:00:00Z");

let handle: DbHandle;
let db: Database;
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
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events, loyalty_programs, outbox_messages restart identity cascade`,
  );
  await seedDemoData(db, NOW);
  const byEmail = async (local: string) =>
    (
      await db
        .select()
        .from(users)
        .where(eq(users.email, `${local}@${DEMO_EMAIL_DOMAIN}`))
    )[0]!;
  staff = { userId: (await byEmail("staff")).id, role: "staff" };
  lead = { userId: (await byEmail("lead")).id, role: "shift_lead" };
  manager = { userId: (await byEmail("manager")).id, role: "manager" };
  latte = (await getProductBySlug(db, "demo-latte"))!;
});

async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    if (e instanceof AppError) return e.reason ?? e.code;
    throw e;
  }
}

const promo = (overrides: Partial<PromotionInput> = {}): PromotionInput => ({
  code: "rentree10",
  nameFr: "Rentrée",
  nameEn: "Back to school",
  kind: "percent_off",
  value: 1000,
  scope: "order",
  targetIds: [],
  minSubtotalCents: 0,
  startsOn: "2026-10-01",
  endsOn: "2026-10-12",
  maxRedemptions: null,
  maxRedemptionsPerCustomer: null,
  stackableWithRewards: false,
  isActive: true,
  ...overrides,
});

const lines = () => [
  {
    lineId: "l1",
    productId: latte.id,
    variantId: latte.variants[1]!.id,
    optionIds: latte.groups
      .flatMap((g) => g.options)
      .filter((o) => o.nameEn === "Hot" || o.nameEn === "Whole milk")
      .map((o) => o.id),
    quantity: 2,
  },
];

async function quote(code: string, at = NOW) {
  return (await quoteCart(db, null, { lines: lines(), promoCode: code }, at)).quote.promotion;
}

async function orderWith(code: string) {
  const { quote: q } = await quoteCart(db, null, { lines: lines(), promoCode: code }, NOW);
  const placed = await placeOrder(
    db,
    null,
    {
      idempotencyKey: randomUUID(),
      lines: lines(),
      promoCode: code,
      fulfilment: { method: "pickup", when: { kind: "asap" } },
      contact: { name: "Sam", email: "sam@example.test" },
      expectedTotalCents: q.totalCents,
      locale: "fr-CA",
    },
    { provider: "fake", now: NOW },
  );
  await simulateFakePayment(db, placed.orderId, "approve", {
    locale: "fr",
    guestToken: placed.guestToken,
    userId: null,
    now: NOW,
  });
  return placed.orderId;
}

describe("promotions administration", () => {
  it("a manager's promotion applies at checkout, in capitals, through its last day", async () => {
    await savePromotion(db, manager, promo());
    // 10 % of two 2,00 $ lattes.
    expect(await quote("RENTREE10")).toMatchObject({ status: "applied", discountCents: 40 });
    expect(await quote("rentree10")).toMatchObject({ status: "applied" });
    // 23:30 in Montréal on the last day still counts; the next morning doesn't.
    expect(await quote("RENTREE10", new Date("2026-10-13T03:30:00Z"))).toMatchObject({
      status: "applied",
    });
    expect((await quote("RENTREE10", new Date("2026-10-13T12:00:00Z")))?.status).not.toBe(
      "applied",
    );
    const [listed] = (await listAdminPromotions(db, manager, NOW)).filter(
      (p) => p.code === "RENTREE10",
    );
    expect(listed).toMatchObject({
      code: "RENTREE10",
      startsOn: "2026-10-01",
      endsOn: "2026-10-12",
      state: "active",
      uses: 0,
    });
  });

  it("counts uses and discounts, and an edit never changes an order already placed", async () => {
    const { id } = await savePromotion(db, manager, promo());
    const orderId = await orderWith("RENTREE10");
    const [before] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(before!.discountCents).toBe(40);

    await savePromotion(db, manager, promo({ value: 5000, isActive: false }), id);
    const [after] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(after!.discountCents).toBe(40);
    expect((await quote("RENTREE10"))?.status).not.toBe("applied");

    const [listed] = (await listAdminPromotions(db, manager, NOW)).filter((p) => p.id === id);
    expect(listed).toMatchObject({ uses: 1, discountGivenCents: 40, state: "off" });
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(audit.map((a) => a.action).sort()).toEqual(["promotion.created", "promotion.updated"]);
    const updated = audit.find((a) => a.action === "promotion.updated")!.metadata as {
      changed: string[];
    };
    expect(updated.changed).toEqual(expect.arrayContaining(["value", "isActive"]));
  });

  it("targets products or categories that exist", async () => {
    await savePromotion(
      db,
      manager,
      promo({
        code: "LATTE",
        scope: "product",
        targetIds: [latte.id],
        kind: "amount_off",
        value: 50,
      }),
    );
    expect(await quote("LATTE")).toMatchObject({ status: "applied", discountCents: 50 });
    expect(
      await failure(
        savePromotion(db, manager, promo({ scope: "product", targetIds: [randomUUID()] })),
      ),
    ).toBe("validation_failed");
  });

  it("refuses duplicate codes, impossible values and inconsistent targets", async () => {
    await savePromotion(db, manager, promo());
    expect(await failure(savePromotion(db, manager, promo({ code: "Rentree10" })))).toBe(
      "code_taken",
    );
    const bad = (o: Partial<PromotionInput>) =>
      failure(savePromotion(db, manager, promo({ code: "OTHER", ...o })));
    expect(await bad({ value: 10_001 })).toBe("validation_failed"); // over 100 %
    expect(await bad({ scope: "order", targetIds: [latte.id] })).toBe("validation_failed");
    expect(await bad({ scope: "category", targetIds: [] })).toBe("validation_failed");
    expect(await bad({ endsOn: "2026-09-01" })).toBe("validation_failed");
    expect(await bad({ code: "no spaces" })).toBe("validation_failed");
  });

  it("is for managers and above", async () => {
    for (const actor of [staff, lead]) {
      expect(await failure(savePromotion(db, actor, promo()))).toBe("forbidden");
      expect(await failure(listAdminPromotions(db, actor))).toBe("forbidden");
    }
    expect(await failure(savePromotion(db, null, {}))).toBe("unauthenticated");
  });
});
