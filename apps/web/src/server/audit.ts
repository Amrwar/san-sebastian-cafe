import { auditEvents, type Tx } from "@ssc/db";

export interface AuditInput {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  /** Never include secrets, payment data or contact details. */
  metadata?: Record<string, unknown>;
  requestId?: string;
}

/** Writes an audit event inside the caller's transaction, so the audit trail commits atomically. */
export async function recordAudit(tx: Tx, input: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
    requestId: input.requestId ?? null,
  });
}
