import type { PromotionKind, PromotionScope } from "../promotions/promotions";
import {
  type ConfiguredProduct,
  type LineIssue,
  unitPriceCents,
  validateSelection,
} from "../catalog/configuration";
import { stockShortfalls } from "../catalog/stock";
import { isRewardEligible, rewardValueCents } from "../loyalty/loyalty";
import { applyRatePpm, cents } from "../shared/money";
import { computeTaxes, isTaxable } from "./tax";

/*
 * Server-authoritative quote. Clients send ids and quantities only; every amount below is
 * computed here from current menu configuration. The same function prices the cart, the
 * checkout summary and (Phase 6) the order snapshot, so they can never disagree.
 */

export interface QuoteLineInput {
  lineId: string;
  productId: string;
  variantId: string;
  optionIds: string[];
  quantity: number;
}

export interface PromotionRule {
  id: string;
  code: string | null;
  kind: PromotionKind;
  /** Basis points for percent_off, cents for amount_off. */
  value: number;
  scope: PromotionScope;
  targetIds: string[];
  minSubtotalCents: number;
  startsAt: Date;
  endsAt: Date | null;
  isActive: boolean;
  stackableWithRewards: boolean;
}

export interface RewardInput {
  rewardId: string;
  /** Maximum value of the free drink; null = no cap. */
  valueCapCents: number | null;
  /** Line to apply the reward to; defaults to the most expensive eligible line. */
  lineId?: string | undefined;
  /** Paid extras on the free drink are free too (snapshotted on the reward). Default false. */
  coversModifiers?: boolean | undefined;
  /** Program exclusions for the free drink (current loyalty rules). */
  excludedProductIds?: readonly string[] | undefined;
  excludedVariantIds?: readonly string[] | undefined;
}

export type FulfilmentInput =
  { method: "pickup" } | { method: "delivery"; feeCents: number; minimumOrderCents: number };

export type TipInput =
  { kind: "none" } | { kind: "percent"; basisPoints: number } | { kind: "amount"; cents: number };

/** Tip suggestions (basis points of the pre-tax amount). Owner-configurable (decision D13). */
export const TIP_PRESETS_BPS = [1000, 1500, 1800] as const;
export const MAX_TIP_CENTS = 10_000;

export interface QuoteInput {
  lines: QuoteLineInput[];
  catalog: ReadonlyMap<string, ConfiguredProduct>;
  promotion?: PromotionRule | null | undefined;
  /** True when a promo code was entered but no promotion matched it. */
  promotionCodeNotFound?: boolean | undefined;
  reward?: RewardInput | null | undefined;
  fulfilment: FulfilmentInput;
  tip: TipInput;
  now: Date;
}

export interface QuotedLine extends QuoteLineInput {
  unitPriceCents: number;
  lineTotalCents: number;
  discountCents: number;
  rewardDiscountCents: number;
  issues: LineIssue[];
  valid: boolean;
}

export type PromotionStatus =
  | "applied"
  | "not_found"
  | "inactive"
  | "not_started"
  | "expired"
  | "below_minimum"
  | "no_eligible_items"
  | "not_stackable_with_reward";

export type QuoteRewardStatus = "applied" | "no_eligible_item";

export type QuoteIssueCode =
  "cart_empty" | "invalid_lines" | "delivery_minimum_not_met" | "tip_invalid";

export interface Quote {
  lines: QuotedLine[];
  subtotalCents: number;
  discountCents: number;
  rewardDiscountCents: number;
  deliveryFeeCents: number;
  taxableCents: number;
  gstCents: number;
  qstCents: number;
  gstRatePpm: number;
  qstRatePpm: number;
  tipBaseCents: number;
  tipCents: number;
  tipSuggestions: Array<{ basisPoints: number; cents: number }>;
  totalCents: number;
  promotion: { id: string | null; status: PromotionStatus; discountCents: number } | null;
  reward: {
    rewardId: string;
    status: QuoteRewardStatus;
    lineId: string | null;
    discountCents: number;
  } | null;
  issues: QuoteIssueCode[];
  /** Every line valid and no blocking issue. Payment availability is checked separately. */
  canCheckout: boolean;
}

/** Splits `amount` across weights proportionally (largest-remainder, exact sum). */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const floors = raw.map(Math.floor);
  let remainder = amount - floors.reduce((s, f) => s + f, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder--;
  }
  return floors;
}

function percentOf(amount: number, basisPoints: number): number {
  return applyRatePpm(cents(amount), basisPoints * 100);
}

function promotionWindowStatus(p: PromotionRule, now: Date): PromotionStatus | null {
  if (!p.isActive) return "inactive";
  if (now < p.startsAt) return "not_started";
  if (p.endsAt && now >= p.endsAt) return "expired";
  return null;
}

export function computeQuote(input: QuoteInput): Quote {
  const { catalog, now } = input;

  // 1. Price and validate each line.
  const checked: QuotedLine[] = input.lines.map((line) => {
    const product = catalog.get(line.productId);
    if (!product) {
      return {
        ...line,
        unitPriceCents: 0,
        lineTotalCents: 0,
        discountCents: 0,
        rewardDiscountCents: 0,
        issues: [{ code: "product_unavailable" }],
        valid: false,
      };
    }
    const selection = { variantId: line.variantId, optionIds: line.optionIds };
    const issues = validateSelection(product, selection, line.quantity);
    const unit = unitPriceCents(product, selection);
    const valid = issues.length === 0;
    return {
      ...line,
      optionIds: [...new Set(line.optionIds)],
      unitPriceCents: unit,
      lineTotalCents: valid ? unit * line.quantity : 0,
      discountCents: 0,
      rewardDiscountCents: 0,
      issues,
      valid,
    };
  });
  // Tracked stock is shared by the whole cart: a line beyond what's left can't be ordered.
  const shortfalls = stockShortfalls(
    checked.map((l) => ({ ...l, quantity: l.valid ? l.quantity : 0 })),
    catalog,
  );
  const lines = checked.map((l, i): QuotedLine => {
    const stockIssues = shortfalls[i] ?? [];
    if (stockIssues.length === 0) return l;
    return { ...l, lineTotalCents: 0, issues: [...l.issues, ...stockIssues], valid: false };
  });
  const validLines = lines.filter((l) => l.valid);
  const subtotalCents = validLines.reduce((s, l) => s + l.lineTotalCents, 0);

  // 2. Reward: one free eligible drink (size price, extras only if covered, up to the cap).
  let reward: Quote["reward"] = null;
  if (input.reward) {
    const rules = {
      rewardExcludedProductIds: input.reward.excludedProductIds ?? [],
      rewardExcludedVariantIds: input.reward.excludedVariantIds ?? [],
    };
    const eligible = validLines.filter((l) => {
      const p = catalog.get(l.productId);
      return p !== undefined && isRewardEligible(p, l.variantId, rules);
    });
    const target =
      eligible.find((l) => l.lineId === input.reward?.lineId) ??
      [...eligible].sort((a, b) => b.unitPriceCents - a.unitPriceCents)[0];
    if (target) {
      const variant = catalog
        .get(target.productId)
        ?.variants.find((v) => v.id === target.variantId);
      const discount = rewardValueCents(variant?.priceCents ?? 0, target.unitPriceCents, {
        valueCapCents: input.reward.valueCapCents,
        coversModifiers: input.reward.coversModifiers ?? false,
      });
      target.rewardDiscountCents = discount;
      reward = {
        rewardId: input.reward.rewardId,
        status: "applied",
        lineId: target.lineId,
        discountCents: discount,
      };
    } else {
      reward = {
        rewardId: input.reward.rewardId,
        status: "no_eligible_item",
        lineId: null,
        discountCents: 0,
      };
    }
  }
  const rewardDiscountCents = reward?.discountCents ?? 0;

  // 3. Promotion.
  let promotion: Quote["promotion"] = null;
  if (input.promotionCodeNotFound) {
    promotion = { id: null, status: "not_found", discountCents: 0 };
  } else if (input.promotion) {
    const p = input.promotion;
    const windowStatus = promotionWindowStatus(p, now);
    const eligible = validLines.filter((l) => {
      if (p.scope === "order") return true;
      if (p.scope === "product") return p.targetIds.includes(l.productId);
      const categoryId = catalog.get(l.productId)?.categoryId;
      return categoryId !== undefined && p.targetIds.includes(categoryId);
    });
    const eligibleBase = eligible.map((l) => l.lineTotalCents - l.rewardDiscountCents);
    const eligibleTotal = eligibleBase.reduce((s, v) => s + v, 0);
    let status: PromotionStatus = "applied";
    if (windowStatus) status = windowStatus;
    else if (reward?.status === "applied" && !p.stackableWithRewards)
      status = "not_stackable_with_reward";
    else if (subtotalCents - rewardDiscountCents < p.minSubtotalCents) status = "below_minimum";
    else if (eligibleTotal <= 0) status = "no_eligible_items";

    let discount = 0;
    if (status === "applied") {
      discount = Math.min(
        eligibleTotal,
        p.kind === "percent_off" ? percentOf(eligibleTotal, p.value) : p.value,
      );
      allocate(discount, eligibleBase).forEach((share, i) => {
        const line = eligible[i];
        if (line) line.discountCents = share;
      });
    }
    promotion = { id: p.id, status, discountCents: discount };
  }
  const discountCents = promotion?.discountCents ?? 0;

  // 4. Delivery, tips, taxes, total.
  const issues: QuoteIssueCode[] = [];
  if (lines.length === 0) issues.push("cart_empty");
  if (lines.some((l) => !l.valid)) issues.push("invalid_lines");

  const preTaxGoods = subtotalCents - discountCents - rewardDiscountCents;
  let deliveryFeeCents = 0;
  if (input.fulfilment.method === "delivery") {
    deliveryFeeCents = input.fulfilment.feeCents;
    if (preTaxGoods < input.fulfilment.minimumOrderCents) issues.push("delivery_minimum_not_met");
  }

  const tipBaseCents = Math.max(0, preTaxGoods);
  const tipSuggestions = TIP_PRESETS_BPS.map((bps) => ({
    basisPoints: bps,
    cents: percentOf(tipBaseCents, bps),
  }));
  let tipCents = 0;
  const tip = input.tip;
  if (tip.kind === "percent") {
    const preset = tipSuggestions.find((s) => s.basisPoints === tip.basisPoints);
    if (preset) tipCents = preset.cents;
    else issues.push("tip_invalid");
  } else if (input.tip.kind === "amount") {
    if (
      Number.isInteger(input.tip.cents) &&
      input.tip.cents >= 0 &&
      input.tip.cents <= MAX_TIP_CENTS
    ) {
      tipCents = input.tip.cents;
    } else issues.push("tip_invalid");
  }

  // Delivery fees are treated as taxable supplies (⚖ confirm with accountant). Tips are not taxed.
  const taxableCents =
    validLines
      .filter((l) => isTaxable(catalog.get(l.productId)?.taxCategory ?? "standard"))
      .reduce((s, l) => s + l.lineTotalCents - l.discountCents - l.rewardDiscountCents, 0) +
    deliveryFeeCents;
  const taxes = computeTaxes(taxableCents, now);

  const totalCents =
    subtotalCents -
    discountCents -
    rewardDiscountCents +
    deliveryFeeCents +
    taxes.gstCents +
    taxes.qstCents +
    tipCents;

  return {
    lines,
    subtotalCents,
    discountCents,
    rewardDiscountCents,
    deliveryFeeCents,
    taxableCents,
    gstCents: taxes.gstCents,
    qstCents: taxes.qstCents,
    gstRatePpm: taxes.gstRatePpm,
    qstRatePpm: taxes.qstRatePpm,
    tipBaseCents,
    tipCents,
    tipSuggestions,
    totalCents,
    promotion,
    reward,
    issues,
    canCheckout: issues.length === 0,
  };
}
