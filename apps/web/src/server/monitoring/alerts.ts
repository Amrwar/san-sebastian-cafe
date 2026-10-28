import "server-only";
import { env } from "../env";
import { logger } from "../logger";

/*
 * Alerts go to one incoming webhook (ALERT_WEBHOOK_URL): Slack and Teams read `text`, Discord
 * reads `content`, so both are sent. Without a webhook an alert is only a log line. Alerts carry
 * routes, counts and scrubbed error texts, never personal data, and sending one never throws.
 */

export type AlertLevel = "fail" | "warn" | "ok";

export interface Alert {
  level: AlertLevel;
  title: string;
  lines?: string[];
}

const ICON: Record<AlertLevel, string> = { fail: "🔴", warn: "🟠", ok: "🟢" };
const SEND_TIMEOUT_MS = 5_000;

/** Removes what could identify someone or unlock something from a free-form error text. */
export function scrub(text: string, max = 300): string {
  // Credentials in URLs first: "user:pass@host" would otherwise half-match as an email.
  const cleaned = text
    .replace(/:\/\/[^/\s:@]+:[^@\s]+@/g, "://[credentials]@")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(sk|pk|rk|whsec)_(live|test)?_?[\w]+/g, "[key]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** The text an alert is posted as, starting with the environment it comes from. */
export function formatAlert(alert: Alert, appEnv: string): string {
  const head = `${ICON[alert.level]} [${appEnv}] ${alert.title}`;
  return [head, ...(alert.lines ?? []).map((l) => `• ${l}`)].join("\n");
}

/** Posts an alert. Returns whether it reached the webhook (false: logged only, or not sent). */
export async function sendAlert(alert: Alert): Promise<boolean> {
  const { ALERT_WEBHOOK_URL: url, APP_ENV } = env();
  const text = formatAlert(alert, APP_ENV);
  const log = logger().child({ alert: alert.title, level: alert.level });
  if (!url) {
    log.warn({ text }, "alert (no ALERT_WEBHOOK_URL set)");
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.error({ status: res.status }, "alert webhook refused the alert");
      return false;
    }
    return true;
  } catch (err) {
    log.error({ err }, "alert webhook unreachable");
    return false;
  }
}

/** The same error from the same place alerts at most once per window, per server instance. */
const ERROR_WINDOW_MS = 10 * 60 * 1000;
const MAX_REMEMBERED = 200;
const recentErrors = new Map<string, number>();

export interface ErrorContext {
  method: string;
  path: string;
  requestId?: string;
  digest?: string;
  source: "api" | "render" | "action" | "route" | "proxy" | "job";
}

/**
 * Reports an unexpected server error: an alert, deduplicated so a failing page under traffic
 * sends one message, not thousands. The full error is already in the logs (with the request id).
 */
export async function reportError(
  error: unknown,
  ctx: ErrorContext,
  now = Date.now(),
): Promise<boolean> {
  const name = error instanceof Error ? error.name : "Error";
  const message = scrub(error instanceof Error ? error.message : String(error));
  // The query string may hold anything; the route is what matters.
  const path = ctx.path.split("?")[0] ?? ctx.path;
  const key = `${ctx.method} ${path} ${name} ${message.slice(0, 120)}`;
  const last = recentErrors.get(key);
  if (last !== undefined && now - last < ERROR_WINDOW_MS) return false;
  recentErrors.set(key, now);
  if (recentErrors.size > MAX_REMEMBERED) {
    for (const [k, at] of recentErrors) if (now - at >= ERROR_WINDOW_MS) recentErrors.delete(k);
    while (recentErrors.size > MAX_REMEMBERED) {
      const oldest = recentErrors.keys().next().value;
      if (oldest === undefined) break;
      recentErrors.delete(oldest);
    }
  }
  return sendAlert({
    level: "fail",
    title: `Server error: ${ctx.method} ${path}`,
    lines: [
      `${name}: ${message || "(no message)"}`,
      `source: ${ctx.source}`,
      ...(ctx.requestId ? [`request id: ${ctx.requestId} (search the logs for it)`] : []),
      ...(ctx.digest ? [`digest: ${ctx.digest}`] : []),
    ],
  });
}

/** Test hook: forget which errors were already reported. */
export function resetReportedErrors(): void {
  recentErrors.clear();
}
