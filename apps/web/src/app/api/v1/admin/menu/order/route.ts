import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { reorderMenu } from "@/server/modules/admin/menu";
import { getSessionUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * PUT /api/v1/admin/menu/order — { ids } orders the categories; { ids, categoryId } orders the
 * products of one category. The list must name exactly the current items.
 */
export const PUT = apiRoute(async (req) => {
  const body: unknown = await req.json().catch(() => null);
  const { categoryId, ...rest } =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  await reorderMenu(
    db(),
    await getSessionUser(),
    rest,
    typeof categoryId === "string" ? categoryId : undefined,
  );
  return new NextResponse(null, { status: 204 });
});
