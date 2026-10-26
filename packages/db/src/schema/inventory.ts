import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { modifierOptions, products } from "./catalog";
import { users } from "./identity";
import { orders } from "./ordering";

/*
 * Inventory ledger. The current count lives on the product or option (`stock_quantity`); every
 * change to it is recorded here, in the same transaction, so counts can be audited and an order's
 * stock is returned exactly once (its sales minus its releases).
 */

export const STOCK_MOVEMENT_REASONS = ["sale", "release", "restock", "adjustment"] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid().primaryKey().defaultRandom(),
    productId: uuid().references(() => products.id, { onDelete: "cascade" }),
    optionId: uuid().references(() => modifierOptions.id, { onDelete: "cascade" }),
    /** Units added (positive) or taken (negative). */
    delta: integer().notNull(),
    /** Count right after this movement (null when tracking was turned off). */
    quantityAfter: integer(),
    /** sale (order placed) · release (order stopped) · restock / adjustment (staff). */
    reason: text().$type<StockMovementReason>().notNull(),
    orderId: uuid().references(() => orders.id, { onDelete: "set null" }),
    actorUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stock_movements_order_idx").on(t.orderId),
    index("stock_movements_product_idx").on(t.productId, t.createdAt),
    index("stock_movements_option_idx").on(t.optionId, t.createdAt),
    check("stock_movements_one_item", sql`(${t.productId} is null) <> (${t.optionId} is null)`),
    check(
      "stock_movements_reason",
      sql`${t.reason} in ('sale', 'release', 'restock', 'adjustment')`,
    ),
  ],
);
