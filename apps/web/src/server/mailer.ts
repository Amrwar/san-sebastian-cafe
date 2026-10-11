import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "./env";
import { logger } from "./logger";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  /** Machine-readable payload for development tooling (e.g. the sign-in code). */
  meta?: Record<string, string>;
}

/**
 * Email boundary. Only the development "console" transport exists in Phase 1: it prints the
 * message to the server terminal and writes it to `.dev-mail/` (used by end-to-end tests).
 * Environment validation refuses this transport in staging/production, so real customers can
 * never be left waiting for an email that was only printed. A real provider adapter (e.g.
 * Postmark/Resend) is added in Phase 7.
 */
export async function sendEmail(message: OutgoingEmail): Promise<void> {
  // Only the "console" transport exists (enforced by env validation).
  const { EMAIL_FROM } = env();

  // The dev banner intentionally bypasses log redaction so developers can read the code.
  // eslint-disable-next-line no-console
  console.info(
    [
      "",
      "┌─ DEV EMAIL (not sent) ─────────────────────────────",
      `│ from:    ${EMAIL_FROM}`,
      `│ to:      ${message.to}`,
      `│ subject: ${message.subject}`,
      ...message.text.split("\n").map((l) => `│ ${l}`),
      "└────────────────────────────────────────────────────",
    ].join("\n"),
  );

  // Local file copy for end-to-end tests. Hosted platforms (read-only filesystem) use the log only.
  if (process.env.VERCEL) {
    logger().info({ transport: "console" }, "development email logged");
    return;
  }
  const dir = join(process.cwd(), ".dev-mail");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${message.to.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.json`);
  await writeFile(file, JSON.stringify({ ...message, sentAt: new Date().toISOString() }, null, 2));
  logger().info({ transport: "console" }, "development email written");
}
