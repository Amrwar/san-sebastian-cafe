import type { NotCountedReason } from "@ssc/domain";

/*
 * Shape of `loyalty_transactions.details`: everything the customer-facing explanation needs, written
 * once with the entry (names are snapshotted so a later menu change doesn't rewrite history).
 */

export interface LocalizedName {
  fr: string;
  en: string;
}

export interface CountedLine {
  orderItemId?: string;
  name: LocalizedName;
  size: LocalizedName;
  quantity: number;
  stamps: number;
}

export interface NotCountedLine {
  name: LocalizedName;
  quantity: number;
  reason: NotCountedReason;
}

export type ReversalCause = "refund" | "cancelled" | "rejected" | "in_store_void";

export interface LedgerDetails {
  orderNumber?: string;
  receiptReference?: string;
  lines?: CountedLine[];
  notCounted?: NotCountedLine[];
  /** reverse: why the stamps were taken back. */
  cause?: ReversalCause | "refund_cover" | "staff";
  /** reverse: stamps that could not be taken back and were written off (forgive policy). */
  forgiven?: number;
  /** redeem: the drink that was free. */
  drink?: LocalizedName;
  /** adjust: what kind of adjustment. */
  action?: "stamps" | "forgive_debt" | "void_reward";
}
