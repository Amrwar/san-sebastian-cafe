import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { enforceLimit, requester } from "@/server/rate-limit";
import { apiRoute } from "@/server/http";
import {
  removePushSubscription,
  savePushSubscription,
} from "@/server/notifications/push-subscriptions";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** POST /api/v1/me/push — turns Web Push on for this device (body: a PushSubscription). */
export const POST = apiRoute(async (req) => {
  const user = await getSessionUser();
  await enforceLimit(db(), "pushSubscription", requester(req, user?.userId));
  const body: unknown = await req.json().catch(() => null);
  await savePushSubscription(db(), user, body, req.headers.get("user-agent"));
  return new NextResponse(null, { status: 204 });
});

/** DELETE /api/v1/me/push — turns it off (body: `{ endpoint }`). */
export const DELETE = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  await removePushSubscription(db(), await getSessionUser(), body);
  return new NextResponse(null, { status: 204 });
});
