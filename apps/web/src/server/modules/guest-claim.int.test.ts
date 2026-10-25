import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  eq,
  loyaltyAccounts,
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
import { getProductBySlug } from "./catalog/storefront";
import { provisionAccount } from "./identity/provisioning";
import { claimGuestOrders } from "./loyalty/guest-claim";
import { currentRules, programInput, saveProgramVersion } from "./loyalty/program";
import { quoteCart } from "./ordering/cart-quote";
import { listMyOrders } from "./ordering/customer-orders";
import { transitionOrderAsStaff } from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { simulateFakePayment } from "./payments/checkout";

/*
 * Guest-order stamp claim (ACC-2, D11): paid guest orders join a new account with the same
 * verified email within the program's claim window, and earn their stamps once.
 */

// Monday 2026-10-12 10:00 EDT — the demo café is open 07:00–18:00.
const NOW = new Date("2026-10-12T14:00:00Z");
const DAY = 86_400_000;
const later = (days: number) => new Date(NOW.getTime() + days * DAY);

let handle: DbHandle;
let db: Database;
let staff: Actor;
let lead: Actor;
let owner: Actor;
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
  owner = { userId: (await byEmail("owner")).id, role: "owner" };
  latte = (await getProductBySlug(db, "demo-latte"))!;
});

/** A guest buys `quantity` large lattes with `email`, and pays. */
async function guestBuys(email: string, quantity = 1, pay = true) {
  const lines = [
    {
      lineId: "l1",
      productId: latte.id,
      variantId: latte.variants[1]!.id,
      optionIds: latte.groups
        .flatMap((g) => g.options)
        .filter((o) => o.nameEn === "Hot" || o.nameEn === "Whole milk")
        .map((o) => o.id),
      quantity,
    },
  ];
  const { quote } = await quoteCart(db, null, { lines }, NOW);
  const placed = await placeOrder(
    db,
    null,
    {
      idempotencyKey: randomUUID(),
      lines,
      fulfilment: { method: "pickup", when: { kind: "asap" } },
      contact: { name: "Sam", email },
      expectedTotalCents: quote.totalCents,
      locale: "fr-CA",
    },
    { provider: "fake", now: NOW },
  );
  if (pay)
    await simulateFakePayment(db, placed.orderId, "approve", {
      locale: "fr",
      guestToken: placed.guestToken,
      userId: null,
      now: NOW,
    });
  return placed.orderId;
}

async function signUp(email: string): Promise<Actor> {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, name: "", email, emailVerified: true });
  await provisionAccount(db, userId);
  return { userId, role: "customer" };
}

async function balance(actor: Actor) {
  const [row] = await db
    .select()
    .from(loyaltyAccounts)
    .where(eq(loyaltyAccounts.userId, actor.userId));
  return row!.stampBalance;
}

async function setRules(overrides: Record<string, unknown>) {
  const current = await currentRules(db);
  await saveProgramVersion(db, owner, {
    ...Object.fromEntries(
      Object.keys(programInput.shape).map((k) => [k, current[k as keyof typeof current]]),
    ),
    note: "test change",
    ...overrides,
  });
}

async function advance(orderId: string, ...steps: string[]) {
  for (const to of steps) {
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    await transitionOrderAsStaff(
      db,
      to === "cancelled" ? lead : staff,
      orderId,
      { to, expectedVersion: row!.version, ...(to === "cancelled" ? { reason: "Rupture" } : {}) },
      NOW,
    );
  }
}

describe("guest order stamp claim", () => {
  it("gives a new account its recent guest orders and their stamps, once", async () => {
    const orderId = await guestBuys("Sam@Example.test", 2);
    const sam = await signUp("sam@example.test");
    expect(await claimGuestOrders(db, sam.userId, "sam@example.test", later(3))).toEqual({
      orders: 1,
      stamps: 2,
    });
    expect(await balance(sam)).toBe(2);
    // The order is now in the account's history.
    expect((await listMyOrders(db, sam)).map((o) => o.id)).toContain(orderId);
    // Claiming again changes nothing.
    expect(await claimGuestOrders(db, sam.userId, "sam@example.test", later(3))).toEqual({
      orders: 0,
      stamps: 0,
    });
    expect(await balance(sam)).toBe(2);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "loyalty.guest_orders_claimed"));
    expect(audit!.metadata).toEqual({ orders: 1, stamps: 2 });
  });

  it("leaves out orders past the window, stopped or unpaid, and other people's", async () => {
    await guestBuys("sam@example.test");
    const cancelled = await guestBuys("sam@example.test");
    await advance(cancelled, "cancelled");
    await guestBuys("sam@example.test", 1, false);
    await guestBuys("someone@example.test");
    const sam = await signUp("sam@example.test");
    // 15 days later: past the default 14-day window.
    expect(await claimGuestOrders(db, sam.userId, "sam@example.test", later(15))).toEqual({
      orders: 0,
      stamps: 0,
    });
    // Within it: only the paid, still-valid order.
    expect(await claimGuestOrders(db, sam.userId, "sam@example.test", later(14))).toEqual({
      orders: 1,
      stamps: 1,
    });
    const [other] = await db
      .select()
      .from(orders)
      .where(eq(orders.guestEmail, "someone@example.test"));
    expect(other!.userId).toBeNull();
  });

  it("with stamps on completion, a claimed order earns when the café completes it", async () => {
    await setRules({ earnOn: "completed" });
    const orderId = await guestBuys("sam@example.test", 3);
    const sam = await signUp("sam@example.test");
    expect(await claimGuestOrders(db, sam.userId, "sam@example.test", later(1))).toEqual({
      orders: 1,
      stamps: 0,
    });
    await advance(orderId, "accepted", "in_preparation", "ready", "completed");
    expect(await balance(sam)).toBe(3);
  });

  it("does nothing when the owner turned claiming off", async () => {
    await setRules({ guestClaimDays: 0 });
    await guestBuys("sam@example.test");
    const sam = await signUp("sam@example.test");
    expect(await claimGuestOrders(db, sam.userId, "sam@example.test", later(1))).toEqual({
      orders: 0,
      stamps: 0,
    });
    expect(await balance(sam)).toBe(0);
  });

  it("is a program rule, versioned like the others, between 0 and 90 days", async () => {
    await setRules({ guestClaimDays: 30 });
    expect((await currentRules(db)).guestClaimDays).toBe(30);
    await expect(setRules({ guestClaimDays: 91 })).rejects.toThrow();
  });
});
