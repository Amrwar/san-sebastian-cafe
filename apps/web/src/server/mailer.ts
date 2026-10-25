import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "./env";
import { logger } from "./logger";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML version (the text version is always sent too). */
  html?: string;
  /** Machine-readable payload for development tooling (e.g. the sign-in code). */
  meta?: Record<string, string>;
}

/**
 * Email boundary.
 * - "console" (development only): prints the message to the server terminal and writes it to
 *   `.dev-mail/` (used by end-to-end tests). Environment validation refuses it when deployed, so
 *   real customers are never left waiting for an email that was only printed.
 * - "smtp": sends through SMTP_URL: Mailpit locally (see docker-compose.yml), or the chosen
 *   provider's SMTP relay when deployed (TLS required there).
 */
export async function sendEmail(message: OutgoingEmail): Promise<void> {
  const { EMAIL_TRANSPORT, EMAIL_FROM } = env();
  if (EMAIL_TRANSPORT === "smtp") {
    await smtp().sendMail({
      from: EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
    logger().info({ transport: "smtp" }, "email sent");
    return;
  }

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
  // The sign-in code keeps one well-known file per address (tests read it); other emails get
  // their own file so they never overwrite a code.
  const base = message.to.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const file = join(dir, message.meta?.otp ? `${base}.json` : `${base}__${Date.now()}.json`);
  await writeFile(file, JSON.stringify({ ...message, sentAt: new Date().toISOString() }, null, 2));
  logger().info({ transport: "console" }, "development email written");
}

let transporter: Transporter | undefined;
function smtp(): Transporter {
  const { SMTP_URL, APP_ENV } = env();
  if (!SMTP_URL) throw new Error("SMTP_URL is not set");
  const deployed = APP_ENV === "staging" || APP_ENV === "production";
  const url = new URL(SMTP_URL);
  const secure = url.protocol === "smtps:";
  transporter ??= nodemailer.createTransport({
    host: url.hostname,
    port: Number(url.port) || (secure ? 465 : 587),
    secure,
    // Deployed: never send unencrypted (smtps://, or STARTTLS required on port 587).
    requireTLS: deployed && !secure,
    ...(url.username
      ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } }
      : {}),
  });
  return transporter;
}
