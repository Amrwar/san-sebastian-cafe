import { createTranslator } from "next-intl";
import { formatCad, cents } from "@ssc/domain";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import { TIME_ZONE } from "@/i18n/routing";
import type { GiftCardMessage, NotificationTemplate, OrderMessage } from "./outbox";

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
function lines(message: OrderMessage) {
  const { locale, template, payload: p } = message;
  const t = translator(locale);
  const money = (v: number) => formatCad(cents(v), locale === "en" ? "en-CA" : "fr-CA");
  const at = p.deliverBy ?? p.pickupAt;
  const time = at
    ? new Intl.DateTimeFormat(locale === "en" ? "en-CA" : "fr-CA", {
        timeZone: TIME_ZONE,
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(at))
    : null;
  const vars = { number: p.number, total: money(p.totalCents) };
  const body: string[] = [];
  switch (template) {
    case "order_confirmed":
      body.push(t("confirmed.body", vars), t("confirmed.total", vars));
      if (time) body.push(t(p.deliverBy ? "confirmed.delivery" : "confirmed.pickup", { time }));
      break;
    case "order_ready":
      body.push(t("ready.body", vars));
      break;
    case "order_on_the_way":
      body.push(t("onTheWay.body", vars));
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
  "confirmed" | "ready" | "cancelled" | "rejected" | "refunded" | "onTheWay"
> = {
  order_confirmed: "confirmed",
  order_ready: "ready",
  order_cancelled: "cancelled",
  order_rejected: "rejected",
  order_refunded: "refunded",
  order_on_the_way: "onTheWay",
};

export function renderEmail(message: OrderMessage, baseUrl: string): RenderedEmail {
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

export function renderPush(message: OrderMessage): RenderedPush {
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

/**
 * A marketing email: the campaign's text, then what CASL requires in every message: who sends
 * it (name and mailing address), why the person receives it, and a working unsubscribe link.
 */
export function renderMarketingEmail(input: {
  locale: "fr" | "en";
  subject: string;
  body: string;
  sender: { name: string; address: string };
  unsubscribeUrl: string;
  test: boolean;
}): RenderedEmail {
  const t = translator(input.locale);
  const paragraphs = input.body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const footer = [
    `${input.sender.name} · ${input.sender.address}`,
    t("marketing.why"),
    t("marketing.unsubscribe", { url: input.unsubscribeUrl }),
  ];
  const subject = input.test ? `[${t("marketing.test")}] ${input.subject}` : input.subject;
  const text = [...paragraphs, "", "—", ...footer].join("\n\n");
  const html = `<!doctype html><html lang="${input.locale}"><body style="margin:0;background:#f6f0e6;font-family:Arial,Helvetica,sans-serif;color:#38251f">
<div style="max-width:560px;margin:0 auto;padding:24px">
<p style="font-size:20px;font-family:Georgia,serif;margin:0 0 16px">${escape(input.sender.name)}</p>
<div style="background:#fbf8f3;border:1px solid #ddd0bd;border-radius:8px;padding:20px">
${paragraphs.map((p) => `<p style="margin:0 0 12px;line-height:1.5">${escape(p).replace(/\n/g, "<br>")}</p>`).join("\n")}
</div>
<p style="font-size:12px;color:#5c4a43;margin:16px 0 0;line-height:1.5">${escape(input.sender.name)} · ${escape(input.sender.address)}<br>${escape(t("marketing.why"))}<br><a href="${escape(input.unsubscribeUrl)}" style="color:#772f3b">${escape(t("marketing.unsubscribeLink"))}</a></p>
</div></body></html>`;
  return { subject, text, html };
}

/**
 * A gift card bought on the site: the card (with its code) to the recipient, or a receipt without
 * the code to the purchaser. A gift card is not a taxable sale; the receipt says so.
 */
export function renderGiftCardEmail(message: GiftCardMessage, baseUrl: string): RenderedEmail {
  const t = translator(message.locale);
  const p = message.payload;
  const amount = formatCad(cents(p.amountCents), message.locale === "en" ? "en-CA" : "fr-CA");
  const balanceUrl = `${baseUrl}/${message.locale}/gift-cards`;
  const delivery = message.template === "gift_card_delivery";
  const subject = delivery
    ? t("giftCard.deliverySubject", { purchaser: p.purchaserName })
    : t("giftCard.receiptSubject", { recipient: p.recipientName });
  const body = delivery
    ? [
        t("giftCard.deliveryBody", { purchaser: p.purchaserName, amount }),
        ...(p.message ? [t("giftCard.note", { message: p.message })] : []),
        t("giftCard.code", { code: p.code ?? "—" }),
        t("giftCard.howToUse"),
        t("giftCard.balance", { url: balanceUrl }),
      ]
    : [
        t("giftCard.receiptBody", {
          amount,
          last4: p.last4 ?? "",
          recipient: p.recipientName,
          email: p.recipientEmail ?? "",
        }),
        t("giftCard.noTax"),
      ];
  const footer = delivery ? t("giftCard.footerDelivery") : t("giftCard.footerReceipt");
  const greeting = delivery ? t("giftCard.hello", { name: p.recipientName }) : t("hello");
  const text = [greeting, "", ...body, "", "—", "San Sebastian Café · Montréal", footer].join("\n");
  const html = `<!doctype html><html lang="${message.locale}"><body style="margin:0;background:#f6f0e6;font-family:Arial,Helvetica,sans-serif;color:#38251f">
<div style="max-width:560px;margin:0 auto;padding:24px">
<p style="font-size:20px;font-family:Georgia,serif;margin:0 0 16px">San Sebastian Café</p>
<div style="background:#fbf8f3;border:1px solid #ddd0bd;border-radius:8px;padding:20px">
<p style="margin:0 0 12px">${escape(greeting)}</p>
${body.map((l) => `<p style="margin:0 0 12px;line-height:1.5">${escape(l)}</p>`).join("\n")}
</div>
<p style="font-size:12px;color:#5c4a43;margin:16px 0 0;line-height:1.5">San Sebastian Café · Montréal<br>${escape(footer)}</p>
</div></body></html>`;
  return { subject, text, html };
}
