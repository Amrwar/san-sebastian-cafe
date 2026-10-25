import "server-only";
import pino, { type DestinationStream, type Logger } from "pino";
import { env } from "./env";

/**
 * Structured JSON logger. Personal data and secrets are redacted by key wherever they appear
 * (two levels deep). Log identifiers (user id, order id, request id), never contact details.
 */
export const REDACTED_KEYS = [
  "email",
  "phone",
  "otp",
  "code",
  "token",
  "password",
  "secret",
  "authorization",
  "cookie",
  "address",
  "deliveryAddress",
  "guestEmail",
  "guestName",
  "guestPhone",
  "confirmEmail",
  "contact",
  "subjectContact",
  "ipAddress",
  "userAgent",
];

/** The app logger; tests pass their own `destination` to read what would be written. */
export function createLogger(
  options: { level?: string; destination?: DestinationStream } = {},
): Logger {
  const config = {
    level: options.level ?? env().LOG_LEVEL,
    base: { service: "web", env: env().APP_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACTED_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
      censor: "[redacted]",
    },
    formatters: { level: (label: string) => ({ level: label }) },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}

const globalForLogger = globalThis as unknown as { __sscLogger?: Logger };

export function logger(): Logger {
  globalForLogger.__sscLogger ??= createLogger();
  return globalForLogger.__sscLogger;
}
