import type { ConfiguredProduct, LineIssue } from "./configuration";

/*
 * Inventory. Stock is optional per product and per option: null/undefined means "not tracked"
 * (always on sale, as before). A tracked item at 0 is sold out ("auto-86"). Each unit of a line
 * uses one unit of its product and one unit of every option chosen for it.
 */

/** True when the item's stock is tracked and nothing is left. */
export function isOutOfStock(item: { stock?: number | null }): boolean {
  return item.stock !== null && item.stock !== undefined && item.stock <= 0;
}

export interface StockLine {
  productId: string;
  optionIds: readonly string[];
  quantity: number;
}

export interface StockDemand {
  products: Map<string, number>;
  options: Map<string, number>;
}

/** Units each product and option would use for these lines (an option counts once per unit). */
export function stockDemand(lines: readonly StockLine[]): StockDemand {
  const demand: StockDemand = { products: new Map(), options: new Map() };
  const add = (map: Map<string, number>, id: string, n: number) =>
    map.set(id, (map.get(id) ?? 0) + n);
  for (const line of lines) {
    add(demand.products, line.productId, line.quantity);
    for (const id of new Set(line.optionIds)) add(demand.options, id, line.quantity);
  }
  return demand;
}

/**
 * Lines the stock can't serve, in cart order: earlier lines are served first, and a line that
 * can't be served in full takes nothing (a later, smaller line may still fit). Returns the stock
 * issues of each line (empty when it can be served).
 */
export function stockShortfalls(
  lines: readonly StockLine[],
  catalog: ReadonlyMap<string, ConfiguredProduct>,
): LineIssue[][] {
  const left = new Map<string, number>();
  for (const product of catalog.values()) {
    if (product.stock != null) left.set(product.id, product.stock);
    for (const group of product.groups)
      for (const option of group.options)
        if (option.stock != null) left.set(option.id, option.stock);
  }
  return lines.map((line) => {
    if (!catalog.has(line.productId)) return [];
    // The tracked items this line uses, with what's left of each.
    const needs = [line.productId, ...new Set(line.optionIds)].flatMap((id) => {
      const n = left.get(id);
      return n === undefined ? [] : [{ id, left: n }];
    });
    const issues: LineIssue[] = needs
      .filter((n) => line.quantity > n.left)
      .map((n) => ({ code: "insufficient_stock", ref: n.id, available: Math.max(0, n.left) }));
    if (issues.length === 0) for (const n of needs) left.set(n.id, n.left - line.quantity);
    return issues;
  });
}
