export const AVAILABILITY = ["available", "sold_out", "hidden"] as const;
export type Availability = (typeof AVAILABILITY)[number];

export const MODIFIER_SELECTION = ["single", "multiple"] as const;
export type ModifierSelection = (typeof MODIFIER_SELECTION)[number];

/** Tax categories are owner/accountant-confirmed; see docs/08-compliance-notes.md. */
export const TAX_CATEGORIES = ["standard", "zero_rated", "exempt"] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];
