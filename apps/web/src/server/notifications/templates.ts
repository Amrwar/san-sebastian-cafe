import { createTranslator } from "next-intl";
import { formatCad, cents } from "@ssc/domain";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import { TIME_ZONE } from "@/i18n/routing";
import type { NotificationTemplate, QueuedMessage } from "./outbox";

/*
 * Customer messages in French and English, rendered when sent (from the outbox payload), so the
 * wording can change without touching queued messages. Text lives in messages/*.json
 * (namespace OrderMessages).
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface RenderedPush {
  title: string;
  body: string;
  /** Path to open on tap. */
  url: string;
  tag: string;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

function translator(locale: "fr" | "en"): Translate {
  // Typed loosely: the keys are built from the template name (checked by the catalog tests).
  return createTranslator({
    locale,
    messages: locale === "en" ? en.OrderMessages : fr.OrderMessages,
    timeZone: TIME_ZONE,
  }) as unknown as Translate;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The lines of the message, before layout (shared by the text and HTML versions). */
function lines(message: QueuedMessage) {
  const { locale, template, payload: p } = message;
  const t = translator(locale);
  const money = (v: number) => formatCad(cents(v), locale === "en" ? "en-CA" : "fr-CA");
  const time = p.pickupAt
    ? new Intl.DateTimeFormat(locale === "en" ? "en-CA" : "fr-CA", {
        timeZone: TIME_ZONE,
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(p.pickupAt))
    : null;
  const vars = { number: p.number, total: money(p.totalCents) };
  const body: string[] = [];
  switch (template) {
    case "order_confirmed":
      body.push(t("confirmed.body", vars), t("confirmed.total", vars));
      if (time) body.push(t("confirmed.pickup", { time }));
      break;
    case "order_ready":
      body.push(t("ready.body", vars));
      break;
    case "order_cancelled":
    case "order_rejected":
      body.push(t(`${template === "order_cancelled" ? "cancelled" : "rejected"}.body`, vars));
      if (p.reason) body.push(t("reason", { reason: p.reason }));
      if (p.paid) body.push(t("refundComing", vars));
      break;
    case "order_refunded":
      body.push(t("refunded.body", { ...vars, amount: money(p.refundedCents ?? 0) }));
      break;
  }
  const key = TEMPLATE_KEYS[template];
  return {
    t,
    subject: t(`${key}.subject`, vars),
    body,
    link: p.hasAccount ? t("track") : null,
    footer: p.hasAccount ? t("footerAccount") : t("footerGuest"),
  };
}

const TEMPLATE_KEYS: Record<
  NotificationTemplate,
  "confirmed" | "ready" | "cancelled" | "rejected" | "refunded"
> = {
  order_confirmed: "confirmed",
  order_ready: "ready",
  order_cancelled: "cancelled",
  order_rejected: "rejected",
  order_refunded: "refunded",
};

export function renderEmail(message: QueuedMessage, baseUrl: string): RenderedEmail {
  const { subject, body, link, footer, t } = lines(message);
  const url = `${baseUrl}/${message.locale}/orders/${message.payload.orderId}`;
  const text = [
    t("hello"),
    "",
    ...body,
    ...(link ? ["", t("trackLine", { url })] : []),
    "",
    "—",
    "San Sebastian Café · Montréal",
    footer,
  ].join("\n");
  const html = `<!doctype html><html lang="${message.locale}"><body style="margin:0;background:#f6f0e6;font-family:Arial,Helvetica,sans-serif;color:#38251f">
<div style="max-width:560px;margin:0 auto;padding:24px">
<p style="font-size:20px;font-family:Georgia,serif;margin:0 0 16px">San Sebastian Café</p>
<div style="background:#fbf8f3;border:1px solid #ddd0bd;border-radius:8px;padding:20px">
<p style="margin:0 0 12px">${escape(t("hello"))}</p>
${body.map((l) => `<p style="margin:0 0 12px;line-height:1.5">${escape(l)}</p>`).join("\n")}
${link ? `<p style="margin:20px 0 0"><a href="${escape(url)}" style="display:inline-block;background:#772f3b;color:#fbf8f3;text-decoration:none;padding:10px 18px;border-radius:999px">${escape(link)}</a></p>` : ""}
</div>
<p style="font-size:12px;color:#5c4a43;margin:16px 0 0;line-height:1.5">San Sebastian Café · Montréal<br>${escape(footer)}</p>
</div></body></html>`;
  return { subject, text, html };
}

export function renderPush(message: QueuedMessage): RenderedPush {
  const t = translator(message.locale);
  const key = TEMPLATE_KEYS[message.template];
  const vars = { number: message.payload.number };
  return {
    title: t(`${key}.pushTitle`, vars),
    body: t(`${key}.pushBody`, vars),
    url: `/${message.locale}/orders/${message.payload.orderId}`,
    tag: `order-${message.payload.orderId}`,
  };
}
