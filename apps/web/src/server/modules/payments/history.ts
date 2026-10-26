import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  orders,
  paymentAttempts,
  paymentDisputes,
  payments,
  refunds,
  users,
  type Database,
} from "@ssc/db";
import {
  customerPaymentState,
  refundableCents,
  type CustomerPaymentState,
  type OrderStatus,
  type PaymentProviderName,
  type PaymentReconciliation,
  type PaymentStatus,
  type RefundStatus,
} from "@ssc/domain";
import { authorize, type Actor } from "../../authz";

/*
 * Read models for payments: what the customer sees on an order and in their history, and what a
 * shift lead sees when handling refunds and disputes. Only display-safe fields are returned
 * (card brand + last 4 digits at most).
 */

export interface RefundLine {
  id: string;
  amountCents: number;
  status: RefundStatus;
  createdAt: string;
  settledAt: string | null;
  automatic: boolean;
}

export interface OrderPaymentSummary {
  state: CustomerPaymentState;
  paid: {
    amountCents: number;
    refundedCents: number;
    cardBrand: string | null;
    cardLast4: string | null;
    paidAt: string | null;
    provider: PaymentProviderName;
  } | null;
  refunds: RefundLine[];
  /** Money received that couldn't pay for the order (late or duplicate) — returned automatically. */
  returnedPayments: Array<{ amountCents: number; refundStatus: RefundStatus | null }>;
}

export async function orderPaymentSummary(
  db: Database,
  orderId: string,
): Promise<OrderPaymentSummary> {
  const [paymentRows, refundRows, attempt] = await Promise.all([
    db.select().from(payments).where(eq(payments.orderId, orderId)),
    db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(refunds.createdAt),
    db.query.paymentAttempts.findFirst({
      where: eq(paymentAttempts.orderId, orderId),
      orderBy: desc(paymentAttempts.createdAt),
    }),
  ]);
  const primary = paymentRows.find((p) => p.reconciliation === null && p.status !== "failed");
  const returned = paymentRows.filter((p) => p.reconciliation !== null);
  return {
    state: customerPaymentState({ payment: primary ?? null, latestAttempt: attempt ?? null }),
    paid: primary
      ? {
          amountCents: primary.amountCents,
          refundedCents: primary.refundedCents,
          cardBrand: primary.cardBrand,
          cardLast4: primary.cardLast4,
          paidAt: primary.succeededAt?.toISOString() ?? null,
          provider: primary.provider,
        }
      : null,
    refunds: refundRows
      .filter((r) => r.paymentId === primary?.id)
      .map((r) => ({
        id: r.id,
        amountCents: r.amountCents,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        settledAt: r.settledAt?.toISOString() ?? null,
        automatic: r.source !== "staff",
      })),
    returnedPayments: returned.map((p) => ({
      amountCents: p.amountCents,
      refundStatus: refundRows.find((r) => r.paymentId === p.id)?.status ?? null,
    })),
  };
}

export interface PaymentHistoryEntry {
  orderId: string;
  orderNumber: string;
  kind: "payment" | "refund";
  amountCents: number;
  status: PaymentStatus | RefundStatus;
  at: string;
  cardBrand: string | null;
  cardLast4: string | null;
}

/** The signed-in customer's payments and refunds, newest first. */
export async function customerPaymentHistory(
  db: Database,
  actor: Actor | null,
): Promise<PaymentHistoryEntry[]> {
  authorize(actor, "orders:read_own");
  const [paid, refunded] = await Promise.all([
    db
      .select({ payment: payments, number: orders.number })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(eq(orders.userId, actor.userId))
      .orderBy(desc(payments.createdAt))
      .limit(100),
    db
      .select({ refund: refunds, number: orders.number })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(eq(orders.userId, actor.userId))
      .orderBy(desc(refunds.createdAt))
      .limit(100),
  ]);
  const entries: PaymentHistoryEntry[] = [
    ...paid.map(({ payment: p, number }) => ({
      orderId: p.orderId,
      orderNumber: number,
      kind: "payment" as const,
      amountCents: p.amountCents,
      status: p.status,
      at: (p.succeededAt ?? p.createdAt).toISOString(),
      cardBrand: p.cardBrand,
      cardLast4: p.cardLast4,
    })),
    ...refunded.map(({ refund: r, number }) => ({
      orderId: r.orderId,
      orderNumber: number,
      kind: "refund" as const,
      amountCents: r.amountCents,
      status: r.status,
      at: r.createdAt.toISOString(),
      cardBrand: null,
      cardLast4: null,
    })),
  ];
  return entries.sort((a, b) => (a.at < b.at ? 1 : -1));
}

export interface StaffOrderPayments {
  order: {
    id: string;
    number: string;
    status: OrderStatus;
    totalCents: number;
    /** Paid with a gift card, and how much of that can still go back to the card. */
    giftCardCents: number;
    giftCardRefundableCents: number;
    customerName: string | null;
    createdAt: string;
  };
  payments: Array<{
    id: string;
    provider: PaymentProviderName;
    providerPaymentId: string;
    status: PaymentStatus;
    amountCents: number;
    refundedCents: number;
    refundableCents: number;
    reconciliation: PaymentReconciliation | null;
    cardBrand: string | null;
    cardLast4: string | null;
    paidAt: string | null;
  }>;
  refunds: Array<{
    id: string;
    amountCents: number;
    status: RefundStatus;
    reason: string;
    source: string;
    requestedBy: string | null;
    failureReason: string | null;
    createdAt: string;
    settledAt: string | null;
  }>;
  disputes: Array<{
    id: string;
    amountCents: number;
    reason: string | null;
    status: string;
    evidenceDueBy: string | null;
  }>;
  attempts: Array<{ id: string; status: string; createdAt: string; lastError: string | null }>;
}

/** Everything about one order's money, for a shift lead (refund screen). */
export async function staffOrderPayments(
  db: Database,
  actor: Actor | null,
  orderNumber: string,
): Promise<StaffOrderPayments | null> {
  authorize(actor, "orders:refund");
  const order = await db.query.orders.findFirst({ where: eq(orders.number, orderNumber.trim()) });
  if (!order) return null;
  const [paymentRows, refundRows, disputes, attempts] = await Promise.all([
    db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(payments.createdAt),
    db
      .select({ refund: refunds, email: users.email, name: users.name })
      .from(refunds)
      .leftJoin(users, eq(users.id, refunds.requestedByUserId))
      .where(eq(refunds.orderId, order.id))
      .orderBy(refunds.createdAt),
    db.select().from(paymentDisputes).where(eq(paymentDisputes.orderId, order.id)),
    db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, order.id))
      .orderBy(paymentAttempts.createdAt),
  ]);
  return {
    order: {
      id: order.id,
      number: order.number,
      status: order.status,
      totalCents: order.totalCents,
      giftCardCents: order.giftCardCents,
      giftCardRefundableCents: Math.max(
        0,
        order.giftCardCents -
          refundRows
            .filter((r) => r.refund.giftCardId !== null && r.refund.status === "succeeded")
            .reduce((sum, r) => sum + r.refund.amountCents, 0),
      ),
      customerName: order.guestName,
      createdAt: order.createdAt.toISOString(),
    },
    payments: paymentRows.map((p) => ({
      id: p.id,
      provider: p.provider,
      providerPaymentId: p.providerPaymentId,
      status: p.status,
      amountCents: p.amountCents,
      refundedCents: p.refundedCents,
      refundableCents: refundableCents(
        p.amountCents,
        refundRows.filter((r) => r.refund.paymentId === p.id).map((r) => r.refund),
      ),
      reconciliation: p.reconciliation as PaymentReconciliation | null,
      cardBrand: p.cardBrand,
      cardLast4: p.cardLast4,
      paidAt: p.succeededAt?.toISOString() ?? null,
    })),
    refunds: refundRows.map(({ refund: r, email, name }) => ({
      id: r.id,
      amountCents: r.amountCents,
      status: r.status,
      reason: r.reason,
      source: r.source,
      requestedBy: name ?? email ?? null,
      failureReason: r.failureReason,
      createdAt: r.createdAt.toISOString(),
      settledAt: r.settledAt?.toISOString() ?? null,
    })),
    disputes: disputes.map((d) => ({
      id: d.providerDisputeId,
      amountCents: d.amountCents,
      reason: d.reason,
      status: d.status,
      evidenceDueBy: d.evidenceDueBy?.toISOString() ?? null,
    })),
    attempts: attempts.map((a) => ({
      id: a.id,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
      lastError: a.lastError,
    })),
  };
}

export interface AttentionItem {
  kind: "refund_failed" | "refund_pending" | "dispute_open" | "returned_payment";
  orderId: string | null;
  orderNumber: string | null;
  amountCents: number;
  at: string;
  detail: string | null;
}

const OPEN_DISPUTE = [
  "needs_response",
  "under_review",
  "warning_needs_response",
  "warning_under_review",
];

/** Money matters a shift lead should look at: failed/stuck refunds, open disputes, returned payments. */
export async function paymentsNeedingAttention(
  db: Database,
  actor: Actor | null,
): Promise<AttentionItem[]> {
  authorize(actor, "orders:refund");
  const stuckBefore = new Date(Date.now() - 30 * 60_000);
  const [refundRows, disputeRows, returned] = await Promise.all([
    db
      .select({ refund: refunds, number: orders.number })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(inArray(refunds.status, ["failed", "pending"]))
      .orderBy(desc(refunds.createdAt))
      .limit(50),
    db
      .select({ dispute: paymentDisputes, number: orders.number })
      .from(paymentDisputes)
      .leftJoin(orders, eq(orders.id, paymentDisputes.orderId))
      .where(inArray(paymentDisputes.status, OPEN_DISPUTE))
      .limit(50),
    db
      .select({ payment: payments, number: orders.number })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(and(isNotNull(payments.reconciliation), ne(payments.status, "refunded")))
      .limit(50),
  ]);
  const items: AttentionItem[] = [
    ...refundRows
      .filter(({ refund }) => refund.status === "failed" || refund.createdAt < stuckBefore)
      .map(({ refund, number }) => ({
        kind: refund.status === "failed" ? ("refund_failed" as const) : ("refund_pending" as const),
        orderId: refund.orderId,
        orderNumber: number,
        amountCents: refund.amountCents,
        at: refund.createdAt.toISOString(),
        detail: refund.failureReason,
      })),
    ...disputeRows.map(({ dispute, number }) => ({
      kind: "dispute_open" as const,
      orderId: dispute.orderId,
      orderNumber: number,
      amountCents: dispute.amountCents,
      at: (dispute.evidenceDueBy ?? dispute.createdAt).toISOString(),
      detail: dispute.reason,
    })),
    ...returned.map(({ payment, number }) => ({
      kind: "returned_payment" as const,
      orderId: payment.orderId,
      orderNumber: number,
      amountCents: payment.amountCents,
      at: payment.createdAt.toISOString(),
      detail: payment.reconciliation,
    })),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : -1));
}
