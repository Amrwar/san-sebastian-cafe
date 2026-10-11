import type { Availability, ModifierSelection, TaxCategory } from "./catalog";

/**
 * Menu configuration as the pricing engine sees it. Customization is driven entirely by this
 * data (variants + modifier groups + options + per-size rules), never by product-specific code.
 */
export interface ConfiguredOption {
  id: string;
  priceDeltaCents: number;
  isDefault: boolean;
  availability: Availability;
  /** Temporarily disabled ("86'd") until this instant; null/undefined = not disabled. */
  unavailableUntil?: Date | null;
}

export interface ConfiguredGroup {
  id: string;
  selection: ModifierSelection;
  minSelected: number;
  maxSelected: number;
  options: ConfiguredOption[];
}

/** Size-specific rule for one option: a different price, or not allowed with this size. */
export interface VariantOptionRule {
  optionId: string;
  /** Overrides the option's price difference for this size; null keeps the option's default. */
  priceDeltaCents: number | null;
  /** True when the option cannot be combined with this size (e.g. no iced single espresso). */
  excluded: boolean;
}

export interface ConfiguredVariant {
  id: string;
  priceCents: number;
  isDefault: boolean;
  availability: Availability;
  optionRules?: VariantOptionRule[];
}

/** Weekly window (local time) during which a product can be ordered, e.g. breakfast 07:00–11:00. */
export interface AvailabilityWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface ConfiguredProduct {
  id: string;
  categoryId: string;
  availability: Availability;
  taxCategory: TaxCategory;
  isDrink: boolean;
  loyaltyQualifying: boolean;
  rewardEligible: boolean;
  variants: ConfiguredVariant[];
  groups: ConfiguredGroup[];
  /** Empty or missing = available whenever the café is open. */
  availabilityWindows?: AvailabilityWindow[];
  /** Temporarily disabled ("86'd") until this instant. */
  unavailableUntil?: Date | null;
}

export interface Selection {
  variantId: string;
  optionIds: string[];
}

export const MAX_LINE_QUANTITY = 20;

export type LineIssueCode =
  | "product_unavailable"
  | "product_outside_hours"
  | "variant_unavailable"
  | "variant_invalid"
  | "option_unavailable"
  | "option_invalid"
  | "option_not_allowed_for_size"
  | "group_below_minimum"
  | "group_above_maximum"
  | "quantity_invalid";

export interface LineIssue {
  code: LineIssueCode;
  /** Group, option or variant the issue refers to, if any. */
  ref?: string;
}

function ruleFor(
  variant: ConfiguredVariant | undefined,
  optionId: string,
): VariantOptionRule | undefined {
  return variant?.optionRules?.find((r) => r.optionId === optionId);
}

/** True when the option may be chosen with this size. */
export function optionAllowedForVariant(
  variant: ConfiguredVariant | undefined,
  optionId: string,
): boolean {
  return !ruleFor(variant, optionId)?.excluded;
}

/** The option's price difference for this size (size rule first, then the option default). */
export function optionPriceForVariant(
  variant: ConfiguredVariant | undefined,
  option: ConfiguredOption,
): number {
  return ruleFor(variant, option.id)?.priceDeltaCents ?? option.priceDeltaCents;
}

/** Default selection for a product: default (or first available) variant + default options. */
export function defaultSelection(product: ConfiguredProduct): Selection {
  const variants = product.variants.filter((v) => v.availability === "available");
  const variant = variants.find((v) => v.isDefault) ?? variants[0] ?? product.variants[0];
  const usable = (o: ConfiguredOption) =>
    o.availability === "available" && optionAllowedForVariant(variant, o.id);
  const optionIds = product.groups.flatMap((g) => {
    const defaults = g.options.filter((o) => o.isDefault && usable(o));
    if (defaults.length > 0) return defaults.slice(0, g.maxSelected).map((o) => o.id);
    // A required group without a usable default starts on its first usable options.
    if (g.minSelected > 0) {
      return g.options
        .filter(usable)
        .slice(0, g.minSelected)
        .map((o) => o.id);
    }
    return [];
  });
  return { variantId: variant?.id ?? "", optionIds };
}

/** Validates a selection against the configuration. Returns every problem found. */
export function validateSelection(
  product: ConfiguredProduct,
  selection: Selection,
  quantity: number,
): LineIssue[] {
  const issues: LineIssue[] = [];
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
    issues.push({ code: "quantity_invalid" });
  }
  if (product.availability !== "available") issues.push({ code: "product_unavailable" });

  const variant = product.variants.find((v) => v.id === selection.variantId);
  if (!variant) issues.push({ code: "variant_invalid", ref: selection.variantId });
  else if (variant.availability !== "available") {
    issues.push({ code: "variant_unavailable", ref: variant.id });
  }

  const optionGroup = new Map<string, ConfiguredGroup>();
  for (const g of product.groups) for (const o of g.options) optionGroup.set(o.id, g);

  const unique = [...new Set(selection.optionIds)];
  for (const id of unique) {
    const group = optionGroup.get(id);
    if (!group) {
      issues.push({ code: "option_invalid", ref: id });
      continue;
    }
    const option = group.options.find((o) => o.id === id);
    if (option && option.availability !== "available") {
      issues.push({ code: "option_unavailable", ref: id });
    }
    if (variant && !optionAllowedForVariant(variant, id)) {
      issues.push({ code: "option_not_allowed_for_size", ref: id });
    }
  }

  for (const g of product.groups) {
    const chosen = unique.filter((id) => optionGroup.get(id)?.id === g.id).length;
    if (chosen < g.minSelected) issues.push({ code: "group_below_minimum", ref: g.id });
    if (chosen > g.maxSelected) issues.push({ code: "group_above_maximum", ref: g.id });
  }
  return issues;
}

/** Unit price = variant price + selected option deltas (size rules applied), never below zero. */
export function unitPriceCents(product: ConfiguredProduct, selection: Selection): number {
  const variant = product.variants.find((v) => v.id === selection.variantId);
  const options = new Map(product.groups.flatMap((g) => g.options.map((o) => [o.id, o] as const)));
  const deltas = [...new Set(selection.optionIds)].reduce((sum, id) => {
    const option = options.get(id);
    return sum + (option ? optionPriceForVariant(variant, option) : 0);
  }, 0);
  return Math.max(0, (variant?.priceCents ?? 0) + deltas);
}
