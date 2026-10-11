export const PROMOTION_KINDS = ["percent_off", "amount_off"] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

export const PROMOTION_SCOPES = ["order", "product", "category"] as const;
export type PromotionScope = (typeof PROMOTION_SCOPES)[number];
