import { and, customerProfiles, eq, notificationPreferences, users, type Database } from "@ssc/db";
import { LOCALES } from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { fromZodError, notFound } from "../../errors";

export const accountSettingsInput = z.object({
  name: z.string().trim().min(1).max(80),
  preferredLocale: z.enum(LOCALES),
  orderUpdatesEmail: z.boolean(),
  marketingEmail: z.boolean(),
});
export type AccountSettingsInput = z.infer<typeof accountSettingsInput>;

/** Partial update: only the provided fields change (used by the separate profile and communication forms). */
export const accountSettingsPatch = accountSettingsInput
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export interface AccountSettings extends AccountSettingsInput {
  email: string;
  marketingConsentedAt: Date | null;
}

export async function getAccountSettings(
  db: Database,
  actor: Actor | null,
): Promise<AccountSettings> {
  authorize(actor, "profile:read_own");
  const user = await db.query.users.findFirst({
    where: eq(users.id, actor.userId),
    with: { profile: true, notificationPreferences: true },
  });
  if (!user) throw notFound("User");
  // The profile row may be missing if provisioning never ran; fall back to defaults.
  const profile = user.profile as typeof user.profile | undefined;
  const pref = (topic: "order_updates" | "marketing") =>
    user.notificationPreferences.find((p) => p.channel === "email" && p.topic === topic);
  return {
    email: user.email,
    name: user.name,
    preferredLocale: profile?.preferredLocale ?? "fr-CA",
    orderUpdatesEmail: pref("order_updates")?.enabled ?? true,
    marketingEmail: pref("marketing")?.enabled ?? false,
    marketingConsentedAt: pref("marketing")?.consentedAt ?? null,
  };
}

/**
 * Updates the actor's own profile and/or email preferences in one transaction (partial update).
 * Marketing consent changes are timestamped and written to the audit log (CASL / Law 25 evidence).
 */
export async function updateAccountSettings(
  db: Database,
  actor: Actor | null,
  rawInput: unknown,
  requestId?: string,
): Promise<AccountSettings> {
  authorize(actor, "profile:update_own");
  const parsed = accountSettingsPatch.safeParse(rawInput);
  if (!parsed.success) throw fromZodError(parsed.error);
  const input = parsed.data;
  const userId = actor.userId;

  await db.transaction(async (tx) => {
    const [existingMarketing] = await tx
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.channel, "email"),
          eq(notificationPreferences.topic, "marketing"),
        ),
      )
      .for("update");

    if (input.name !== undefined) {
      await tx.update(users).set({ name: input.name }).where(eq(users.id, userId));
    }
    if (input.preferredLocale !== undefined) {
      const preferredLocale = input.preferredLocale;
      await tx
        .insert(customerProfiles)
        .values({ userId, preferredLocale })
        .onConflictDoUpdate({ target: customerProfiles.userId, set: { preferredLocale } });
    }
    const prefTarget = [
      notificationPreferences.userId,
      notificationPreferences.channel,
      notificationPreferences.topic,
    ];
    if (input.orderUpdatesEmail !== undefined) {
      const enabled = input.orderUpdatesEmail;
      await tx
        .insert(notificationPreferences)
        .values({ userId, channel: "email", topic: "order_updates", enabled })
        .onConflictDoUpdate({ target: prefTarget, set: { enabled } });
    }

    const wasConsented = existingMarketing?.enabled ?? false;
    if (input.marketingEmail !== undefined && wasConsented !== input.marketingEmail) {
      const consentedAt = input.marketingEmail ? new Date() : null;
      await tx
        .insert(notificationPreferences)
        .values({
          userId,
          channel: "email",
          topic: "marketing",
          enabled: input.marketingEmail,
          consentedAt,
        })
        .onConflictDoUpdate({
          target: [
            notificationPreferences.userId,
            notificationPreferences.channel,
            notificationPreferences.topic,
          ],
          set: { enabled: input.marketingEmail, consentedAt },
        });
      await recordAudit(tx, {
        actorUserId: userId,
        action: input.marketingEmail
          ? "consent.marketing_email.granted"
          : "consent.marketing_email.withdrawn",
        entityType: "user",
        entityId: userId,
        metadata: { source: "account_settings" },
        ...(requestId ? { requestId } : {}),
      });
    }
  });

  return getAccountSettings(db, actor);
}
