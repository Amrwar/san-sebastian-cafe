import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  eq,
  giftCardPurchases,
  giftCards,
  outboxMessages,
  sql,
  users,
  type Database,
  type DbHandle,
} from "@ssc/db";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "@ssc/db/seed";
import { createTestDatabase } from "@ssc/db/testing";
import { StripeDouble } from "@/test/stripe-double";
import type { Actor } from "../authz";
import { AppError } from "../errors";
import { processOutbox, type QueuedMessage } from "../notifications/outbox";
import { checkGiftCardBalance, redeemAtCounter } from "./gift-cards/gift-cards";
import {
  maskEmail,
  refundPurchaseAsStaff,
  simulatePurchasePayment,
  startPurchase,
  syncPurchase,
} from "./gift-cards/purchases";
import { overridePaymentProviderForTests } from "./payments/provider";
import { ANONYMIZED_EMAIL, anonymizeGiftCardPurchases } from "./privacy/deletion";
import { exportPersonalData } from "./privacy/export";
import { runRetention } from "./privacy/retention";
import { handlePaymentWebhook } from "./payments/webhooks";

/*
 * Gift cards bought on the site against a real database: the card is issued once the provider
 * confirms the money (simulator, return-page check or webhook), its code goes to the recipient
 * by email and is erased from the queue once sent; money that can't buy a card is refunded; an
 * unused card can be refunded by staff.
 */

const NOW = new Date("2026-10-12T14:00:00Z");

let handle: DbHandle;
let db: Database;
let customer: Actor;
let staff: Actor;
let lead: Actor;
let stripe: StripeDouble;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await db.execute(
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events, gift_cards, gift_card_purchases, outbox_messages restart identity cascade`,
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
  stripe = new StripeDouble();
  overridePaymentProviderForTests("stripe", stripe);
});
afterEach(() => {
  overridePaymentProviderForTests("stripe", null);
});

const form = (overrides: Record<string, unknown> = {}) => ({
  amountCents: 2500,
  recipientName: "Camille",
  recipientEmail: "camille@example.test",
  message: "Bonne fête!",
  purchaserName: "Robin",
  purchaserEmail: "robin@example.test",
  locale: "fr",
  ...overrides,
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

const purchaseRow = async (id: string) =>
  (await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, id)))[0]!;
const emails = () => db.select().from(outboxMessages).orderBy(outboxMessages.template);
const deliveredCode = async () =>
  (await emails()).find((m) => m.template === "gift_card_delivery")?.payload.code as string;

describe("buying a card", () => {
  it("checks the form: online amounts from 10 $ to 200 $, and guests give their email", async () => {
    const opts = { provider: "fake" as const, now: NOW };
    expect(await failure(startPurchase(db, null, form({ amountCents: 500 }), opts))).toBe(
      "validation_failed",
    );
    expect(await failure(startPurchase(db, null, form({ amountCents: 25_000 }), opts))).toBe(
      "validation_failed",
    );
    expect(await failure(startPurchase(db, null, form({ purchaserEmail: undefined }), opts))).toBe(
      "validation_failed",
    );
    expect(await failure(startPurchase(db, null, form(), { provider: "none", now: NOW }))).toBe(
      "payments_unavailable",
    );
  });

  it("once paid, issues the card and emails its code to the recipient; the receipt has no code", async () => {
    const started = await startPurchase(db, null, form(), { provider: "fake", now: NOW });
    expect(await purchaseRow(started.purchaseId)).toMatchObject({ status: "awaiting_payment" });
    const view = await simulatePurchasePayment(db, null, started.purchaseId, started.token, NOW);
    expect(view).toMatchObject({ status: "paid", recipientEmail: "c•••••e@example.test" });

    const purchase = await purchaseRow(started.purchaseId);
    const [card] = await db.select().from(giftCards).where(eq(giftCards.id, purchase.giftCardId!));
    expect(card).toMatchObject({ initialCents: 2500, balanceCents: 2500, status: "active" });

    const [delivery, receipt] = await emails();
    expect(delivery).toMatchObject({
      template: "gift_card_delivery",
      recipient: "camille@example.test",
    });
    expect(receipt).toMatchObject({
      template: "gift_card_receipt",
      recipient: "robin@example.test",
    });
    expect(JSON.stringify(receipt?.payload)).not.toContain(String(delivery?.payload.code));
    // The emailed code is the card's.
    const code = await deliveredCode();
    expect(await checkGiftCardBalance(db, { code })).toMatchObject({ balanceCents: 2500 });

    // Paying again (a retried confirmation) issues nothing more.
    await simulatePurchasePayment(db, null, started.purchaseId, started.token, NOW);
    expect(await db.select().from(giftCards)).toHaveLength(1);
  });

  it("only the purchaser follows the purchase: by its link token, or their account", async () => {
    const guest = await startPurchase(db, null, form(), { provider: "fake", now: NOW });
    expect(await failure(syncPurchase(db, null, guest.purchaseId, "wrong", NOW))).toBe("not_found");
    const mine = await startPurchase(db, customer, form({ purchaserEmail: undefined }), {
      provider: "fake",
      now: NOW,
    });
    expect((await syncPurchase(db, customer, mine.purchaseId, null, NOW)).status).toBe(
      "awaiting_payment",
    );
    expect((await purchaseRow(mine.purchaseId)).purchaserEmail).toBe(
      `customer@${DEMO_EMAIL_DOMAIN}`,
    );
  });

  it("erases the code from the queued email once it has been sent", async () => {
    const started = await startPurchase(db, null, form(), { provider: "fake", now: NOW });
    await simulatePurchasePayment(db, null, started.purchaseId, started.token, NOW);
    const sent: QueuedMessage[] = [];
    const deliverer = {
      send: (m: QueuedMessage) => {
        sent.push(m);
        return Promise.resolve("sent" as const);
      },
    };
    // Queued messages are due from the database clock: run the outbox at the real time.
    await processOutbox(db, deliverer, { now: new Date(Date.now() + 1000) });
    const delivered = sent.find((m) => m.template === "gift_card_delivery");
    expect((delivered?.payload as { code?: string }).code).toMatch(/^[2-9A-Z]{4}-/);
    expect(await deliveredCode()).toBeNull();
  });
});

describe("through the provider (webhook and return page)", () => {
  async function started() {
    const s = await startPurchase(db, null, form(), { provider: "stripe", now: NOW });
    const sessionId = (await purchaseRow(s.purchaseId)).providerSessionId!;
    return { ...s, sessionId };
  }
  let counter = 0;
  const deliver = (sessionId: string, now = NOW) =>
    handlePaymentWebhook(
      db,
      "stripe",
      JSON.stringify({
        id: `evt_gc_${++counter}`,
        type: "checkout.session.completed",
        kind: "checkout",
        sessionId,
      }),
      "valid",
      now,
    );

  it("a verified webhook issues the card; the return page then just reads it", async () => {
    const s = await started();
    expect(stripe.checkoutsCreated[0]).toMatchObject({ kind: "gift_card", amountCents: 2500 });
    stripe.pay(s.sessionId);
    expect(await deliver(s.sessionId)).toMatchObject({
      duplicate: false,
      note: "gift_card_purchase",
    });
    expect((await syncPurchase(db, null, s.purchaseId, s.token, NOW)).status).toBe("paid");
    expect(await db.select().from(giftCards)).toHaveLength(1);
  });

  it("the return page's own check issues the card if the webhook hasn't come yet", async () => {
    const s = await started();
    stripe.pay(s.sessionId);
    expect((await syncPurchase(db, null, s.purchaseId, s.token, NOW)).status).toBe("paid");
    await deliver(s.sessionId); // the webhook arriving later changes nothing
    expect(await db.select().from(giftCards)).toHaveLength(1);
  });

  it("money paid after the page expired, or for another amount, is refunded and buys nothing", async () => {
    const late = await started();
    stripe.pay(late.sessionId);
    await deliver(late.sessionId, new Date(NOW.getTime() + 2 * 3_600_000));
    const wrong = await started();
    stripe.pay(wrong.sessionId, "paid", { amountCents: 100 });
    await deliver(wrong.sessionId);
    expect(await db.select().from(giftCards)).toHaveLength(0);
    expect(stripe.refundCalls.map((r) => r.amountCents).sort()).toEqual([100, 2500].sort());
  });
});

describe("staff refunds", () => {
  async function paidCard() {
    const s = await startPurchase(db, null, form(), { provider: "stripe", now: NOW });
    const sessionId = (await purchaseRow(s.purchaseId)).providerSessionId!;
    stripe.pay(sessionId);
    await syncPurchase(db, null, s.purchaseId, s.token, NOW);
    return (await purchaseRow(s.purchaseId)).giftCardId!;
  }

  it("an unused card bought online is refunded: emptied, blocked, money back through Stripe", async () => {
    const cardId = await paidCard();
    expect(
      await failure(refundPurchaseAsStaff(db, staff, cardId, { reason: "Wrong person" })),
    ).toBe("forbidden");
    const result = await refundPurchaseAsStaff(db, lead, cardId, { reason: "Bought by mistake" });
    expect(result.refundStatus).toBe("succeeded");
    expect(stripe.refundCalls).toEqual([expect.objectContaining({ amountCents: 2500 })]);
    const [card] = await db.select().from(giftCards).where(eq(giftCards.id, cardId));
    expect(card).toMatchObject({ balanceCents: 0, status: "disabled" });
    expect(await failure(refundPurchaseAsStaff(db, lead, cardId, { reason: "Again" }))).toBe(
      "refund_not_allowed",
    );
  });

  it("a card that has been used can't be refunded", async () => {
    const cardId = await paidCard();
    await redeemAtCounter(db, staff, cardId, { amountCents: 300 });
    expect(await failure(refundPurchaseAsStaff(db, lead, cardId, { reason: "Changed mind" }))).toBe(
      "gift_card_used",
    );
  });
});

describe("privacy", () => {
  it("purchases are in the purchaser's data export, and are anonymized with their account", async () => {
    const started = await startPurchase(db, customer, form({ purchaserEmail: undefined }), {
      provider: "fake",
      now: NOW,
    });
    await simulatePurchasePayment(db, customer, started.purchaseId, null, NOW);
    const exported = await exportPersonalData(db, customer, NOW);
    expect(exported.giftCardsBought).toEqual([
      expect.objectContaining({
        amountCents: 2500,
        recipient: { name: "Camille", email: "camille@example.test" },
        message: "Bonne fête!",
      }),
    ]);
    expect(JSON.stringify(exported)).not.toMatch(/[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}/);

    // What account deletion does to purchases (the demo customer has orders in progress, so the
    // account itself can't be deleted here).
    await db.transaction((tx) =>
      anonymizeGiftCardPurchases(tx, {
        userId: customer.userId,
        email: `customer@${DEMO_EMAIL_DOMAIN}`,
      }),
    );
    const row = await purchaseRow(started.purchaseId);
    expect(row).toMatchObject({ purchaserEmail: ANONYMIZED_EMAIL, purchaserUserId: null });
    // The card itself stays: it is money the café owes.
    expect(await db.select().from(giftCards)).toHaveLength(1);
  });

  it("retention clears names, emails and the note a year on", async () => {
    const started = await startPurchase(db, null, form(), { provider: "fake", now: NOW });
    await simulatePurchasePayment(db, null, started.purchaseId, started.token, NOW);
    const summary = await runRetention(db, new Date(Date.now() + 400 * 86_400_000));
    expect(summary.giftCardPurchasesAnonymized).toBe(1);
    expect(await purchaseRow(started.purchaseId)).toMatchObject({
      purchaserEmail: ANONYMIZED_EMAIL,
      recipientEmail: ANONYMIZED_EMAIL,
      message: null,
    });
  });
});

describe("helpers", () => {
  it("masks an email enough to recognise it, not to collect it", () => {
    expect(maskEmail("camille@example.test")).toBe("c•••••e@example.test");
    expect(maskEmail("al@example.test")).toBe("a•@example.test");
  });
});
