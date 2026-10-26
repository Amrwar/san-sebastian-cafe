import "server-only";
import { eq, pushSubscriptions, type Database } from "@ssc/db";
import webpush, { WebPushError } from "web-push";
import { db } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { sendEmail } from "../mailer";
import {
  campaignContent,
  getSender,
  hasMarketingConsent,
  unsubscribeToken,
} from "../modules/marketing/campaigns";
import {
  processOutbox,
  type Deliverer,
  type MarketingMessage,
  type OrderMessage,
  type OutboxRun,
} from "./outbox";
import { renderEmail, renderMarketingEmail, renderPush } from "./templates";

/** Sends a push to every device of the user; drops devices the push service says are gone. */
export async function sendPush(
  database: Database,
  message: OrderMessage,
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

/**
 * Sends one marketing email, after checking again that the customer still consents (they may
 * have unsubscribed since the campaign was queued).
 */
export async function sendMarketing(
  database: Database,
  message: MarketingMessage,
  { baseUrl, secret }: { baseUrl: string; secret: string },
): Promise<"sent" | "skipped"> {
  const { campaignId, userId, test = false } = message.payload;
  if (!test && (!userId || !(await hasMarketingConsent(database, userId)))) return "skipped";
  const content = await campaignContent(database, campaignId, message.locale);
  if (!content) return "skipped";
  const sender = await getSender(database);
  if (!sender.name || !sender.address) throw new Error("sender identity missing");
  const query = userId ? `u=${userId}&t=${unsubscribeToken(userId, secret)}` : null;
  const unsubscribeUrl = query
    ? `${baseUrl}/${message.locale}/unsubscribe?${query}`
    : `${baseUrl}/${message.locale}/account/notifications`;
  const email = renderMarketingEmail({
    locale: message.locale,
    ...content,
    sender: { name: sender.name, address: sender.address },
    unsubscribeUrl,
    test,
  });
  await sendEmail({
    to: message.recipient,
    ...email,
    // One-click unsubscribe from the mail app itself (RFC 8058).
    ...(query
      ? {
          headers: {
            "List-Unsubscribe": `<${baseUrl}/api/v1/unsubscribe?${query}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : {}),
  });
  return "sent";
}

export const liveDeliverer: Deliverer = {
  async send(message) {
    if (message.template === "marketing")
      return sendMarketing(db(), message, {
        baseUrl: env().BETTER_AUTH_URL,
        secret: env().BETTER_AUTH_SECRET,
      });
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
