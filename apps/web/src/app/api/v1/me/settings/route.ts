import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute, parseJson } from "@/server/http";
import {
  accountSettingsInput,
  getAccountSettings,
  updateAccountSettings,
} from "@/server/modules/identity/account-settings";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/settings — the signed-in user's profile and email preferences. */
export const GET = apiRoute(async () => {
  const settings = await getAccountSettings(db(), await getSessionUser());
  return NextResponse.json(settings);
});

/** PUT /api/v1/me/settings — replaces the signed-in user's profile and email preferences. */
export const PUT = apiRoute(async (req, { requestId }) => {
  const user = await getSessionUser();
  const input = await parseJson(req, accountSettingsInput);
  const settings = await updateAccountSettings(db(), user, input, requestId);
  return NextResponse.json(settings);
});
