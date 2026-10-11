import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { can, isRole, type Permission } from "@ssc/domain";
import { auth } from "./auth";
import type { Actor } from "./authz";

export interface SessionUser extends Actor {
  email: string;
  name: string;
}

/**
 * Current user for this request (memoized per request). The role is read from the database on
 * every request (no cookie cache), so a role change takes effect immediately.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const role = isRole(session.user.role) ? session.user.role : "customer";
  return { userId: session.user.id, role, email: session.user.email, name: session.user.name };
});

/** For pages: redirects anonymous visitors to sign-in, then back to `returnTo`. */
export async function requireSessionUser(locale: string, returnTo: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`/${locale}/sign-in?next=${encodeURIComponent(returnTo)}`);
  return user;
}

export type PageAccess =
  { status: "allowed"; user: SessionUser } | { status: "forbidden"; user: SessionUser };

/** For gated sections: signs in anonymous visitors; signed-in users without permission get a 403 view. */
export async function requirePermissionForPage(
  locale: string,
  returnTo: string,
  permission: Permission,
): Promise<PageAccess> {
  const user = await requireSessionUser(locale, returnTo);
  return can(user.role, permission) ? { status: "allowed", user } : { status: "forbidden", user };
}
