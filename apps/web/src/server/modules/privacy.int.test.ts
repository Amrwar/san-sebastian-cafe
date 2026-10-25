import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  confidentialityIncidents,
  eq,
  loyaltyAccounts,
  orderItems,
  orders,
  paymentEvents,
  privacyRequests,
  refunds,
  sessions,
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
import { getProductBySlug } from "./catalog/storefront";
import { addFavorite } from "./customer/favorites";
import { updateAccountSettings } from "./identity/account-settings";
import { provisionAccount } from "./identity/provisioning";
import { adjustLoyalty } from "./loyalty/staff";
import { quoteCart } from "./ordering/cart-quote";
import { transitionOrderAsStaff } from "./ordering/manage-order";
import { placeOrder } from "./ordering/place-order";
import { simulateFakePayment } from "./payments/checkout";
import { ANONYMIZED_EMAIL, deleteOwnAccount } from "./privacy/deletion";
import { EXPORT_FORMAT, exportPersonalData } from "./privacy/export";
import { listIncidents, saveIncident } from "./privacy/incidents";
import { getPrivacyOfficer, savePrivacyOfficer } from "./privacy/officer";
import { closePrivacyRequest, createPrivacyRequest, listPrivacyRequests } from "./privacy/requests";
import { RETENTION, runRetention } from "./privacy/retention";
import { getSalesReport } from "./reports/sales";

/*
 * Privacy (Law 25): a customer's copy of their data, account deletion that keeps the books intact,
 * privacy requests, the incident register and retention.
 */

// Monday 2026-10-12 10:00 EDT — the demo café is open 07:00–18:00.
const NOW = new Date("2026-10-12T14:00:00Z");
const DAY = 86_400_000;

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
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events, loyalty_programs, privacy_requests, confidentiality_incidents restart identity cascade`,
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

async function newCustomer(email = `${randomUUID()}@example.test`) {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, name: "Robin Tremblay", email });
  await provisionAccount(db, userId);
  return { actor: { userId, role: "customer" } as Actor, email };
}

const latteLine = () => ({
  lineId: "l1",
  productId: latte.id,
  variantId: latte.variants[1]!.id,
  optionIds: latte.groups
    .flatMap((g) => g.options)
    .filter((o) => o.nameEn === "Hot" || o.nameEn === "Whole milk")
    .map((o) => o.id),
  quantity: 1,
});

/** Places (and pays) an order, signed in or as a guest with `email`. */
async function order(
  actor: Actor | null,
  { email, notes, pay = true }: { email?: string; notes?: string; pay?: boolean } = {},
) {
  const lines = [{ ...latteLine(), ...(notes ? { notes } : {}) }];
  const { quote } = await quoteCart(db, actor, { lines }, NOW);
  const placed = await placeOrder(
    db,
    actor,
    {
      idempotencyKey: randomUUID(),
      lines,
      notes,
      fulfilment: { method: "pickup", when: { kind: "asap" } },
      contact: {
        name: "Robin",
        email: actor ? undefined : email,
        phone: actor ? undefined : "514-555-0199",
      },
      expectedTotalCents: quote.totalCents,
      locale: "fr-CA",
    },
    { provider: "fake", now: NOW },
  );
  if (pay)
    await simulateFakePayment(db, placed.orderId, "approve", {
      locale: "fr",
      guestToken: placed.guestToken,
      userId: actor?.userId ?? null,
      now: NOW,
    });
  return placed.orderId;
}

async function complete(orderId: string) {
  const flow = ["accepted", "in_preparation", "ready", "completed"];
  const row = async () => (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
  for (const to of flow.slice(flow.indexOf((await row()).status) + 1))
    await transitionOrderAsStaff(
      db,
      staff,
      orderId,
      { to, expectedVersion: (await row()).version },
      NOW,
    );
}

const orderRow = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0];

describe("copy of personal data", () => {
  it("includes the account, its orders (guest ones too), loyalty and consents, and nobody else's", async () => {
    const { actor, email } = await newCustomer("Robin@Example.test");
    await updateAccountSettings(db, actor, { marketingEmail: true });
    const own = await order(actor, { notes: "Extra chaud" });
    const asGuest = await order(null, { email: "robin@example.test" });
    const someoneElse = await order(null, { email: "other@example.test" });
    await adjustLoyalty(
      db,
      lead,
      actor.userId,
      { action: "stamps", stamps: 2, reason: "Carte papier", idempotencyKey: randomUUID() },
      NOW,
    );
    await addFavorite(db, actor, {
      productId: latte.id,
      variantId: latte.variants[1]!.id,
      optionIds: latteLine().optionIds,
    });
    await db.insert(sessions).values({
      id: randomUUID(),
      token: "secret-session-token",
      userId: actor.userId,
      expiresAt: new Date(NOW.getTime() + DAY),
      ipAddress: "203.0.113.7",
      userAgent: "Test browser",
    });
    await db.update(orders).set({ staffNotes: "Client difficile" }).where(eq(orders.id, own));

    const data = await exportPersonalData(db, actor, NOW);
    expect(data.format).toBe(EXPORT_FORMAT);
    expect(data.account).toMatchObject({ email, name: "Robin Tremblay", role: "customer" });
    const numbers = async (...ids: string[]) =>
      Promise.all(ids.map(async (id) => (await orderRow(id))!.number));
    expect(data.orders.map((o) => o.number).sort()).toEqual((await numbers(own, asGuest)).sort());
    expect(data.orders.map((o) => o.number)).not.toContain((await numbers(someoneElse))[0]);
    const guest = data.orders.find((o) => o.placedAs === "guest");
    expect(guest?.contact).toMatchObject({ email: "robin@example.test", phone: "514-555-0199" });
    const mine = data.orders.find((o) => o.placedAs === "account");
    expect(mine?.notes).toBe("Extra chaud");
    expect(mine?.items[0]).toMatchObject({ quantity: 1, unitPriceCents: 200 });
    expect(data.payments).toHaveLength(2);
    expect(data.loyalty?.history.map((h) => h.kind)).toContain("adjust");
    expect(data.favorites).toHaveLength(1);
    expect(data.communications).toContainEqual(
      expect.objectContaining({ topic: "marketing", enabled: true }),
    );
    expect(data.consentHistory.map((c) => c.action)).toContain("consent.marketing_email.granted");
    expect(data.signIns).toEqual([
      expect.objectContaining({ ipAddress: "203.0.113.7", userAgent: "Test browser" }),
    ]);
    const text = JSON.stringify(data);
    expect(text).not.toContain("secret-session-token");
    expect(text).not.toContain("Client difficile");

    // The copy is logged as a completed request, and audited.
    const [request] = await db.select().from(privacyRequests);
    expect(request).toMatchObject({
      kind: "export",
      channel: "self_service",
      status: "completed",
      subjectUserId: actor.userId,
    });
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "privacy.data_exported"));
    expect(audit).toMatchObject({ actorUserId: actor.userId });
  });

  it("requires a signed-in account", async () => {
    expect(await failure(exportPersonalData(db, null))).toBe("unauthenticated");
  });
});

describe("account deletion", () => {
  it("deletes the account and its data, and keeps its orders for the books, anonymized", async () => {
    const { actor, email } = await newCustomer();
    const own = await order(actor, { notes: "Pour Robin" });
    const asGuest = await order(null, { email });
    const other = await order(null, { email: "other@example.test" });
    for (const id of [own, asGuest, other]) await complete(id);
    await adjustLoyalty(
      db,
      lead,
      actor.userId,
      { action: "stamps", stamps: 5, reason: "Carte papier", idempotencyKey: randomUUID() },
      NOW,
    );
    // A free drink used on an order: the redemption points to the card being deleted.
    const freeDrink = await (async () => {
      const lines = [latteLine()];
      const { quote } = await quoteCart(db, actor, { lines, useReward: true }, NOW);
      const placed = await placeOrder(
        db,
        actor,
        {
          idempotencyKey: randomUUID(),
          lines,
          useReward: true,
          fulfilment: { method: "pickup", when: { kind: "asap" } },
          contact: { name: "Robin" },
          expectedTotalCents: quote.totalCents,
          locale: "fr-CA",
        },
        { provider: "fake", now: NOW },
      );
      if (placed.status === "awaiting_payment")
        await simulateFakePayment(db, placed.orderId, "approve", {
          locale: "fr",
          guestToken: null,
          userId: actor.userId,
          now: NOW,
        });
      return placed.orderId;
    })();
    await complete(freeDrink);
    const report = () =>
      getSalesReport(db, manager, { from: "2026-10-12", to: "2026-10-12", includeDemo: true });
    const before = await report();

    expect(await deleteOwnAccount(db, actor, { confirmEmail: email.toUpperCase() }, NOW)).toEqual({
      ordersAnonymized: 3,
    });

    expect(await db.select().from(users).where(eq(users.id, actor.userId))).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.userId, actor.userId))).toEqual([]);
    expect(
      await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.userId, actor.userId)),
    ).toEqual([]);
    for (const id of [own, asGuest, freeDrink]) {
      expect(await orderRow(id)).toMatchObject({
        userId: null,
        guestEmail: ANONYMIZED_EMAIL,
        guestName: null,
        guestPhone: null,
        notes: null,
      });
    }
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, own));
    expect(items.every((i) => i.notes === null)).toBe(true);
    // Someone else's order is untouched, and the books add up exactly as before.
    expect(await orderRow(other)).toMatchObject({ guestEmail: "other@example.test" });
    const after = await report();
    expect(after.sales).toEqual(before.sales);
    expect(after.reconciliation.mismatches).toEqual([]);

    const [request] = await db
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.kind, "deletion"));
    expect(request).toMatchObject({ status: "completed", subjectUserId: null });
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "privacy.account_deleted"));
    expect(audit).toMatchObject({ actorUserId: null });
    expect(audit!.metadata).toEqual({ ordersAnonymized: 3 });
    expect(JSON.stringify(audit)).not.toContain(email);
  });

  it("refuses a mismatched email, staff accounts, orders in progress and pending refunds", async () => {
    const { actor, email } = await newCustomer();
    expect(await failure(deleteOwnAccount(db, actor, { confirmEmail: "nope@example.test" }))).toBe(
      "validation_failed",
    );
    expect(await failure(deleteOwnAccount(db, null, { confirmEmail: email }))).toBe(
      "unauthenticated",
    );
    expect(await failure(deleteOwnAccount(db, staff, { confirmEmail: "x@y.z" }))).toBe(
      "staff_account",
    );
    const busy = await order(actor);
    expect(await failure(deleteOwnAccount(db, actor, { confirmEmail: email }))).toBe(
      "orders_in_progress",
    );
    await complete(busy);
    await db.insert(refunds).values({
      orderId: busy,
      amountCents: 50,
      reason: "Test",
      status: "pending",
    });
    expect(await failure(deleteOwnAccount(db, actor, { confirmEmail: email }))).toBe(
      "refund_pending",
    );
    expect(await db.select().from(users).where(eq(users.id, actor.userId))).toHaveLength(1);
  });
});

describe("privacy requests", () => {
  it("logs requests received outside the app, due in 30 days, and closes them", async () => {
    const { actor, email } = await newCustomer();
    const { id } = await createPrivacyRequest(
      db,
      manager,
      { kind: "access", channel: "email", contact: email, receivedOn: "2026-09-01" },
      NOW,
    );
    await createPrivacyRequest(
      db,
      manager,
      { kind: "rectification", channel: "phone", contact: "514-555-0100" },
      NOW,
    );
    const list = await listPrivacyRequests(db, manager, NOW);
    expect(list).toHaveLength(2);
    // The overdue request comes first; the one from an account's email is linked to it.
    expect(list[0]).toMatchObject({ id, hasAccount: true, overdue: true, status: "open" });
    expect(list[0]!.dueAt.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(list[1]).toMatchObject({ hasAccount: false, overdue: false });
    const [row] = await db.select().from(privacyRequests).where(eq(privacyRequests.id, id));
    expect(row!.subjectUserId).toBe(actor.userId);

    await closePrivacyRequest(
      db,
      manager,
      id,
      { status: "completed", outcome: "Copie envoyée" },
      NOW,
    );
    expect(
      await failure(closePrivacyRequest(db, manager, id, { status: "refused", outcome: "Encore" })),
    ).toBe("not_found");
    expect((await listPrivacyRequests(db, manager, NOW)).at(-1)).toMatchObject({
      id,
      status: "completed",
      outcome: "Copie envoyée",
    });
    const actions = (await db.select().from(auditEvents)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["privacy.request_logged", "privacy.request_closed"]),
    );
    expect(
      await failure(
        createPrivacyRequest(
          db,
          manager,
          { kind: "access", channel: "email", contact: email, receivedOn: "2026-12-01" },
          NOW,
        ),
      ),
    ).toBe("received_in_future");
  });
});

describe("incident register", () => {
  const incident = {
    discoveredOn: "2026-10-10",
    description: "Une liste de commandes imprimée a été oubliée sur le comptoir.",
    dataInvolved: "Prénoms et numéros de commande de 8 clients",
    peopleAffected: 8,
    riskOfSeriousInjury: null,
    closed: false,
  };

  it("records incidents, keeps corrections audited, and won't close a serious one without notices", async () => {
    const { id } = await saveIncident(db, manager, incident, undefined, NOW);
    expect(await failure(saveIncident(db, manager, { ...incident, closed: true }, id, NOW))).toBe(
      "validation_failed",
    ); // not assessed
    expect(
      await failure(
        saveIncident(
          db,
          manager,
          { ...incident, riskOfSeriousInjury: true, closed: true },
          id,
          NOW,
        ),
      ),
    ).toBe("validation_failed"); // serious, nobody notified
    await saveIncident(
      db,
      manager,
      {
        ...incident,
        riskOfSeriousInjury: true,
        riskAssessment: "Faible sensibilité, mais nombre élevé.",
        measuresTaken: "Feuilles déchiquetées; procédure revue.",
        commissionNotifiedOn: "2026-10-11",
        peopleNotifiedOn: "2026-10-11",
        closed: true,
      },
      id,
      NOW,
    );
    const [row] = await listIncidents(db, manager);
    expect(row).toMatchObject({
      id,
      closed: true,
      riskOfSeriousInjury: true,
      commissionNotifiedOn: "2026-10-11",
      discoveredOn: "2026-10-10",
    });
    const [updated] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "privacy.incident_updated"));
    expect((updated!.metadata as { changed: string[] }).changed).toEqual(
      expect.arrayContaining(["riskOfSeriousInjury", "commissionNotifiedAt", "status"]),
    );
    // The audit trail names fields, never the incident's content.
    expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain("comptoir");
    expect(
      await failure(
        saveIncident(db, manager, { ...incident, discoveredOn: "2026-12-01" }, undefined, NOW),
      ),
    ).toBe("validation_failed");
    expect(await db.select().from(confidentialityIncidents)).toHaveLength(1);
  });
});

describe("privacy officer", () => {
  it("is saved by a manager and published", async () => {
    expect(await getPrivacyOfficer(db)).toEqual({ name: null, email: null });
    await savePrivacyOfficer(db, manager, {
      name: "Propriétaire",
      email: "Vie.Privee@Example.test",
    });
    expect(await getPrivacyOfficer(db)).toEqual({
      name: "Propriétaire",
      email: "vie.privee@example.test",
    });
    expect(
      await failure(savePrivacyOfficer(db, manager, { name: "X", email: "pas un courriel" })),
    ).toBe("validation_failed");
  });
});

describe("retention", () => {
  it("removes expired sign-in data and old guest contact details, and keeps the books", async () => {
    const { actor } = await newCustomer();
    const oldGuest = await order(null, { email: "old@example.test", notes: "Allergie noix" });
    const recentGuest = await order(null, { email: "recent@example.test" });
    const account = await order(actor);
    const unpaidOldGuest = await order(null, { email: "waiting@example.test", pay: false });
    for (const id of [oldGuest, recentGuest, account]) await complete(id);
    const longAgo = new Date(NOW.getTime() - (RETENTION.guestContactDays + 1) * DAY);
    for (const id of [oldGuest, account, unpaidOldGuest])
      await db.update(orders).set({ placedAt: longAgo }).where(eq(orders.id, id));
    await db.insert(sessions).values([
      { id: "s1", token: "t1", userId: actor.userId, expiresAt: new Date(NOW.getTime() - 1) },
      { id: "s2", token: "t2", userId: actor.userId, expiresAt: new Date(NOW.getTime() + DAY) },
    ]);
    await db.insert(paymentEvents).values([
      {
        provider: "stripe",
        eventId: "evt_old",
        type: "checkout.session.completed",
        payload: { customer_details: { email: "payer@example.test" } },
        receivedAt: new Date(NOW.getTime() - (RETENTION.paymentEventPayloadDays + 1) * DAY),
        processedAt: new Date(NOW.getTime() - (RETENTION.paymentEventPayloadDays + 1) * DAY),
      },
      {
        provider: "stripe",
        eventId: "evt_new",
        type: "checkout.session.completed",
        payload: { customer_details: { email: "payer@example.test" } },
        receivedAt: NOW,
        processedAt: NOW,
      },
    ]);
    const totalBefore = (await orderRow(oldGuest))!.totalCents;

    const summary = await runRetention(db, NOW);
    expect(summary).toMatchObject({
      sessions: 1,
      guestOrdersAnonymized: 1,
      paymentEventsRedacted: 1,
    });
    expect(await orderRow(oldGuest)).toMatchObject({
      guestEmail: ANONYMIZED_EMAIL,
      guestName: null,
      guestPhone: null,
      notes: null,
      totalCents: totalBefore,
    });
    expect(await orderRow(recentGuest)).toMatchObject({ guestEmail: "recent@example.test" });
    expect(await orderRow(account)).toMatchObject({ userId: actor.userId });
    // Still open (awaiting payment): left alone.
    expect(await orderRow(unpaidOldGuest)).toMatchObject({ guestEmail: "waiting@example.test" });
    expect((await db.select().from(sessions)).map((s) => s.id)).toEqual(["s2"]);
    const events = await db.select().from(paymentEvents);
    expect(events.find((e) => e.eventId === "evt_old")!.payload).toEqual({ redacted: true });
    expect(events.find((e) => e.eventId === "evt_new")!.payload).toMatchObject({
      customer_details: { email: "payer@example.test" },
    });

    // Running again changes nothing.
    expect(await runRetention(db, NOW)).toMatchObject({
      sessions: 0,
      guestOrdersAnonymized: 0,
      paymentEventsRedacted: 0,
    });
  });
});

describe("permissions", () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const managerOnly: Array<[string, (a: Actor) => Promise<unknown>]> = [
    ["listPrivacyRequests", (a) => listPrivacyRequests(db, a)],
    ["createPrivacyRequest", (a) => createPrivacyRequest(db, a, {})],
    ["closePrivacyRequest", (a) => closePrivacyRequest(db, a, id, {})],
    ["listIncidents", (a) => listIncidents(db, a)],
    ["saveIncident", (a) => saveIncident(db, a, {})],
    ["saveIncident (edit)", (a) => saveIncident(db, a, {}, id)],
    ["savePrivacyOfficer", (a) => savePrivacyOfficer(db, a, {})],
  ];
  it.each(managerOnly)("%s refuses everyone below manager", async (_name, run) => {
    const { actor: customer } = await newCustomer();
    for (const actor of [customer, staff, lead])
      expect(await failure(run(actor))).toBe("forbidden");
    expect(await failure(run(manager))).not.toBe("forbidden");
  });
});
