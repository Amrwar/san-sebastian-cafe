import { auditEvents, categories, count, desc, isNull, products, type Database } from "@ssc/db";
import { authorize, type Actor } from "../../authz";

export interface CatalogOverview {
  categories: { real: number; demo: number };
  products: { real: number; demo: number };
}

export async function getCatalogOverview(
  db: Database,
  actor: Actor | null,
): Promise<CatalogOverview> {
  authorize(actor, "admin_console:access");
  const [categoryRows, productRows] = await Promise.all([
    db
      .select({ isDemo: categories.isDemo, n: count() })
      .from(categories)
      .where(isNull(categories.archivedAt))
      .groupBy(categories.isDemo),
    db
      .select({ isDemo: products.isDemo, n: count() })
      .from(products)
      .where(isNull(products.archivedAt))
      .groupBy(products.isDemo),
  ]);
  const split = (rows: Array<{ isDemo: boolean; n: number }>) => ({
    real: rows.find((r) => !r.isDemo)?.n ?? 0,
    demo: rows.find((r) => r.isDemo)?.n ?? 0,
  });
  return { categories: split(categoryRows), products: split(productRows) };
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: Date;
}

export async function listRecentAuditEvents(
  db: Database,
  actor: Actor | null,
  limit = 20,
): Promise<AuditEntry[]> {
  authorize(actor, "audit:read");
  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .orderBy(desc(auditEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}
