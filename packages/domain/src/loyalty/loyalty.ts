/** Default program: 5 qualifying paid drinks earn 1 free eligible drink (configurable, versioned). */
export const DEFAULT_STAMPS_PER_REWARD = 5;

export const LOYALTY_TRANSACTION_KINDS = ["earn", "reverse", "convert", "adjust"] as const;
export type LoyaltyTransactionKind = (typeof LOYALTY_TRANSACTION_KINDS)[number];

export const REWARD_STATUSES = ["available", "reserved", "redeemed", "revoked"] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];

export const REDEMPTION_STATUSES = ["reserved", "committed", "released"] as const;
export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];
