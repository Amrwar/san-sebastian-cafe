import { customerProfiles, eq, type Database } from "@ssc/db";
import { authorize, type Actor } from "../../authz";
import { fromZodError } from "../../errors";
import { accountSettingsInput, updateAccountSettings } from "./account-settings";

/** True until the customer has completed first-run onboarding. */
export async function needsOnboarding(db: Database, actor: Actor | null): Promise<boolean> {
  if (!actor) return false;
  const profile = await db.query.customerProfiles.findFirst({
    where: eq(customerProfiles.userId, actor.userId),
    columns: { onboardedAt: true },
  });
  return !profile?.onboardedAt;
}

/** Requires every field (name, language, both email choices), then marks onboarding complete. */
export async function completeOnboarding(
  db: Database,
  actor: Actor | null,
  rawInput: unknown,
  requestId?: string,
) {
  authorize(actor, "profile:update_own");
  const parsed = accountSettingsInput.safeParse(rawInput);
  if (!parsed.success) throw fromZodError(parsed.error);
  const settings = await updateAccountSettings(db, actor, parsed.data, requestId);
  await db
    .update(customerProfiles)
    .set({ onboardedAt: new Date() })
    .where(eq(customerProfiles.userId, actor.userId));
  return settings;
}
