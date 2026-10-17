import { randomUUID } from "node:crypto";
import { asc, eq, ne, sessions, sql, users, type Database } from "@ssc/db";
import { ROLES, type Role } from "@ssc/domain";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { authorize, type Actor } from "../../authz";
import { fromZodError, unprocessable } from "../../errors";
import { provisionAccount } from "../identity/provisioning";

/*
 * The café team (owner only). Staff sign in with the same email codes as customers; their role
 * decides what they can open. Giving a role to an email with no account creates the account, so
 * the person just signs in with that address. Roles are read on every request, so a change
 * applies at once; lowering someone's role also signs them out everywhere.
 */

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}

/** Roles the owner can give. Ownership itself is not transferable here. */
export const ASSIGNABLE_ROLES = ["staff", "shift_lead", "manager"] as const;
const rank = (role: Role) => ROLES.indexOf(role);

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
  /** Last time they started a session (null: never signed in yet). */
  lastSignInAt: Date | null;
  createdAt: Date;
}

export async function listTeam(db: Database, actor: Actor | null): Promise<TeamMember[]> {
  authorize(actor, "staff:manage");
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
      lastSignInAt: sql<Date | null>`(select max(${sessions.createdAt}) from ${sessions} where ${sessions.userId} = ${users.id})`,
    })
    .from(users)
    .where(ne(users.role, "customer"))
    .orderBy(asc(users.name), asc(users.email));
  return rows
    .map((r) => ({ ...r, lastSignInAt: r.lastSignInAt ? new Date(r.lastSignInAt) : null }))
    .sort((a, b) => rank(b.role) - rank(a.role));
}

export const roleInput = z
  .object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
    /** `customer` removes staff access. */
    role: z.enum([...ASSIGNABLE_ROLES, "customer"]),
  })
  .strict();

/**
 * Gives a role to an email address (creating the account if needed) or, with `customer`,
 * removes staff access. Owners and the caller's own account can't be changed here.
 */
export async function setTeamRole(
  db: Database,
  actor: Actor | null,
  raw: unknown,
): Promise<{ userId: string; created: boolean }> {
  authorize(actor, "staff:manage");
  const input = parse(roleInput, raw);

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email}`)
      .for("update");

    if (!existing) {
      if (input.role === "customer") throw unprocessable("not_staff");
      const userId = randomUUID();
      await tx.insert(users).values({
        id: userId,
        name: "",
        email: input.email,
        emailVerified: false,
        role: input.role,
      });
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: "staff.invited",
        entityType: "user",
        entityId: userId,
        metadata: { role: input.role },
      });
      return { userId, created: true, demoted: false };
    }

    if (existing.id === actor.userId) throw unprocessable("own_account");
    if (existing.role === "owner") throw unprocessable("owner_account");
    if (existing.role === input.role)
      return { userId: existing.id, created: false, demoted: false };
    if (existing.role === "customer" && input.role === "customer") throw unprocessable("not_staff");

    await tx.update(users).set({ role: input.role }).where(eq(users.id, existing.id));
    const demoted = rank(input.role) < rank(existing.role);
    if (demoted) await tx.delete(sessions).where(eq(sessions.userId, existing.id));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: input.role === "customer" ? "staff.access_removed" : "staff.role_changed",
      entityType: "user",
      entityId: existing.id,
      metadata: { from: existing.role, to: input.role, signedOut: demoted },
    });
    return { userId: existing.id, created: false, demoted };
  });

  // New accounts get the same profile, preferences and loyalty card as any other.
  if (result.created) await provisionAccount(db, result.userId);
  return { userId: result.userId, created: result.created };
}
