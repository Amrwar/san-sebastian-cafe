import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getOrderStatus } from "@/server/modules/ordering/customer-orders";
import { orderTokenFrom } from "@/server/order-token";
import { getSessionUser } from "@/server/session";
import { changeStream } from "@/server/sse";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FINAL = new Set([
  "completed",
  "cancelled",
  "expired",
  "rejected",
  "refunded",
  "partially_refunded",
]);

/**
 * GET /api/v1/orders/:id/stream — the order's status as server-sent events (owner, staff, or a
 * guest with `?token=`, since EventSource can't send headers). Ends once the order is finished.
 */
export const GET = apiRoute<{ id: string }>(async (req, { params }) => {
  const user = await getSessionUser();
  const token = orderTokenFrom(req);
  await getOrderStatus(db(), user, params.id, token);
  return changeStream({
    load: () => getOrderStatus(db(), user, params.id, token),
    key: (s) => s.status,
    isFinal: (s) => FINAL.has(s.status),
    signal: req.signal,
    intervalMs: 3000,
  });
});
