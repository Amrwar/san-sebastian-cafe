"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";
import { updateAccountSettings } from "@/server/modules/identity/account-settings";
import { getSessionUser } from "@/server/session";

export type AccountFormState =
  { status: "idle" } | { status: "saved" } | { status: "error"; fields: string[] };

export async function saveAccountSettings(
  _prev: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const user = await getSessionUser();
  try {
    await updateAccountSettings(db(), user, {
      name: formData.get("name"),
      preferredLocale: formData.get("preferredLocale"),
      orderUpdatesEmail: formData.get("orderUpdatesEmail") === "on",
      marketingEmail: formData.get("marketingEmail") === "on",
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "validation_failed") {
      return { status: "error", fields: error.fieldIssues.map((i) => i.path) };
    }
    logger().error({ err: error, userId: user?.userId }, "saving account settings failed");
    return { status: "error", fields: [] };
  }
  revalidatePath("/[locale]/account", "page");
  return { status: "saved" };
}

export async function signOut(formData: FormData): Promise<void> {
  const locale = formData.get("locale") === "en" ? "en" : "fr";
  await auth().api.signOut({ headers: await headers() });
  redirect(`/${locale}`);
}
