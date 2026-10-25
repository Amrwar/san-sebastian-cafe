import "server-only";
import { eq, pushSubscriptions, type Database } from "@ssc/db";
import webpush, { WebPushError } from "web-push";
import { db } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { sendEmail } from "../mailer";
import { processOutbox, type Deliverer, type OutboxRun, type QueuedMessage } from "./outbox";
import { renderEmail, renderPush } from "./templates";

/** Sends a push to every device of the user; drops devices the push service says are gone. */
export async function sendPush(
  database: Database,
  message: QueuedMessage,
): Promise<"sent" | "skipped"> {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env();
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return "skipped";
  const devices = await database
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, message.recipient));
  const body = JSON.stringify(renderPush(message));
  let delivered = 0;
  let failure: unknown = null;
  for (const device of devices) {
    try {
      await webpush.sendNotification(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        body,
        {
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey: VAPID_PUBLIC_KEY,
            privateKey: VAPID_PRIVATE_KEY,
          },
          TTL: 60 * 60,
          urgency: "high",
        },
      );
      delivered += 1;
      await database
        .update(pushSubscriptions)
        .set({ lastSuccessAt: new Date() })
        .where(eq(pushSubscriptions.id, device.id));
    } catch (err) {
      if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
        // Unsubscribed or expired: forget this device.
        await database.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
      } else {
        failure = err;
      }
    }
  }
  if (delivered > 0) return "sent";
  if (failure) throw failure instanceof Error ? failure : new Error("push failed");
  return "skipped";
}

export const liveDeliverer: Deliverer = {
  async send(message) {
    if (message.channel === "push") return sendPush(db(), message);
    const email = renderEmail(message, env().BETTER_AUTH_URL);
    await sendEmail({ to: message.recipient, ...email });
    return "sent";
  },
};

/** Sends what is due now. Never throws: a failure stays queued for the next run. */
export async function drainOutbox(): Promise<OutboxRun | null> {
  try {
    return await processOutbox(db(), liveDeliverer);
  } catch (err) {
    logger().error({ err }, "outbox run failed");
    return null;
  }
}
