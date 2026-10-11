"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";
import { updateAccountSettings } from "@/server/modules/identity/account-settings";
import { completeOnboarding } from "@/server/modules/identity/onboarding";
import { getSessionUser } from "@/server/session";

export type SettingsFormState =
  { status: "idle" } | { status: "saved" } | { status: "error"; fields: string[] };

/**
 * One action for the profile form, the communications form and onboarding. Only the sections
 * present in the form are sent, so each page updates just its own fields.
 */
export async function saveSettings(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const user = await getSessionUser();
  const rawSections = formData.get("sections");
  const sections = typeof rawSections === "string" ? rawSections.split(",") : [];
  const mode = formData.get("mode") === "onboarding" ? "onboarding" : "settings";
  const input: Record<string, unknown> = {};
  if (sections.includes("profile")) {
    input.name = formData.get("name");
    input.preferredLocale = formData.get("preferredLocale");
  }
  if (sections.includes("notifications")) {
    input.orderUpdatesEmail = formData.get("orderUpdatesEmail") === "on";
    input.marketingEmail = formData.get("marketingEmail") === "on";
  }

  try {
    if (mode === "onboarding") await completeOnboarding(db(), user, input);
    else await updateAccountSettings(db(), user, input);
  } catch (error) {
    if (error instanceof AppError && error.code === "validation_failed") {
      return { status: "error", fields: error.fieldIssues.map((i) => i.path) };
    }
    logger().error({ err: error, userId: user?.userId }, "saving account settings failed");
    return { status: "error", fields: [] };
  }

  if (mode === "onboarding") {
    const locale = formData.get("locale") === "en" ? "en" : "fr";
    const next = formData.get("next");
    redirect(safeRedirectPath(typeof next === "string" ? next : null, `/${locale}`));
  }
  revalidatePath("/[locale]/account", "layout");
  return { status: "saved" };
}

export async function signOut(formData: FormData): Promise<void> {
  const locale = formData.get("locale") === "en" ? "en" : "fr";
  await auth().api.signOut({ headers: await headers() });
  redirect(`/${locale}`);
}
