import { db } from "@/server/db";
import { apiRoute } from "@/server/http";
import { getStaffQueue } from "@/server/modules/ordering/staff-queue";
import { getSessionUser } from "@/server/session";
import { changeStream } from "@/server/sse";

export const dynamic = "force-dynamic";
// The stream ends by itself before this; the screen reconnects.
export const maxDuration = 300;

/** GET /api/v1/staff/orders/stream — the kitchen queue as server-sent events (staff only). */
export const GET = apiRoute(async (req) => {
  const user = await getSessionUser();
  // Checked once up front, so a signed-out tablet gets a 401 instead of an empty stream.
  await getStaffQueue(db(), user);
  return changeStream({
    load: () => getStaffQueue(db(), user),
    // The server time changes on every load; the queue is what matters.
    key: (queue) => JSON.stringify({ ...queue, serverTime: null }),
    signal: req.signal,
  });
});
