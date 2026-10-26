import { MIN_CARD_CHARGE_CENTS } from "./payments";

/*
 * Gift cards (Québec): no expiry date and no fees of any kind, so a balance only ever goes down by
 * purchases and back up by refunds. A gift card is a way to pay, not a sale: no GST/QST when it is
 * issued; taxes apply to what it buys. It pays the order total after tax (tip included).
 */

/** Card value staff may issue at once (cents). */
export const GIFT_CARD_MIN_CENTS = 500;
export const GIFT_CARD_MAX_CENTS = 50_000;

/** No 0/O, 1/I/L: codes are read aloud and typed from a printed card. */
export const GIFT_CARD_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const GIFT_CARD_CODE_LENGTH = 16;

export const GIFT_CARD_STATUSES = ["active", "disabled"] as const;
export type GiftCardStatus = (typeof GIFT_CARD_STATUSES)[number];

/**
 * issue (card sold at the counter) · redeem (pays an order or a counter purchase) · release (an
 * unpaid order expired or was cancelled: the hold goes back) · refund (money back to the card) ·
 * adjustment (manager correction).
 */
export const GIFT_CARD_TRANSACTION_KINDS = [
  "issue",
  "redeem",
  "release",
  "refund",
  "adjustment",
] as const;
export type GiftCardTransactionKind = (typeof GIFT_CARD_TRANSACTION_KINDS)[number];

/**
 * The code as stored and compared: upper case, without spaces or dashes. Returns null when it
 * can't be a gift card code (wrong length or a character outside the alphabet).
 */
export function normalizeGiftCardCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== GIFT_CARD_CODE_LENGTH) return null;
  for (const c of code) if (!GIFT_CARD_ALPHABET.includes(c)) return null;
  return code;
}

/** XXXX-XXXX-XXXX-XXXX, for printing and reading aloud. */
export function formatGiftCardCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/** A code from random bytes (one character per byte, rejection-sampled to stay uniform). */
export function giftCardCodeFromBytes(bytes: Uint8Array): string | null {
  const n = GIFT_CARD_ALPHABET.length;
  // Largest multiple of the alphabet size that fits in a byte: higher values would bias the code.
  const limit = Math.floor(256 / n) * n;
  let code = "";
  for (const b of bytes) {
    if (b >= limit) continue;
    code += GIFT_CARD_ALPHABET.charAt(b % n);
    if (code.length === GIFT_CARD_CODE_LENGTH) return code;
  }
  return null;
}

/** How much of `totalCents` a card with `balanceCents` pays: all of it, or the whole balance. */
export function giftCardPayment(totalCents: number, balanceCents: number): number {
  return Math.max(0, Math.min(totalCents, balanceCents));
}

/**
 * How much of an order the card pays at checkout. Like giftCardPayment, except it never leaves a
 * remainder too small to charge by card: it then pays a little less, so the rest can be charged.
 */
export function giftCardPaymentForOrder(totalCents: number, balanceCents: number): number {
  const paid = giftCardPayment(totalCents, balanceCents);
  const due = totalCents - paid;
  if (due > 0 && due < MIN_CARD_CHARGE_CENTS)
    return Math.max(0, totalCents - MIN_CARD_CHARGE_CENTS);
  return paid;
}

/** What an order still needs to be paid by card: its total minus what its gift card paid. */
export function amountDueCents(order: { totalCents: number; giftCardCents: number }): number {
  return order.totalCents - order.giftCardCents;
}
