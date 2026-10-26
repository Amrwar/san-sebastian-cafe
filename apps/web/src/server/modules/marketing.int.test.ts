import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  eq,
  marketingCampaigns,
  notificationPreferences,
  outboxMessages,
  sql,
  users,
  type Database,
  type DbHandle,
} from "@ssc/db";
import { DEMO_EMAIL_DOMAIN, seedDemoData } from "@ssc/db/seed";
import { createTestDatabase } from "@ssc/db/testing";
import type { Actor } from "../authz";
import { AppError } from "../errors";
import { processOutbox, type Deliverer, type QueuedMessage } from "../notifications/outbox";
import { renderMarketingEmail } from "../notifications/templates";
import { updateAccountSettings } from "./identity/account-settings";
import { provisionAccount } from "./identity/provisioning";
import {
  getMarketingAdmin,
  hasMarketingConsent,
  saveCampaign,
  saveSender,
  sendCampaign,
  sendCampaignTest,
  unsubscribe,
  unsubscribeToken,
  validUnsubscribeToken,
} from "./marketing/campaigns";
import { deleteOwnAccount } from "./privacy/deletion";

/*
 * Marketing email under CASL: express consent only, sender identified, one-click unsubscribe
 * honoured at once (even for messages already queued), every send and withdrawal audited.
 */

const NOW = new Date("2026-10-12T14:00:00Z");
const SECRET = "x".repeat(40);

let handle: DbHandle;
let db: Database;
let lead: Actor;
let manager: Actor;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table users, categories, modifier_groups, orders, promotions, delivery_zones, store_settings, opening_hours, order_counters, payment_events, audit_events, loyalty_programs, outbox_messages, marketing_campaigns restart identity cascade`,
  );
  await seedDemoData(db, NOW);
  const byEmail = async (local: string) =>
    (
      await db
        .select()
        .from(users)
        .where(eq(users.email, `${local}@${DEMO_EMAIL_DOMAIN}`))
    )[0]!;
  lead = { userId: (await byEmail("lead")).id, role: "shift_lead" };
  manager = { userId: (await byEmail("manager")).id, role: "manager" };
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

async function customer(consents: boolean, locale: "fr-CA" | "en-CA" = "fr-CA") {
  const userId = randomUUID();
  const email = `${userId}@example.test`;
  await db.insert(users).values({ id: userId, name: "Robin", email });
  await provisionAccount(db, userId, locale);
  const actor: Actor = { userId, role: "customer" };
  if (consents) await updateAccountSettings(db, actor, { marketingEmail: true });
  return { actor, email, userId };
}

const campaign = {
  subjectFr: "Nouveau : latte à l’érable",
  subjectEn: "New: maple latte",
  bodyFr: "Venez goûter notre latte à l’érable.\n\nOffert jusqu’à dimanche.",
  bodyEn: "Come taste our maple latte.\n\nAvailable until Sunday.",
};
const sender = {
  name: "San Sebastian Café",
  address: "123, rue Saint-Denis, Montréal (Québec) H2X 1K1",
};

/** A worker double that records sends, re-checking consent like the real one. */
function recorder() {
  const sent: QueuedMessage[] = [];
  const deliverer: Deliverer = {
    async send(m) {
      if (m.template === "marketing" && !m.payload.test) {
        if (!m.payload.userId || !(await hasMarketingConsent(db, m.payload.userId)))
          return "skipped";
      }
      sent.push(m);
      return "sent";
    },
  };
  return { sent, deliverer };
}

describe("marketing email", () => {
  it("goes only to customers who consented, each in their language, once", async () => {
    const fr = await customer(true, "fr-CA");
    const en = await customer(true, "en-CA");
    await customer(false);
    await saveSender(db, manager, sender);
    const { id } = await saveCampaign(db, manager, campaign);
    expect((await getMarketingAdmin(db, manager)).audienceCount).toBe(2);

    expect(await sendCampaign(db, manager, id, NOW)).toEqual({ recipients: 2 });
    const rows = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.template, "marketing"));
    expect(rows.map((r) => [r.recipient, r.locale]).sort()).toEqual(
      [
        [fr.email, "fr"],
        [en.email, "en"],
      ].sort(),
    );
    // Sending again is refused: the campaign is sent.
    expect(await failure(sendCampaign(db, manager, id, NOW))).toBe("campaign_sent");
    expect(await failure(saveCampaign(db, manager, campaign, id))).toBe("campaign_sent");

    const { sent, deliverer } = recorder();
    await processOutbox(db, deliverer, { now: NOW });
    expect(sent).toHaveLength(2);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "marketing.campaign_sent"));
    expect(audit!.metadata).toEqual({ recipients: 2 });
  });

  it("is refused until the sender's name and mailing address are set", async () => {
    await customer(true);
    const { id } = await saveCampaign(db, manager, campaign);
    expect(await failure(sendCampaign(db, manager, id, NOW))).toBe("sender_missing");
    const [row] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, id));
    expect(row!.status).toBe("draft");
  });

  it("an unsubscribe takes effect at once, even for a message already queued", async () => {
    const robin = await customer(true);
    await saveSender(db, manager, sender);
    const { id } = await saveCampaign(db, manager, campaign);
    await sendCampaign(db, manager, id, NOW);

    const token = unsubscribeToken(robin.userId, SECRET);
    expect(validUnsubscribeToken(robin.userId, token, SECRET)).toBe(true);
    expect(validUnsubscribeToken(robin.userId, token, "y".repeat(40))).toBe(false);
    expect(await failure(unsubscribe(db, robin.userId, "forged", SECRET))).toBe("not_found");
    await unsubscribe(db, robin.userId, token, SECRET, NOW);
    await unsubscribe(db, robin.userId, token, SECRET, NOW); // a second click changes nothing

    expect(await hasMarketingConsent(db, robin.userId)).toBe(false);
    const { sent, deliverer } = recorder();
    expect((await processOutbox(db, deliverer, { now: NOW })).skipped).toBe(1);
    expect(sent).toEqual([]);
    const withdrawals = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "consent.marketing_email.withdrawn"));
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]!.metadata).toEqual({ via: "unsubscribe_link" });
    const [pref] = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, robin.userId));
    expect(pref).toBeDefined();
  });

  it("a test goes to the staff member only, and the campaign stays a draft", async () => {
    await saveSender(db, manager, sender);
    const { id } = await saveCampaign(db, manager, campaign);
    await sendCampaignTest(db, manager, id, "en");
    const rows = await db.select().from(outboxMessages);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient).toBe(`manager@${DEMO_EMAIL_DOMAIN}`);
    expect(rows[0]!.payload).toMatchObject({ test: true, userId: null });
    const [row] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, id));
    expect(row!.status).toBe("draft");
  });

  it("identifies the sender and offers the unsubscribe link in every email", () => {
    const email = renderMarketingEmail({
      locale: "fr",
      subject: campaign.subjectFr,
      body: campaign.bodyFr,
      sender,
      unsubscribeUrl: "https://cafe.example/fr/unsubscribe?u=1&t=2",
      test: false,
    });
    expect(email.text).toContain(sender.address);
    expect(email.text).toContain("Se désabonner : https://cafe.example/fr/unsubscribe?u=1&t=2");
    expect(email.text).toContain("vous avez accepté de recevoir");
    expect(email.html).toContain("Se désabonner en un clic");
  });

  it("a deleted account's marketing messages go with it", async () => {
    const robin = await customer(true);
    await saveSender(db, manager, sender);
    const { id } = await saveCampaign(db, manager, campaign);
    await sendCampaign(db, manager, id, NOW);
    await deleteOwnAccount(db, robin.actor, { confirmEmail: robin.email }, NOW);
    expect(await db.select().from(outboxMessages)).toEqual([]);
  });

  it("is for managers and above", async () => {
    for (const run of [
      () => saveSender(db, lead, sender),
      () => saveCampaign(db, lead, campaign),
      () => getMarketingAdmin(db, lead),
      () => sendCampaign(db, lead, randomUUID()),
    ])
      expect(await failure(run())).toBe("forbidden");
  });
});
