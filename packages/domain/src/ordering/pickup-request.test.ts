import { describe, expect, it } from "vitest";
import { customerPaymentState, paymentStatusAfterRefunds } from "../payments/payments";
import { checkPickupRequest, type PickupAvailability } from "./pickup";

/* Edge cases of pickup requests and of payment states shown to customers. */

const open: PickupAvailability = {
  reason: null,
  asapAvailable: true,
  asapReadyAt: "2026-10-12T14:12:00.000Z",
  asapUnavailableReason: null,
  slots: [{ startsAt: "2026-10-12T15:00:00.000Z", localDate: "2026-10-12", remaining: 3 }],
  pausedUntil: null,
};

describe("checkPickupRequest", () => {
  it("refuses everything while ordering is unavailable", () => {
    expect(checkPickupRequest({ ...open, reason: "paused" }, { kind: "asap" }, 15)).toEqual({
      ok: false,
      error: "ordering_unavailable",
    });
  });

  it("gives ASAP the next ready time and its slot, or says ASAP isn't possible", () => {
    const ok = checkPickupRequest(open, { kind: "asap" }, 15);
    expect(ok).toMatchObject({ ok: true, scheduledFor: null });
    if (ok.ok) expect(ok.slotStart.toISOString()).toBe("2026-10-12T14:00:00.000Z");
    expect(checkPickupRequest({ ...open, asapAvailable: false }, { kind: "asap" }, 15)).toEqual({
      ok: false,
      error: "asap_unavailable",
    });
  });

  it("accepts only an offered slot for a scheduled pickup", () => {
    const at = new Date("2026-10-12T15:00:00.000Z");
    expect(checkPickupRequest(open, { kind: "scheduled", at }, 15)).toEqual({
      ok: true,
      readyAt: at,
      slotStart: at,
      scheduledFor: at,
    });
    expect(
      checkPickupRequest(open, { kind: "scheduled", at: new Date("2026-10-12T15:15:00.000Z") }, 15),
    ).toEqual({ ok: false, error: "slot_unavailable" });
  });
});

describe("payment states", () => {
  it("follow the refunds", () => {
    expect(paymentStatusAfterRefunds(500, 0)).toBe("succeeded");
    expect(paymentStatusAfterRefunds(500, 200)).toBe("partially_refunded");
    expect(paymentStatusAfterRefunds(500, 500)).toBe("refunded");
  });

  it("show the customer the payment first, then the latest attempt", () => {
    const state = (
      payment: Parameters<typeof customerPaymentState>[0]["payment"],
      attempt: Parameters<typeof customerPaymentState>[0]["latestAttempt"],
    ) => customerPaymentState({ payment, latestAttempt: attempt });
    expect(state({ status: "refunded" }, null)).toBe("refunded");
    expect(state({ status: "partially_refunded" }, null)).toBe("partially_refunded");
    expect(state({ status: "succeeded" }, { status: "succeeded" })).toBe("paid");
    expect(state(null, { status: "processing" })).toBe("processing");
    expect(state(null, { status: "open" })).toBe("pending");
    expect(state(null, { status: "failed" })).toBe("failed");
    expect(state(null, null)).toBe("unpaid");
  });
});
