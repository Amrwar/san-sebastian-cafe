import {
  and,
  asc,
  desc,
  eq,
  privacyRequests,
  PRIVACY_REQUEST_CHANNELS,
  PRIVACY_REQUEST_KINDS,
  sql,
  users,
  type Database,
  type Tx,
} from "@ssc/db";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { fromZodError, notFound, unprocessable } from "../../errors";

/*
 * Privacy requests (Law 25): someone asks to see, copy, correct or delete their personal
 * information, or withdraws a consent. The café must answer within 30 days. Requests made by
 * email, phone or in person are logged here by staff; self-service exports and deletions are
 * logged automatically, already completed. Every change is audited.
 */

export const RESPONSE_DAYS = 30;
const DAY_MS = 86_400_000;

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}
const isUuid = (id: string) => z.uuid().safeParse(id).success;
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/**
 * Records a request the customer completed themselves (export or deletion), inside the caller's
 * transaction so the record and the action can't disagree.
 */
export async function recordSelfServiceRequest(
  tx: Tx,
  userId: string | null,
  kind: "export" | "deletion",
  now: Date,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  {
    const [row] = await tx
      .insert(privacyRequests)
      .values({
        kind,
        channel: "self_service",
        status: "completed",
        subjectUserId: userId,
        receivedAt: now,
        dueAt: new Date(now.getTime() + RESPONSE_DAYS * DAY_MS),
        completedAt: now,
        outcome: kind === "export" ? "Copy downloaded from the account" : "Account deleted",
      })
      .returning({ id: privacyRequests.id });
    await recordAudit(tx, {
      actorUserId: userId,
      action: kind === "export" ? "privacy.data_exported" : "privacy.account_deleted",
      entityType: "privacy_request",
      entityId: row?.id,
      metadata,
    });
  }
}

export const newRequestInput = z
  .object({
    kind: z.enum(PRIVACY_REQUEST_KINDS),
    channel: z.enum(PRIVACY_REQUEST_CHANNELS).exclude(["self_service"]),
    /** Email or phone of the requester. */
    contact: z.string().trim().min(3).max(200),
    details: optionalText(1000),
    /** When the request arrived (YYYY-MM-DD, café date); defaults to now. */
    receivedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullish(),
  })
  .strict();

export interface PrivacyRequestRow {
  id: string;
  kind: string;
  channel: string;
  status: string;
  contact: string | null;
  /** Whether the request concerns a customer account (found by its email). */
  hasAccount: boolean;
  details: string | null;
  receivedAt: Date;
  dueAt: Date;
  completedAt: Date | null;
  outcome: string | null;
  overdue: boolean;
}

/** Open requests first (soonest due), then the most recent closed ones. */
export async function listPrivacyRequests(
  db: Database,
  actor: Actor | null,
  now = new Date(),
): Promise<PrivacyRequestRow[]> {
  authorize(actor, "privacy:manage");
  const rows = await db
    .select()
    .from(privacyRequests)
    .orderBy(
      sql`case when ${privacyRequests.status} = 'open' then 0 else 1 end`,
      asc(sql`case when ${privacyRequests.status} = 'open' then ${privacyRequests.dueAt} end`),
      desc(privacyRequests.receivedAt),
    )
    .limit(200);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    channel: r.channel,
    status: r.status,
    contact: r.subjectContact,
    hasAccount: r.subjectUserId !== null,
    details: r.details,
    receivedAt: r.receivedAt,
    dueAt: r.dueAt,
    completedAt: r.completedAt,
    outcome: r.outcome,
    overdue: r.status === "open" && r.dueAt < now,
  }));
}

/** Logs a request received outside the app. It is due 30 days after it arrived. */
export async function createPrivacyRequest(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  now = new Date(),
): Promise<{ id: string }> {
  authorize(actor, "privacy:manage");
  const input = parse(newRequestInput, raw);
  const receivedAt = input.receivedOn ? new Date(`${input.receivedOn}T12:00:00Z`) : now;
  if (Number.isNaN(receivedAt.getTime()) || receivedAt > now)
    throw unprocessable("received_in_future");
  const [account] = input.contact.includes("@")
    ? await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = lower(${input.contact})`)
    : [];
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(privacyRequests)
      .values({
        kind: input.kind,
        channel: input.channel,
        subjectContact: input.contact,
        subjectUserId: account?.id ?? null,
        details: input.details,
        receivedAt,
        dueAt: new Date(receivedAt.getTime() + RESPONSE_DAYS * DAY_MS),
        handledByUserId: actor.userId,
      })
      .returning({ id: privacyRequests.id });
    const id = row?.id ?? "";
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "privacy.request_logged",
      entityType: "privacy_request",
      entityId: id,
      metadata: { kind: input.kind, channel: input.channel },
    });
    return { id };
  });
}

export const closeRequestInput = z
  .object({
    status: z.enum(["completed", "refused"]),
    outcome: z.string().trim().min(3).max(1000),
  })
  .strict();

/** Closes an open request with what was done (or why it was refused). */
export async function closePrivacyRequest(
  db: Database,
  actor: Actor | null,
  requestId: string,
  raw: unknown,
  now = new Date(),
): Promise<void> {
  authorize(actor, "privacy:manage");
  const input = parse(closeRequestInput, raw);
  if (!isUuid(requestId)) throw notFound("Request");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(privacyRequests)
      .set({
        status: input.status,
        outcome: input.outcome,
        completedAt: now,
        handledByUserId: actor.userId,
        updatedAt: now,
      })
      .where(and(eq(privacyRequests.id, requestId), eq(privacyRequests.status, "open")))
      .returning({ kind: privacyRequests.kind });
    if (!row) throw notFound("Request");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "privacy.request_closed",
      entityType: "privacy_request",
      entityId: requestId,
      metadata: { kind: row.kind, status: input.status },
    });
  });
}
