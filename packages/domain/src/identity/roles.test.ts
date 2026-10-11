import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, can, isRole } from "./roles";

describe("role permissions", () => {
  it("anonymous users have no permissions", () => {
    for (const p of PERMISSIONS) expect(can(null, p)).toBe(false);
  });

  it("each role is a superset of the role below it", () => {
    for (let i = 1; i < ROLES.length; i++) {
      const lower = ROLE_PERMISSIONS[ROLES[i - 1]!];
      const higher = ROLE_PERMISSIONS[ROLES[i]!];
      for (const p of lower) expect(higher.has(p)).toBe(true);
    }
  });

  it("owner holds every permission", () => {
    for (const p of PERMISSIONS) expect(can("owner", p)).toBe(true);
  });

  it.each([
    ["customer", "staff_console:access", false],
    ["staff", "staff_console:access", true],
    ["staff", "orders:refund", false],
    ["shift_lead", "orders:refund", true],
    ["shift_lead", "admin_console:access", false],
    ["manager", "admin_console:access", true],
    ["manager", "staff:manage", false],
    ["owner", "staff:manage", true],
  ] as const)("%s → %s = %s", (role, permission, expected) => {
    expect(can(role, permission)).toBe(expected);
  });

  it("validates role strings", () => {
    expect(isRole("manager")).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
