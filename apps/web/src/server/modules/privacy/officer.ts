import { eq, storeSettings, type Database } from "@ssc/db";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { fromZodError } from "../../errors";

/*
 * The person in charge of the protection of personal information (Law 25). By default it is the
 * business's highest authority (the owner), who may delegate it in writing. Their title or name
 * and a contact address must be published: they appear on the privacy page.
 */

export interface PrivacyOfficer {
  name: string | null;
  email: string | null;
}

export async function getPrivacyOfficer(db: Database): Promise<PrivacyOfficer> {
  const [row] = await db
    .select({ name: storeSettings.privacyOfficerName, email: storeSettings.privacyOfficerEmail })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  return { name: row?.name ?? null, email: row?.email ?? null };
}

export const officerInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  })
  .strict();

export async function savePrivacyOfficer(
  db: Database,
  actor: Actor | null,
  raw: unknown,
): Promise<void> {
  authorize(actor, "privacy:manage");
  const parsed = officerInput.safeParse(raw);
  if (!parsed.success) throw fromZodError(parsed.error);
  const { name, email } = parsed.data;
  await db.transaction(async (tx) => {
    await tx
      .insert(storeSettings)
      .values({ id: 1, privacyOfficerName: name, privacyOfficerEmail: email })
      .onConflictDoUpdate({
        target: storeSettings.id,
        set: { privacyOfficerName: name, privacyOfficerEmail: email, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "privacy.officer_changed",
      entityType: "store_settings",
      entityId: "1",
    });
  });
}
