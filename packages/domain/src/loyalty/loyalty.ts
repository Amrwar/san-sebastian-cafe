/** Default program: 5 qualifying paid drinks earn 1 free eligible drink (configurable, versioned). */
export const DEFAULT_STAMPS_PER_REWARD = 5;

/*
 * Ledger entry kinds. `stamps` is the change to the stamp balance, `debtDelta` the change to the
 * stamps owed after a refund that could not be taken back (see REFUND_SHORTFALL_POLICIES).
 *   earn      +stamps      qualifying drinks bought (online order or in-store visit)
 *   reverse   −stamps/+debt stamps taken back after a refund, cancellation or voided visit
 *   convert   −N           a full card became a reward
 *   adjust    ±stamps/−debt authorized manual adjustment (reason required)
 *   revoke    +N or 0      a reward withdrawn: its N stamps return to cover a reversal, or 0 when
 *                          voided by staff
 *   repay     −stamps/−debt new stamps used to settle stamps owed
 *   redeem    0            a reward was used for a free drink
 *   reinstate 0            a used reward was given back (order cancelled or refunded)
 *   expire    0            a reward reached its expiry date (only if the program sets one)
 */
export const LOYALTY_TRANSACTION_KINDS = [
  "earn",
  "reverse",
  "convert",
  "adjust",
  "revoke",
  "repay",
  "redeem",
  "reinstate",
  "expire",
] as const;
export type LoyaltyTransactionKind = (typeof LOYALTY_TRANSACTION_KINDS)[number];

export const LOYALTY_SOURCES = ["online_order", "in_store", "staff", "system"] as const;
export type LoyaltySource = (typeof LOYALTY_SOURCES)[number];

export const REWARD_STATUSES = ["available", "reserved", "redeemed", "revoked", "expired"] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];

export const REDEMPTION_STATUSES = ["reserved", "committed", "released"] as const;
export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];

/** When a paid order's drinks earn their stamps. */
export const EARN_TRIGGERS = ["paid", "completed"] as const;
export type EarnTrigger = (typeof EARN_TRIGGERS)[number];

/**
 * What happens when a refund takes back more stamps than the customer still has (because they were
 * already turned into a reward that was used):
 *   carry_forward — the shortfall is recorded as stamps owed; the next stamps earned settle it
 *                   first. The balance never goes negative and nothing is deleted.
 *   forgive       — the shortfall is written off, recorded on the reversal entry.
 */
export const REFUND_SHORTFALL_POLICIES = ["carry_forward", "forgive"] as const;
export type RefundShortfallPolicy = (typeof REFUND_SHORTFALL_POLICIES)[number];

/** Whether a reward used on an order that is later refunded in full is given back. */
export const REWARD_REFUND_POLICIES = ["reinstate", "keep_redeemed"] as const;
export type RewardRefundPolicy = (typeof REWARD_REFUND_POLICIES)[number];

/** One version of the owner-configurable program. Versions are immutable; changes add a version. */
export interface LoyaltyRules {
  version: number;
  stampsPerReward: number;
  earnOn: EarnTrigger;
  /** A drink earns only if at least this much was paid for it after discounts (cents). */
  minPaidCentsPerDrink: number;
  /** Upper bound of stamps from one purchase (null = no limit). */
  maxStampsPerPurchase: number | null;
  /** Qualifying drinks (product flag) that this program nevertheless excludes. */
  excludedProductIds: readonly string[];
  /** Excluded sizes (variants) of otherwise qualifying drinks. */
  excludedVariantIds: readonly string[];
  /** Reward-eligible drinks (product flag) that cannot be chosen as the free drink. */
  rewardExcludedProductIds: readonly string[];
  rewardExcludedVariantIds: readonly string[];
  /** Maximum value of the free drink (null = no cap). */
  rewardValueCapCents: number | null;
  /** Whether paid extras (syrups, milk…) on the free drink are free too. */
  rewardCoversModifiers: boolean;
  /** Days until an issued reward expires (null = never; see the Québec CPA notes). */
  rewardExpiryDays: number | null;
  refundShortfallPolicy: RefundShortfallPolicy;
  rewardOnRefund: RewardRefundPolicy;
  inStoreEnabled: boolean;
  inStoreMaxStampsPerVisit: number;
  inStoreMaxStampsPerDay: number;
}

/** Version 1: the café's rule ("every five qualifying paid drinks earn one free eligible drink"). */
export const DEFAULT_LOYALTY_RULES: LoyaltyRules = {
  version: 1,
  stampsPerReward: DEFAULT_STAMPS_PER_REWARD,
  earnOn: "paid",
  minPaidCentsPerDrink: 1,
  maxStampsPerPurchase: null,
  excludedProductIds: [],
  excludedVariantIds: [],
  rewardExcludedProductIds: [],
  rewardExcludedVariantIds: [],
  rewardValueCapCents: null,
  rewardCoversModifiers: false,
  rewardExpiryDays: null,
  refundShortfallPolicy: "carry_forward",
  rewardOnRefund: "reinstate",
  inStoreEnabled: true,
  inStoreMaxStampsPerVisit: 10,
  inStoreMaxStampsPerDay: 10,
};

/** Bounds the admin form and the server both enforce. */
export const LOYALTY_RULE_LIMITS = {
  stampsPerReward: { min: 2, max: 20 },
  minPaidCentsPerDrink: { min: 0, max: 10_000 },
  maxStampsPerPurchase: { min: 1, max: 100 },
  rewardValueCapCents: { min: 100, max: 10_000 },
  rewardExpiryDays: { min: 30, max: 1_095 },
  inStoreMaxStampsPerVisit: { min: 1, max: 50 },
  inStoreMaxStampsPerDay: { min: 1, max: 100 },
  adjustment: { min: -20, max: 20 },
} as const;

// --- Earning --------------------------------------------------------------------------------------

/** Why some or all units of a line earned no stamp (shown to the customer). */
export const NOT_COUNTED_REASONS = [
  "not_qualifying",
  "excluded_product",
  "excluded_size",
  "reward_drink",
  "not_paid",
  "purchase_limit",
] as const;
export type NotCountedReason = (typeof NOT_COUNTED_REASONS)[number];

export interface EarnLine {
  id: string;
  productId: string;
  variantId: string;
  quantity: number;
  /** Catalog flags as snapshotted on the order line (or read at the till for in-store visits). */
  isDrink: boolean;
  loyaltyQualifying: boolean;
  /** Amount actually charged for the whole line after promotions and the reward (cents). */
  paidCents: number;
  /** Units of this line paid for with a reward (0 or 1). */
  freeUnits: number;
}

export interface EarnLineResult {
  id: string;
  stamps: number;
  notCounted: Array<{ quantity: number; reason: NotCountedReason }>;
}

/**
 * Stamps per line for one purchase. Counts drink units (five lattes in one order earn five
 * stamps), never orders. The free reward drink, excluded products and sizes, and drinks not
 * actually paid for earn nothing. Pure: the caller supplies server-side catalog facts.
 */
export function stampsForPurchase(
  lines: readonly EarnLine[],
  rules: Pick<
    LoyaltyRules,
    "excludedProductIds" | "excludedVariantIds" | "minPaidCentsPerDrink" | "maxStampsPerPurchase"
  >,
): { total: number; lines: EarnLineResult[] } {
  let remainingCap = rules.maxStampsPerPurchase ?? Number.POSITIVE_INFINITY;
  const results = lines.map((line): EarnLineResult => {
    const qty = Math.max(0, Math.trunc(line.quantity));
    if (!line.isDrink || !line.loyaltyQualifying)
      return { id: line.id, stamps: 0, notCounted: [{ quantity: qty, reason: "not_qualifying" }] };
    if (rules.excludedProductIds.includes(line.productId))
      return {
        id: line.id,
        stamps: 0,
        notCounted: [{ quantity: qty, reason: "excluded_product" }],
      };
    if (rules.excludedVariantIds.includes(line.variantId))
      return { id: line.id, stamps: 0, notCounted: [{ quantity: qty, reason: "excluded_size" }] };

    const notCounted: EarnLineResult["notCounted"] = [];
    const free = Math.min(qty, Math.max(0, line.freeUnits));
    if (free > 0) notCounted.push({ quantity: free, reason: "reward_drink" });
    const paidUnits = qty - free;
    // Each earning drink needs its own minimum paid amount, so a line discounted to almost
    // nothing earns accordingly; a fully discounted line earns nothing.
    const perDrink = Math.max(1, rules.minPaidCentsPerDrink);
    const earning = Math.min(paidUnits, Math.floor(Math.max(0, line.paidCents) / perDrink));
    if (paidUnits - earning > 0)
      notCounted.push({ quantity: paidUnits - earning, reason: "not_paid" });
    const capped = Math.min(earning, remainingCap);
    if (earning - capped > 0)
      notCounted.push({ quantity: earning - capped, reason: "purchase_limit" });
    remainingCap -= capped;
    return { id: line.id, stamps: capped, notCounted };
  });
  return { total: results.reduce((s, r) => s + r.stamps, 0), lines: results };
}

export interface LoyaltyBalance {
  /** Stamps toward the next reward. */
  balance: number;
  /** Stamps owed after a refund (carry-forward policy). */
  debt: number;
}

/**
 * Adds stamps: they first settle any stamps owed, then fill the card; every full card becomes a
 * reward and the rest carries forward.
 */
export function planEarn(
  state: LoyaltyBalance,
  stamps: number,
  stampsPerReward: number,
): { repaid: number; rewards: number; balance: number; debt: number } {
  const repaid = Math.min(state.debt, stamps);
  const added = state.balance + stamps - repaid;
  const rewards = Math.floor(added / stampsPerReward);
  return {
    repaid,
    rewards,
    balance: added - rewards * stampsPerReward,
    debt: state.debt - repaid,
  };
}

/**
 * Takes back `stamps` after a refund. Order: the stamp balance, then unused rewards (newest
 * first — each returns the stamps it cost), then the shortfall policy. Never negative, never
 * deletes history: every step becomes a ledger entry.
 */
export function planReversal(
  state: LoyaltyBalance,
  stamps: number,
  /** Stamp cost of each available (unused) reward, newest first. */
  availableRewardCosts: readonly number[],
  policy: RefundShortfallPolicy,
): {
  fromBalance: number;
  revokedRewards: number;
  /** Stamps returned by revoked rewards (credited before the deduction). */
  restored: number;
  debtAdded: number;
  forgiven: number;
  balance: number;
  debt: number;
} {
  let need = Math.max(0, stamps);
  let balance = state.balance;
  let revokedRewards = 0;
  let restored = 0;
  let fromBalance = Math.min(balance, need);
  balance -= fromBalance;
  need -= fromBalance;
  for (const cost of availableRewardCosts) {
    if (need <= 0) break;
    revokedRewards++;
    restored += cost;
    balance += cost;
    const take = Math.min(balance, need);
    balance -= take;
    need -= take;
    fromBalance += take;
  }
  const debtAdded = policy === "carry_forward" ? need : 0;
  return {
    fromBalance,
    revokedRewards,
    restored,
    debtAdded,
    forgiven: need - debtAdded,
    balance,
    debt: state.debt + debtAdded,
  };
}

// --- Rewards --------------------------------------------------------------------------------------

/** Expiry instant for a reward issued now, or null when the program has no expiry. */
export function rewardExpiry(issuedAt: Date, expiryDays: number | null): Date | null {
  return expiryDays === null ? null : new Date(issuedAt.getTime() + expiryDays * 86_400_000);
}

export function isRewardEligible(
  product: { id: string; isDrink: boolean; rewardEligible: boolean },
  variantId: string,
  rules: Pick<LoyaltyRules, "rewardExcludedProductIds" | "rewardExcludedVariantIds">,
): boolean {
  return (
    product.isDrink &&
    product.rewardEligible &&
    !rules.rewardExcludedProductIds.includes(product.id) &&
    !rules.rewardExcludedVariantIds.includes(variantId)
  );
}

/** Value of the free drink: the size price (plus extras if covered), up to the cap. */
export function rewardValueCents(
  variantPriceCents: number,
  unitPriceCents: number,
  reward: { valueCapCents: number | null; coversModifiers: boolean },
): number {
  const base = reward.coversModifiers
    ? unitPriceCents
    : Math.min(variantPriceCents, unitPriceCents);
  return Math.max(0, Math.min(base, reward.valueCapCents ?? Number.POSITIVE_INFINITY));
}

// --- In-store identification ----------------------------------------------------------------------

/** Unambiguous alphabet (no 0/O, 1/I/L) for codes read aloud or typed at the till. */
export const CARD_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CARD_CODE_LENGTH = 8;
/** A customer's in-store code stays valid this long (a screenshot is useless soon after). */
export const CARD_CODE_TTL_MS = 10 * 60_000;

export function normalizeCardCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

const CARD_CODE_PATTERN = new RegExp(`^[${CARD_CODE_ALPHABET}]{${CARD_CODE_LENGTH}}$`);

export function isCardCode(raw: string): boolean {
  return CARD_CODE_PATTERN.test(normalizeCardCode(raw));
}
