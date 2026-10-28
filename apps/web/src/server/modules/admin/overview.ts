import {
  auditEvents,
  categories,
  count,
  desc,
  eq,
  isNull,
  sql,
  products,
  users,
  type Database,
} from "@ssc/db";
import type { Role } from "@ssc/domain";
import { authorize, type Actor } from "../../authz";
import { env } from "../../env";
import {
  collectSignals,
  overallStatus,
  type Signal,
  type SignalStatus,
} from "../../monitoring/signals";

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

/** Audit areas: the prefix of an action name ("catalog.product_updated" → catalog). */
export const AUDIT_AREAS = [
  "catalog",
  "store",
  "loyalty",
  "staff",
  "payment",
  "consent",
  "report",
  "privacy",
  "promotion",
  "marketing",
] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];
export const AUDIT_PAGE_SIZE = 50;

export interface AuditLogEntry extends AuditEntry {
  actorName: string | null;
  actorRole: Role | null;
  metadata: Record<string, unknown>;
}

/** The audit trail, newest first, optionally limited to one area (manager and above). */
export async function listAuditLog(
  db: Database,
  actor: Actor | null,
  { area, page = 1 }: { area?: AuditArea | null; page?: number } = {},
): Promise<{ entries: AuditLogEntry[]; total: number }> {
  authorize(actor, "audit:read");
  const where = area ? sql`${auditEvents.action} like ${`${area}.%`}` : undefined;
  const offset = (Math.max(1, Math.floor(page)) - 1) * AUDIT_PAGE_SIZE;
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        createdAt: auditEvents.createdAt,
        metadata: auditEvents.metadata,
        actorName: users.name,
        actorEmail: users.email,
        actorRole: users.role,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(where)
      .orderBy(desc(auditEvents.createdAt))
      .limit(AUDIT_PAGE_SIZE)
      .offset(offset),
    db.select({ n: count() }).from(auditEvents).where(where),
  ]);
  return {
    entries: rows.map(({ actorEmail, ...r }) => ({
      ...r,
      // Staff are named; anyone else (a customer changing their own consent) is shown by role only.
      actorName: r.actorRole && r.actorRole !== "customer" ? r.actorName || actorEmail : null,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    })),
    total: total?.n ?? 0,
  };
}

export interface OperationalStatus {
  status: SignalStatus;
  signals: Signal[];
  /** Server errors are sent to the alert webhook; without one they're only in the logs. */
  alertsConfigured: boolean;
  /** Without CRON_SECRET the scheduled jobs are off, so they aren't watched. */
  jobsScheduled: boolean;
}

/** The same signals the monitor job watches, for the admin overview. */
export async function getOperationalStatus(
  db: Database,
  actor: Actor | null,
): Promise<OperationalStatus> {
  authorize(actor, "admin_console:access");
  const jobsScheduled = Boolean(env().CRON_SECRET);
  const signals = await collectSignals(db, { jobsScheduled });
  return {
    status: overallStatus(signals),
    signals,
    alertsConfigured: Boolean(env().ALERT_WEBHOOK_URL),
    jobsScheduled,
  };
}
