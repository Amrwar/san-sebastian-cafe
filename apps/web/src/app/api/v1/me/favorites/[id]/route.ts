import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { removeFavorite } from "@/server/modules/customer/favorites";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** DELETE /api/v1/me/favorites/:id — remove one of the caller's favorites. */
export const DELETE = apiRoute<{ id: string }>(async (_req, { params }) => {
  await removeFavorite(db(), await getSessionUser(), params.id);
  return new Response(null, { status: 204 });
});
