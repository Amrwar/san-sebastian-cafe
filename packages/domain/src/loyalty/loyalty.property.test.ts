import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, type OrderStatus } from "../ordering/ordering";
import {
  allowedTransitions,
  checkTransition,
  type TransitionActor,
} from "../ordering/state-machine";
import { planEarn, planReversal, stampsForPurchase, type EarnLine } from "./loyalty";

/*
 * Property tests for the stamp card and the order lifecycle: stamps are never created or lost by
 * the arithmetic, the free drink never earns, caps hold, and no actor can move an order along a
 * path the rules don't allow.
 */

const line: fc.Arbitrary<EarnLine> = fc.record({
  id: fc.uuid(),
  productId: fc.constantFrom("latte", "espresso", "croissant"),
  variantId: fc.constantFrom("s", "l"),
  quantity: fc.integer({ min: 0, max: 8 }),
  isDrink: fc.boolean(),
  loyaltyQualifying: fc.boolean(),
  paidCents: fc.integer({ min: -100, max: 5000 }),
  freeUnits: fc.integer({ min: 0, max: 2 }),
});
const rules = fc.record({
  excludedProductIds: fc.subarray(["espresso"]),
  excludedVariantIds: fc.subarray(["l"]),
  minPaidCentsPerDrink: fc.integer({ min: 0, max: 300 }),
  maxStampsPerPurchase: fc.option(fc.integer({ min: 1, max: 10 }), { nil: null }),
});

describe("stampsForPurchase (properties)", () => {
  it("accounts for every unit, never earns for free or unpaid drinks, and respects the cap", () => {
    fc.assert(
      fc.property(fc.array(line, { maxLength: 6 }), rules, (lines, r) => {
        const result = stampsForPurchase(lines, r);
        expect(result.total).toBe(result.lines.reduce((s, l) => s + l.stamps, 0));
        if (r.maxStampsPerPurchase !== null)
          expect(result.total).toBeLessThanOrEqual(r.maxStampsPerPurchase);
        lines.forEach((input, i) => {
          const out = result.lines[i]!;
          const units = Math.max(0, input.quantity);
          // Every unit is either a stamp or a reason it wasn't counted.
          expect(out.stamps + out.notCounted.reduce((s, n) => s + n.quantity, 0)).toBe(units);
          const qualifies =
            input.isDrink &&
            input.loyaltyQualifying &&
            !r.excludedProductIds.includes(input.productId) &&
            !r.excludedVariantIds.includes(input.variantId);
          if (!qualifies) expect(out.stamps).toBe(0);
          // The free drink and drinks not paid for don't earn.
          expect(out.stamps).toBeLessThanOrEqual(Math.max(0, units - input.freeUnits));
          expect(out.stamps).toBeLessThanOrEqual(
            Math.floor(Math.max(0, input.paidCents) / Math.max(1, r.minPaidCentsPerDrink)),
          );
          expect(out.stamps).toBeGreaterThanOrEqual(0);
        });
      }),
      { numRuns: 3000 },
    );
  });
});

const balance = fc.record({
  balance: fc.integer({ min: 0, max: 19 }),
  debt: fc.integer({ min: 0, max: 30 }),
});

describe("stamp ledger arithmetic (properties)", () => {
  it("earning settles debt first, then fills cards; no stamp is created or lost", () => {
    fc.assert(
      fc.property(
        balance,
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 2, max: 20 }),
        (s, stamps, per) => {
          const state = { balance: Math.min(s.balance, per - 1), debt: s.debt };
          const r = planEarn(state, stamps, per);
          expect(r.repaid).toBe(Math.min(state.debt, stamps));
          expect(r.balance).toBeGreaterThanOrEqual(0);
          expect(r.balance).toBeLessThan(per);
          expect(state.balance + stamps).toBe(r.repaid + r.rewards * per + r.balance);
          expect(r.debt).toBe(state.debt - r.repaid);
        },
      ),
    );
  });

  it("a reversal takes exactly what it must, from the balance, then unused rewards, then the policy", () => {
    fc.assert(
      fc.property(
        balance,
        fc.integer({ min: 0, max: 40 }),
        fc.array(fc.integer({ min: 2, max: 10 }), { maxLength: 4 }),
        fc.constantFrom("carry_forward" as const, "forgive" as const),
        (state, stamps, rewardCosts, policy) => {
          const r = planReversal(state, stamps, rewardCosts, policy);
          // Everything asked for is accounted for exactly once.
          expect(r.fromBalance + r.debtAdded + r.forgiven).toBe(stamps);
          // Balance math: start + restored - taken = end, never negative.
          expect(state.balance + r.restored - r.fromBalance).toBe(r.balance);
          expect(r.balance).toBeGreaterThanOrEqual(0);
          expect(r.revokedRewards).toBeLessThanOrEqual(rewardCosts.length);
          expect(r.restored).toBe(
            rewardCosts.slice(0, r.revokedRewards).reduce((s, c) => s + c, 0),
          );
          // A reward is only revoked when the balance couldn't cover the reversal.
          if (r.revokedRewards > 0) expect(state.balance).toBeLessThan(stamps);
          if (policy === "forgive") expect(r.debtAdded).toBe(0);
          else expect(r.forgiven).toBe(0);
          expect(r.debt).toBe(state.debt + r.debtAdded);
        },
      ),
    );
  });
});

const actor: fc.Arbitrary<TransitionActor> = fc.oneof(
  fc.constant({ kind: "system" as const }),
  fc.boolean().map((ownsOrder) => ({ kind: "customer" as const, ownsOrder })),
  fc
    .constantFrom("staff" as const, "shift_lead" as const, "manager" as const, "owner" as const)
    .map((role) => ({ kind: "staff" as const, role })),
);

describe("order lifecycle (properties)", () => {
  it("only offers transitions that checkTransition accepts, and nothing leaves an expired order", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ORDER_STATUSES),
        fc.boolean(),
        actor,
        (status: OrderStatus, paid, who) => {
          const allowed = allowedTransitions({ status, paid }, who);
          for (const to of allowed)
            expect(checkTransition({ status, paid }, to, who, "a reason").ok).toBe(true);
          if (status === "expired") expect(allowed).toEqual([]);
          // Customers can never move an order forward in the kitchen.
          if (who.kind === "customer")
            expect(
              allowed.filter((t) =>
                ["accepted", "in_preparation", "ready", "completed"].includes(t),
              ),
            ).toEqual([]);
          // Only the payment system marks an order paid.
          if (who.kind !== "system") expect(allowed).not.toContain("paid");
          // An unpaid order can't be refunded.
          if (!paid)
            expect(allowed.filter((t) => t === "refunded" || t === "partially_refunded")).toEqual(
              [],
            );
        },
      ),
    );
  });

  it("any sequence of accepted moves follows the rules: nothing comes back from a final state", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(actor, fc.constantFrom(...ORDER_STATUSES)), { maxLength: 15 }),
        (moves) => {
          let status: OrderStatus = "awaiting_payment";
          let paid = false;
          const visited: OrderStatus[] = [status];
          for (const [who, to] of moves) {
            if (!checkTransition({ status, paid }, to, who, "a reason").ok) continue;
            status = to;
            if (to === "paid") paid = true;
            visited.push(status);
          }
          // Once expired or refunded, an order stays so.
          for (const final of ["expired", "refunded"] as const) {
            const at = visited.indexOf(final);
            if (at >= 0) expect(visited.slice(at).every((s) => s === final)).toBe(true);
          }
          // Kitchen steps only ever happen after payment.
          const firstPaid = visited.indexOf("paid");
          for (const step of ["accepted", "in_preparation", "ready", "completed"] as const) {
            const at = visited.indexOf(step);
            if (at >= 0) expect(firstPaid).toBeGreaterThanOrEqual(0);
            if (at >= 0) expect(at).toBeGreaterThan(firstPaid);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });
});
