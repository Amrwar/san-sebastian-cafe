import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, type OrderStatus } from "./ordering";
import {
  checkRefund,
  customerCanCancel,
  customerCanModify,
  refundRequiredOnCancel,
} from "./policies";
import {
  allowedTransitions,
  checkTransition,
  stockReturnsOn,
  type TransitionActor,
} from "./state-machine";

const system: TransitionActor = { kind: "system" };
const owner: TransitionActor = { kind: "customer", ownsOrder: true };
const stranger: TransitionActor = { kind: "customer", ownsOrder: false };
const staff: TransitionActor = { kind: "staff", role: "staff" };
const lead: TransitionActor = { kind: "staff", role: "shift_lead" };
const at = (status: OrderStatus, paid = status !== "awaiting_payment") => ({ status, paid });

describe("order state machine", () => {
  it("walks the happy path only in order", () => {
    expect(checkTransition(at("awaiting_payment"), "paid", system)).toEqual({ ok: true });
    expect(checkTransition(at("paid"), "accepted", staff)).toEqual({ ok: true });
    expect(checkTransition(at("accepted"), "in_preparation", staff)).toEqual({ ok: true });
    expect(checkTransition(at("in_preparation"), "ready", staff)).toEqual({ ok: true });
    expect(checkTransition(at("ready"), "completed", staff)).toEqual({ ok: true });
  });

  it.each<[OrderStatus, OrderStatus]>([
    ["awaiting_payment", "accepted"],
    ["paid", "ready"],
    ["accepted", "ready"],
    ["ready", "in_preparation"],
    ["completed", "ready"],
    ["cancelled", "paid"],
    ["expired", "paid"],
    ["rejected", "accepted"],
    ["refunded", "completed"],
  ])("rejects %s → %s as an invalid transition", (from, to) => {
    expect(checkTransition(at(from), to, lead, "a reason")).toEqual({
      ok: false,
      error: "invalid_transition",
    });
  });

  it("never lets customers or staff mark an order paid (only the payment system can)", () => {
    expect(checkTransition(at("awaiting_payment"), "paid", owner)).toEqual({
      ok: false,
      error: "not_permitted",
    });
    expect(
      checkTransition(at("awaiting_payment"), "paid", { kind: "staff", role: "owner" }),
    ).toEqual({
      ok: false,
      error: "not_permitted",
    });
  });

  it("lets only the order's owner cancel as a customer, and only before acceptance", () => {
    expect(checkTransition(at("paid"), "cancelled", owner)).toEqual({ ok: true });
    expect(checkTransition(at("paid"), "cancelled", stranger)).toEqual({
      ok: false,
      error: "not_permitted",
    });
    expect(checkTransition(at("accepted"), "cancelled", owner)).toEqual({
      ok: false,
      error: "not_permitted",
    });
  });

  it("requires shift-lead permission and a reason to cancel an accepted order", () => {
    expect(checkTransition(at("accepted"), "cancelled", staff, "no milk")).toEqual({
      ok: false,
      error: "not_permitted",
    });
    expect(checkTransition(at("accepted"), "cancelled", lead)).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(checkTransition(at("accepted"), "cancelled", lead, "machine broke")).toEqual({
      ok: true,
    });
  });

  it("rejection needs a reason; refunds need a paid order and refund permission", () => {
    expect(checkTransition(at("paid"), "rejected", staff)).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(checkTransition(at("paid"), "rejected", staff, "sold out of oat")).toEqual({ ok: true });
    expect(checkTransition(at("completed"), "refunded", staff, "cold drink")).toEqual({
      ok: false,
      error: "not_permitted",
    });
    expect(checkTransition(at("completed"), "refunded", lead, "cold drink")).toEqual({ ok: true });
    expect(
      checkTransition({ status: "cancelled", paid: false }, "refunded", lead, "x reason"),
    ).toEqual({
      ok: false,
      error: "not_paid",
    });
  });

  it("every status has a defined outcome for every target (no undefined behaviour)", () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const result = checkTransition(at(from), to, lead, "reason text");
        expect(typeof result.ok).toBe("boolean");
      }
    }
  });

  it("lists the actions a role may take (drives staff buttons)", () => {
    expect(allowedTransitions(at("paid"), staff).sort()).toEqual(["accepted", "rejected"]);
    expect(allowedTransitions(at("paid"), lead).sort()).toEqual([
      "accepted",
      "cancelled",
      "rejected",
    ]);
    expect(allowedTransitions(at("completed"), lead).sort()).toEqual([
      "partially_refunded",
      "refunded",
    ]);
    // An order still in the kitchen is cancelled (auto-refund), never refunded mid-preparation.
    expect(checkTransition(at("in_preparation"), "partially_refunded", lead, "cold")).toEqual({
      ok: false,
      error: "invalid_transition",
    });
    expect(allowedTransitions(at("ready"), staff)).toEqual(["completed"]);
    expect(allowedTransitions(at("completed"), staff)).toEqual([]);
  });

  describe("delivery orders", () => {
    const delivery = (status: OrderStatus) => ({ ...at(status), fulfilment: "delivery" as const });

    it("go ready → out for delivery → completed (delivered)", () => {
      expect(checkTransition(delivery("ready"), "out_for_delivery", staff)).toEqual({ ok: true });
      expect(checkTransition(delivery("out_for_delivery"), "completed", staff)).toEqual({
        ok: true,
      });
      expect(allowedTransitions(delivery("ready"), staff)).toEqual(["out_for_delivery"]);
      expect(allowedTransitions(delivery("out_for_delivery"), staff)).toEqual(["completed"]);
    });

    it("can't skip the courier, and pickup orders never go out for delivery", () => {
      expect(checkTransition(delivery("ready"), "completed", staff)).toEqual({
        ok: false,
        error: "invalid_transition",
      });
      expect(checkTransition(at("ready"), "out_for_delivery", staff)).toEqual({
        ok: false,
        error: "invalid_transition",
      });
      expect(
        checkTransition({ ...at("ready"), fulfilment: "pickup" }, "out_for_delivery", lead),
      ).toEqual({ ok: false, error: "invalid_transition" });
    });

    it("a failed delivery is cancelled by a shift lead with a reason", () => {
      expect(
        checkTransition(delivery("out_for_delivery"), "cancelled", staff, "no answer"),
      ).toEqual({ ok: false, error: "not_permitted" });
      expect(checkTransition(delivery("out_for_delivery"), "cancelled", lead)).toEqual({
        ok: false,
        error: "reason_required",
      });
      expect(
        checkTransition(delivery("out_for_delivery"), "cancelled", lead, "nobody at the door"),
      ).toEqual({ ok: true });
      // On its way: refunds wait until it is delivered or cancelled.
      expect(checkTransition(delivery("out_for_delivery"), "refunded", lead, "late")).toMatchObject(
        { ok: false, error: "invalid_transition" },
      );
    });

    it("the food left the kitchen: cancelling on the way returns no stock", () => {
      expect(stockReturnsOn("out_for_delivery", "cancelled")).toBe(false);
    });
  });
});

describe("order policies", () => {
  const now = new Date("2026-10-11T14:00:00Z");

  it("customers can cancel only before the café accepts", () => {
    expect(customerCanCancel("awaiting_payment")).toBe(true);
    expect(customerCanCancel("paid")).toBe(true);
    expect(customerCanCancel("accepted")).toBe(false);
  });

  it("customers can modify a scheduled order until 15 minutes before pickup", () => {
    const in20 = new Date(now.getTime() + 20 * 60_000);
    const in10 = new Date(now.getTime() + 10 * 60_000);
    expect(customerCanModify({ status: "paid", scheduledFor: in20 }, now)).toBe(true);
    expect(customerCanModify({ status: "paid", scheduledFor: in10 }, now)).toBe(false);
    expect(customerCanModify({ status: "paid", scheduledFor: null }, now)).toBe(false);
    expect(customerCanModify({ status: "accepted", scheduledFor: in20 }, now)).toBe(false);
  });

  it("cancelling a paid order refunds what remains; refunds never exceed it", () => {
    expect(refundRequiredOnCancel({ paid: true, totalCents: 1150, refundedCents: 0 })).toBe(1150);
    expect(refundRequiredOnCancel({ paid: false, totalCents: 1150, refundedCents: 0 })).toBe(0);
    const order = { paid: true, totalCents: 1000, refundedCents: 400 };
    expect(checkRefund(order, 600)).toEqual({ ok: true, fullyRefunded: true });
    expect(checkRefund(order, 100)).toEqual({ ok: true, fullyRefunded: false });
    expect(checkRefund(order, 601)).toEqual({ ok: false, error: "amount_invalid" });
    expect(checkRefund(order, 0)).toEqual({ ok: false, error: "amount_invalid" });
    expect(checkRefund({ ...order, paid: false }, 100)).toEqual({ ok: false, error: "not_paid" });
  });
});
