import { describe, expect, it } from "vitest";
import type { OrderMessage } from "./outbox";
import { renderEmail, renderPush } from "./templates";

/** French number and time formats use non-breaking spaces; compare with plain ones. */
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

const message = (overrides: Partial<OrderMessage> = {}): OrderMessage => ({
  id: "m1",
  channel: "email",
  template: "order_confirmed",
  recipient: "robin@example.test",
  locale: "fr",
  payload: {
    orderId: "o-1",
    number: "1012-007",
    totalCents: 575,
    // Monday 2026-10-12, 10:30 in Montréal.
    pickupAt: "2026-10-12T14:30:00.000Z",
    hasAccount: true,
  },
  ...overrides,
});

describe("order emails", () => {
  it("confirms an order in French, with the pickup time in Montréal and a tracking link", () => {
    const email = renderEmail(message(), "https://cafe.example");
    expect(email.subject).toBe("Commande 1012-007 confirmée");
    expect(plain(email.text)).toContain("Total payé : 5,75 $.");
    expect(plain(email.text)).toContain("lundi 10 h 30");
    expect(plain(email.text)).toContain("Suivre ma commande : https://cafe.example/fr/orders/o-1");
    expect(email.html).toContain('href="https://cafe.example/fr/orders/o-1"');
    expect(email.html).toContain('lang="fr"');
  });

  it("writes in English when the order was placed in English", () => {
    const email = renderEmail(message({ locale: "en", template: "order_ready" }), "https://c.ex");
    expect(email.subject).toBe("Your order 1012-007 is ready");
    expect(plain(email.text)).toContain("waiting for you at the counter");
  });

  it("gives guests no account link, and says why they received it", () => {
    const base = message();
    const email = renderEmail(
      { ...base, payload: { ...base.payload, hasAccount: false } },
      "https://cafe.example",
    );
    expect(plain(email.text)).not.toContain("/orders/");
    expect(plain(email.text)).toContain("parce que vous avez passé cette commande");
  });

  it("explains a cancellation with its reason and the refund, and escapes the reason in HTML", () => {
    const base = message({ template: "order_cancelled" });
    const email = renderEmail(
      { ...base, payload: { ...base.payload, reason: "Machine <en panne>", paid: true } },
      "https://cafe.example",
    );
    expect(plain(email.text)).toContain("Motif : Machine <en panne>");
    expect(plain(email.text)).toContain("Le montant payé (5,75 $) vous sera remboursé");
    expect(email.html).toContain("Machine &#60;en panne&#62;");
    expect(email.html).not.toContain("<en panne>");
  });

  it("states the amount of a refund", () => {
    const base = message({ template: "order_refunded", locale: "en" });
    const email = renderEmail(
      { ...base, payload: { ...base.payload, refundedCents: 250 } },
      "https://cafe.example",
    );
    expect(plain(email.text)).toContain("We refunded $2.50 for order 1012-007");
  });
});

describe("push notices", () => {
  it("are short and open the order", () => {
    expect(renderPush(message({ channel: "push", template: "order_ready" }))).toEqual({
      title: "Commande 1012-007 prête",
      body: "Elle vous attend au comptoir.",
      url: "/fr/orders/o-1",
      tag: "order-o-1",
    });
  });
});
