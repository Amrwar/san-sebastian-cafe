/**
 * Roles are ordered by privilege. A user has exactly one role.
 * Authorization is always evaluated server-side via `can()`.
 */
export const ROLES = ["customer", "staff", "shift_lead", "manager", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const STAFF_ROLES: readonly Role[] = ["staff", "shift_lead", "manager", "owner"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export const PERMISSIONS = [
  // customer self-service
  "profile:read_own",
  "profile:update_own",
  "orders:read_own",
  "loyalty:read_own",
  // staff operations
  "staff_console:access",
  "orders:read_all",
  "orders:transition",
  "catalog:toggle_availability",
  "customers:lookup",
  "loyalty:in_store",
  // shift lead
  "orders:cancel",
  "orders:refund",
  "loyalty:adjust",
  "store:pause_ordering",
  // manager
  "admin_console:access",
  "catalog:manage",
  "promotions:manage",
  "store:configure",
  "reports:read",
  "audit:read",
  "privacy:manage",
  // owner
  "staff:manage",
  "loyalty:configure",
  "payments:configure",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const CUSTOMER: readonly Permission[] = [
  "profile:read_own",
  "profile:update_own",
  "orders:read_own",
  "loyalty:read_own",
];
const STAFF: readonly Permission[] = [
  ...CUSTOMER,
  "staff_console:access",
  "orders:read_all",
  "orders:transition",
  "catalog:toggle_availability",
  "customers:lookup",
  "loyalty:in_store",
];
const SHIFT_LEAD: readonly Permission[] = [
  ...STAFF,
  "orders:cancel",
  "orders:refund",
  "loyalty:adjust",
  "store:pause_ordering",
];
const MANAGER: readonly Permission[] = [
  ...SHIFT_LEAD,
  "admin_console:access",
  "catalog:manage",
  "promotions:manage",
  "store:configure",
  "reports:read",
  "audit:read",
  "privacy:manage",
];
const OWNER: readonly Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  customer: new Set(CUSTOMER),
  staff: new Set(STAFF),
  shift_lead: new Set(SHIFT_LEAD),
  manager: new Set(MANAGER),
  owner: new Set(OWNER),
};

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].has(permission);
}
