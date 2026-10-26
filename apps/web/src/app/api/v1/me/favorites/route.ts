import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { addFavorite, listFavorites } from "@/server/modules/customer/favorites";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/v1/me/favorites — saved drink configurations with current orderability. */
export const GET = apiRoute(async () => {
  return NextResponse.json({ favorites: await listFavorites(db(), await getSessionUser()) });
});

/** POST /api/v1/me/favorites — save a configuration (idempotent). */
export const POST = apiRoute(async (req) => {
  // The service checks the session first, then the body.
  const body: unknown = await req.json().catch(() => null);
  const favorite = await addFavorite(db(), await getSessionUser(), body);
  return NextResponse.json(favorite, { status: 201 });
});
