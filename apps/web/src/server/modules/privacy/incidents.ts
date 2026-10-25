import { confidentialityIncidents, desc, eq, type Database } from "@ssc/db";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { AppError, fromZodError, notFound } from "../../errors";

/*
 * Register of confidentiality incidents (Law 25). Every incident is entered, serious or not, and
 * kept: entries are corrected over time, never deleted. An incident that presents a risk of
 * serious injury must be reported promptly to the Commission d'accès à l'information and to the
 * people concerned, so it can't be closed until both notifications are dated.
 */

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}
const isUuid = (id: string) => z.uuid().safeParse(id).success;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optionalDay = day.nullish().transform((v) => v ?? null);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const incidentInput = z
  .object({
    occurredOn: optionalDay,
    discoveredOn: day,
    description: z.string().trim().min(10).max(4000),
    dataInvolved: z.string().trim().min(3).max(1000),
    peopleAffected: z
      .number()
      .int()
      .min(0)
      .max(10_000_000)
      .nullish()
      .transform((v) => v ?? null),
    /** null = not assessed yet. */
    riskOfSeriousInjury: z.boolean().nullable(),
    riskAssessment: optionalText(4000),
    measuresTaken: optionalText(4000),
    commissionNotifiedOn: optionalDay,
    peopleNotifiedOn: optionalDay,
    closed: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.occurredOn && v.occurredOn > v.discoveredOn)
      ctx.addIssue({ code: "custom", path: ["occurredOn"], message: "after discovery" });
    if (v.closed && v.riskOfSeriousInjury === null)
      ctx.addIssue({ code: "custom", path: ["riskOfSeriousInjury"], message: "assess first" });
    if (v.closed && v.riskOfSeriousInjury === true) {
      for (const key of ["commissionNotifiedOn", "peopleNotifiedOn"] as const)
        if (!v[key]) ctx.addIssue({ code: "custom", path: [key], message: "notify first" });
    }
  });
export type IncidentInput = z.infer<typeof incidentInput>;

/** Date-only fields are stored at noon UTC, which is the same calendar day in Montréal. */
const toInstant = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`) : null);
const toDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export interface IncidentRow extends IncidentInput {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

function values(input: IncidentInput, now: Date) {
  for (const d of [
    input.occurredOn,
    input.discoveredOn,
    input.commissionNotifiedOn,
    input.peopleNotifiedOn,
  ])
    if ((toInstant(d)?.getTime() ?? 0) > now.getTime())
      throw new AppError("validation_failed", "Date in the future", [
        { path: "date", code: "future" },
      ]);
  return {
    occurredAt: toInstant(input.occurredOn),
    discoveredAt: toInstant(input.discoveredOn) ?? now,
    description: input.description,
    dataInvolved: input.dataInvolved,
    peopleAffected: input.peopleAffected,
    riskOfSeriousInjury: input.riskOfSeriousInjury,
    riskAssessment: input.riskAssessment,
    measuresTaken: input.measuresTaken,
    commissionNotifiedAt: toInstant(input.commissionNotifiedOn),
    peopleNotifiedAt: toInstant(input.peopleNotifiedOn),
    status: input.closed ? "closed" : "open",
  };
}

export async function listIncidents(db: Database, actor: Actor | null): Promise<IncidentRow[]> {
  authorize(actor, "privacy:manage");
  const rows = await db
    .select()
    .from(confidentialityIncidents)
    .orderBy(desc(confidentialityIncidents.discoveredAt), desc(confidentialityIncidents.createdAt));
  return rows.map((r) => ({
    id: r.id,
    occurredOn: toDay(r.occurredAt),
    discoveredOn: toDay(r.discoveredAt) ?? "",
    description: r.description,
    dataInvolved: r.dataInvolved,
    peopleAffected: r.peopleAffected,
    riskOfSeriousInjury: r.riskOfSeriousInjury,
    riskAssessment: r.riskAssessment,
    measuresTaken: r.measuresTaken,
    commissionNotifiedOn: toDay(r.commissionNotifiedAt),
    peopleNotifiedOn: toDay(r.peopleNotifiedAt),
    closed: r.status === "closed",
    closedAt: r.closedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/** Records (no id) or corrects an incident. The audit trail names the fields changed, not their content. */
export async function saveIncident(
  db: Database,
  actor: Actor | null,
  raw: unknown,
  incidentId?: string,
  now = new Date(),
): Promise<{ id: string }> {
  authorize(actor, "privacy:manage");
  const input = parse(incidentInput, raw);
  const next = values(input, now);
  return db.transaction(async (tx) => {
    if (incidentId === undefined) {
      const [row] = await tx
        .insert(confidentialityIncidents)
        .values({ ...next, closedAt: input.closed ? now : null, recordedByUserId: actor.userId })
        .returning({ id: confidentialityIncidents.id });
      const id = row?.id ?? "";
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: "privacy.incident_recorded",
        entityType: "confidentiality_incident",
        entityId: id,
        metadata: { serious: input.riskOfSeriousInjury, closed: input.closed },
      });
      return { id };
    }
    const [before] = isUuid(incidentId)
      ? await tx
          .select()
          .from(confidentialityIncidents)
          .where(eq(confidentialityIncidents.id, incidentId))
          .for("update")
      : [];
    if (!before) throw notFound("Incident");
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => {
      const a = before[k];
      const b = next[k];
      return a instanceof Date || b instanceof Date
        ? (a as Date | null)?.getTime() !== (b as Date | null)?.getTime()
        : a !== b;
    });
    await tx
      .update(confidentialityIncidents)
      .set({
        ...next,
        closedAt: input.closed ? (before.closedAt ?? now) : null,
        updatedAt: now,
      })
      .where(eq(confidentialityIncidents.id, incidentId));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "privacy.incident_updated",
      entityType: "confidentiality_incident",
      entityId: incidentId,
      metadata: { changed },
    });
    return { id: incidentId };
  });
}
