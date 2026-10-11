import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute, parseJson } from "@/server/http";
import { addFavorite, favoriteInput, listFavorites } from "@/server/modules/customer/favorites";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/favorites — saved drink configurations with current orderability. */
export const GET = apiRoute(async () => {
  return NextResponse.json({ favorites: await listFavorites(db(), await getSessionUser()) });
});

/** POST /api/v1/me/favorites — save a configuration (idempotent). */
export const POST = apiRoute(async (req) => {
  const input = await parseJson(req, favoriteInput);
  const favorite = await addFavorite(db(), await getSessionUser(), input);
  return NextResponse.json(favorite, { status: 201 });
});
