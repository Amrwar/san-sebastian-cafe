import { can, type Permission, type Role } from "@ssc/domain";
import { forbidden, unauthenticated } from "./errors";

/** The authenticated principal a service acts on behalf of. Built only from the server session. */
export interface Actor {
  userId: string;
  role: Role;
}

/**
 * Service-level authorization. Every service that reads or mutates protected data calls this,
 * regardless of any route/page gating, so the API and server actions share one enforcement point.
 */
export function authorize(actor: Actor | null, permission: Permission): asserts actor is Actor {
  if (!actor) throw unauthenticated();
  if (!can(actor.role, permission)) throw forbidden(permission);
}
