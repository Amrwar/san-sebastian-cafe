import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  and,
  customerProfiles,
  desc,
  eq,
  isNotNull,
  marketingCampaigns,
  notificationPreferences,
  outboxMessages,
  sql,
  storeSettings,
  users,
  type Database,
  type Tx,
} from "@ssc/db";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound, unprocessable } from "../../errors";

/*
 * Marketing email under CASL (Canada's anti-spam law):
 * - sent only to people who gave express consent (Mon compte → Communications; never pre-ticked),
 *   checked again when each message is sent;
 * - every message identifies the sender (business name and mailing address) and carries a
 *   one-click unsubscribe that takes effect at once (the law allows up to 10 business days);
 * - each send and each withdrawal is audited.
 */

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}
const isUuid = (id: string) => z.uuid().safeParse(id).success;

// --- Unsubscribe links ----------------------------------------------------------------------------

/** A link-safe signature of the user id (no expiry: an unsubscribe link must keep working). */
export function unsubscribeToken(userId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`unsubscribe:${userId}`)
    .digest("base64url")
    .slice(0, 32);
}

export function validUnsubscribeToken(userId: string, token: string, secret: string): boolean {
  const expected = Buffer.from(unsubscribeToken(userId, secret));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Withdraws marketing consent from an unsubscribe link. Idempotent. */
export async function unsubscribe(
  db: Database,
  userId: string,
  token: string,
  secret: string,
  now = new Date(),
): Promise<void> {
  if (!validUnsubscribeToken(userId, token, secret)) throw notFound("Subscription");
  await db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
    // A deleted account has nothing left to unsubscribe.
    if (!user) return;
    const [pref] = await tx
      .select({ enabled: notificationPreferences.enabled })
      .from(notificationPreferences)
      .where(marketingPref(userId));
    if (pref && !pref.enabled) return;
    await tx
      .insert(notificationPreferences)
      .values({ userId, channel: "email", topic: "marketing", enabled: false, consentedAt: null })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.userId,
          notificationPreferences.channel,
          notificationPreferences.topic,
        ],
        set: { enabled: false, consentedAt: null, updatedAt: now },
      });
    await recordAudit(tx, {
      actorUserId: userId,
      action: "consent.marketing_email.withdrawn",
      entityType: "user",
      entityId: userId,
      metadata: { via: "unsubscribe_link" },
    });
  });
}

const marketingPref = (userId: string) =>
  and(
    eq(notificationPreferences.userId, userId),
    eq(notificationPreferences.channel, "email"),
    eq(notificationPreferences.topic, "marketing"),
  );

/** Whether this customer may receive marketing email right now. */
export async function hasMarketingConsent(db: Database | Tx, userId: string): Promise<boolean> {
  const [pref] = await db
    .select({
      enabled: notificationPreferences.enabled,
      consentedAt: notificationPreferences.consentedAt,
    })
    .from(notificationPreferences)
    .where(marketingPref(userId));
  return Boolean(pref?.enabled && pref.consentedAt);
}

// --- Sender identity ------------------------------------------------------------------------------

export const senderInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    /** Mailing address (CASL): street, city, province, postal code. */
    address: z.string().trim().min(10).max(300),
  })
  .strict();

export async function getSender(db: Database | Tx) {
  const [row] = await db
    .select({ name: storeSettings.senderName, address: storeSettings.senderAddress })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  return { name: row?.name ?? null, address: row?.address ?? null };
}

export async function saveSender(db: Database, actor: Actor | null, raw: unknown): Promise<void> {
  authorize(actor, "promotions:manage");
  const { name, address } = parse(senderInput, raw);
  await db.transaction(async (tx) => {
    await tx
      .insert(storeSettings)
      .values({ id: 1, senderName: name, senderAddress: address })
      .onConflictDoUpdate({
        target: storeSettings.id,
        set: { senderName: name, senderAddress: address, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "marketing.sender_changed",
      entityType: "store_settings",
      entityId: "1",
    });
  });
}

// --- Campaigns ------------------------------------------------------------------------------------

export const campaignInput = z
  .object({
    subjectFr: z.string().trim().min(3).max(120),
    subjectEn: z.string().trim().min(3).max(120),
    bodyFr: z.string().trim().min(10).max(5000),
    bodyEn: z.string().trim().min(10).max(5000),
  })
  .strict();
export type CampaignInput = z.infer<typeof campaignInput>;

/** Customers who consented to marketing email (demo accounts never receive any). */
function audience(db: Database | Tx) {
  return db
    .select({ userId: users.id, email: users.email, locale: customerProfiles.preferredLocale })
    .from(users)
    .innerJoin(
      notificationPreferences,
      and(
        eq(notificationPreferences.userId, users.id),
        eq(notificationPreferences.channel, "email"),
        eq(notificationPreferences.topic, "marketing"),
      ),
    )
    .leftJoin(customerProfiles, eq(customerProfiles.userId, users.id))
    .where(
      and(
        eq(users.isDemo, false),
        eq(notificationPreferences.enabled, true),
        isNotNull(notificationPreferences.consentedAt),
      ),
    );
}

export interface CampaignView extends CampaignInput {
  id: string;
  status: "draft" | "sent";
  recipientCount: number | null;
  sentAt: Date | null;
  createdAt: Date;
  delivered: number;
  skipped: number;
  pending: number;
}

export async function getMarketingAdmin(db: Database, actor: Actor | null) {
  authorize(actor, "promotions:manage");
  const [sender, consenting, campaigns, stats] = await Promise.all([
    getSender(db),
    audience(db),
    db.select().from(marketingCampaigns).orderBy(desc(marketingCampaigns.createdAt)).limit(50),
    db
      .select({
        campaignId: sql<string>`${outboxMessages.payload}->>'campaignId'`,
        status: outboxMessages.status,
        n: sql<number>`count(*)::int`,
      })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.template, "marketing"),
          sql`coalesce((${outboxMessages.payload}->>'test')::boolean, false) = false`,
        ),
      )
      .groupBy(sql`1`, outboxMessages.status),
  ]);
  const count = (id: string, statuses: string[]) =>
    stats
      .filter((s) => s.campaignId === id && statuses.includes(s.status))
      .reduce((t, s) => t + s.n, 0);
  return {
    sender,
    audienceCount: consenting.length,
    campaigns: campaigns.map((c): CampaignView => ({
      id: c.id,
      subjectFr: c.subjectFr,
      subjectEn: c.subjectEn,
      bodyFr: c.bodyFr,
      bodyEn: c.bodyEn,
      status: c.status === "sent" ? "sent" : "draft",
      recipientCount: c.recipientCount,
      sentAt: c.sentAt,
      createdAt: c.createdAt,
      delivered: count(c.id, ["sent"]),
      skipped: count(c.id, ["skipped", "failed"]),
      pending: count(c.id, ["pending", "sending"]),
    })),
  };
}

/** Creates (no id) or edits a draft. A sent campaign can't change. */
export async function saveCampaign(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  campaignId?: string,
): Promise<{ id: string }> {
  authorize(actor, "promotions:manage");
  const input = parse(campaignInput, raw);
  if (campaignId === undefined) {
    const [row] = await db
      .insert(marketingCampaigns)
      .values({ ...input, createdByUserId: actor.userId })
      .returning({ id: marketingCampaigns.id });
    return { id: row?.id ?? "" };
  }
  if (!isUuid(campaignId)) throw notFound("Campaign");
  const [row] = await db
    .update(marketingCampaigns)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(marketingCampaigns.id, campaignId), eq(marketingCampaigns.status, "draft")))
    .returning({ id: marketingCampaigns.id });
  if (!row) throw unprocessable("campaign_sent");
  return { id: campaignId };
}

async function draftFor(tx: Tx, campaignId: string) {
  if (!isUuid(campaignId)) throw notFound("Campaign");
  const [campaign] = await tx
    .select()
    .from(marketingCampaigns)
    .where(eq(marketingCampaigns.id, campaignId))
    .for("update");
  if (!campaign) throw notFound("Campaign");
  return campaign;
}

/** Sends the campaign to the staff member's own address, as a preview (no consent needed). */
export async function sendCampaignTest(
  db: Database,
  actor: Actor | null,
  campaignId: string,
  locale: "fr" | "en",
): Promise<void> {
  authorize(actor, "promotions:manage");
  await db.transaction(async (tx) => {
    await draftFor(tx, campaignId);
    const [me] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, actor.userId));
    if (!me) throw notFound("Account");
    await tx.insert(outboxMessages).values({
      channel: "email",
      template: "marketing",
      recipient: me.email,
      locale,
      payload: { campaignId, userId: null, test: true },
      dedupeKey: `campaign:${campaignId}:test:${randomUUID()}`,
    });
  });
}

/**
 * Sends a draft to every consenting customer (once: the campaign then becomes "sent"). Refused
 * until the sender's name and mailing address are set.
 */
export async function sendCampaign(
  db: Database,
  actor: Actor | null,
  campaignId: string,
  now = new Date(),
): Promise<{ recipients: number }> {
  authorize(actor, "promotions:manage");
  return db.transaction(async (tx) => {
    const sender = await getSender(tx);
    if (!sender.name || !sender.address) throw unprocessable("sender_missing");
    const campaign = await draftFor(tx, campaignId);
    if (campaign.status !== "draft")
      throw new AppError("conflict", "Already sent", [], "campaign_sent");
    const recipients = await audience(tx);
    if (recipients.length > 0) {
      await tx
        .insert(outboxMessages)
        .values(
          recipients.map((r) => ({
            channel: "email",
            template: "marketing",
            recipient: r.email,
            locale: r.locale?.startsWith("en") ? "en" : "fr",
            payload: { campaignId, userId: r.userId },
            dedupeKey: `campaign:${campaignId}:${r.userId}`,
            nextAttemptAt: now,
          })),
        )
        .onConflictDoNothing();
    }
    await tx
      .update(marketingCampaigns)
      .set({
        status: "sent",
        sentAt: now,
        recipientCount: recipients.length,
        sentByUserId: actor.userId,
        updatedAt: now,
      })
      .where(eq(marketingCampaigns.id, campaignId));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "marketing.campaign_sent",
      entityType: "marketing_campaign",
      entityId: campaignId,
      metadata: { recipients: recipients.length },
    });
    return { recipients: recipients.length };
  });
}

/** The campaign's text in one language (for sending). */
export async function campaignContent(db: Database, campaignId: string, locale: "fr" | "en") {
  const [c] = await db
    .select()
    .from(marketingCampaigns)
    .where(eq(marketingCampaigns.id, campaignId));
  if (!c) return null;
  return locale === "en"
    ? { subject: c.subjectEn, body: c.bodyEn }
    : { subject: c.subjectFr, body: c.bodyFr };
}
