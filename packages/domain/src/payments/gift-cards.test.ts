import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  formatGiftCardCode,
  GIFT_CARD_ALPHABET,
  GIFT_CARD_CODE_LENGTH,
  giftCardCodeFromBytes,
  giftCardPayment,
  giftCardPaymentForOrder,
  normalizeGiftCardCode,
} from "./gift-cards";

/* Gift card codes and how much of an order a card pays. */

describe("gift card codes", () => {
  it("accept what a person types: lower case, spaces and dashes; refuse anything else", () => {
    expect(normalizeGiftCardCode("abcd-efgh 2345 6789")).toBe("ABCDEFGH23456789");
    expect(normalizeGiftCardCode("ABCD-EFGH-2345-678")).toBeNull(); // too short
    expect(normalizeGiftCardCode("ABCD-EFGH-2345-678O")).toBeNull(); // O is never used
    expect(normalizeGiftCardCode("ABCD-EFGH-2345-6781")).toBeNull(); // nor 1
    expect(formatGiftCardCode("ABCDEFGH23456789")).toBe("ABCD-EFGH-2345-6789");
    expect(formatGiftCardCode("")).toBe("");
  });

  it("are built from random bytes using only the alphabet, and round-trip (properties)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 64, maxLength: 64 }), (bytes) => {
        const code = giftCardCodeFromBytes(bytes);
        // 64 bytes leave plenty after rejecting the few biased values.
        expect(code).toHaveLength(GIFT_CARD_CODE_LENGTH);
        for (const c of code!) expect(GIFT_CARD_ALPHABET).toContain(c);
        expect(normalizeGiftCardCode(formatGiftCardCode(code!).toLowerCase())).toBe(code);
      }),
    );
  });

  it("skip byte values that would make some characters likelier than others", () => {
    const limit = Math.floor(256 / GIFT_CARD_ALPHABET.length) * GIFT_CARD_ALPHABET.length;
    expect(giftCardCodeFromBytes(new Uint8Array(32).fill(limit))).toBeNull();
    expect(giftCardCodeFromBytes(new Uint8Array(8))).toBeNull(); // not enough bytes
  });
});

describe("paying with a gift card", () => {
  it("pays the whole total when the balance allows, otherwise the whole balance", () => {
    expect(giftCardPayment(1500, 5000)).toBe(1500);
    expect(giftCardPayment(1500, 1000)).toBe(1000);
    expect(giftCardPayment(1500, 0)).toBe(0);
    fc.assert(
      fc.property(fc.nat(100_000), fc.nat(100_000), (total, balance) => {
        const paid = giftCardPayment(total, balance);
        expect(paid).toBeGreaterThanOrEqual(0);
        expect(paid).toBeLessThanOrEqual(Math.min(total, balance));
        expect(paid === total || paid === balance).toBe(true);
      }),
    );
  });

  it("at checkout, never leaves less than the card minimum to charge", () => {
    expect(giftCardPaymentForOrder(1500, 1480)).toBe(1450); // 0,50 $ left to charge, not 0,20 $
    expect(giftCardPaymentForOrder(1500, 5000)).toBe(1500); // fully paid: nothing to charge
    expect(giftCardPaymentForOrder(1500, 1000)).toBe(1000);
    expect(giftCardPaymentForOrder(30, 20)).toBe(0); // too small either way: the card isn't used
    fc.assert(
      fc.property(fc.nat(100_000), fc.nat(100_000), (total, balance) => {
        const paid = giftCardPaymentForOrder(total, balance);
        const due = total - paid;
        expect(paid).toBeGreaterThanOrEqual(0);
        expect(paid).toBeLessThanOrEqual(Math.min(total, balance));
        if (paid > 0) expect(due === 0 || due >= 50).toBe(true);
      }),
    );
  });
});
