import { getTranslations } from "next-intl/server";
import { can, type Role } from "@ssc/domain";
import { cn } from "@ssc/ui";
import { Link } from "@/i18n/navigation";

type Section =
  | "overview"
  | "menu"
  | "options"
  | "store"
  | "delivery"
  | "loyalty"
  | "promotions"
  | "marketing"
  | "reports"
  | "privacy"
  | "team"
  | "audit";

/** Secondary navigation between administration pages; shows only what the role may open. */
export async function AdminNav({ current, role }: { current: Section; role: Role }) {
  const t = await getTranslations("AdminNav");
  const items: Array<{ key: Section; href: string; label: string; visible: boolean }> = [
    { key: "overview", href: "/admin", label: t("overview"), visible: true },
    { key: "menu", href: "/admin/menu", label: t("menu"), visible: can(role, "catalog:manage") },
    {
      key: "options",
      href: "/admin/menu/options",
      label: t("options"),
      visible: can(role, "catalog:manage"),
    },
    {
      key: "store",
      href: "/admin/store",
      label: t("store"),
      visible: can(role, "store:configure"),
    },
    {
      key: "delivery",
      href: "/admin/delivery",
      label: t("delivery"),
      visible: can(role, "store:configure"),
    },
    { key: "loyalty", href: "/admin/loyalty", label: t("loyalty"), visible: true },
    {
      key: "promotions",
      href: "/admin/promotions",
      label: t("promotions"),
      visible: can(role, "promotions:manage"),
    },
    {
      key: "marketing",
      href: "/admin/marketing",
      label: t("marketing"),
      visible: can(role, "promotions:manage"),
    },
    {
      key: "reports",
      href: "/admin/reports",
      label: t("reports"),
      visible: can(role, "reports:read"),
    },
    {
      key: "privacy",
      href: "/admin/privacy",
      label: t("privacy"),
      visible: can(role, "privacy:manage"),
    },
    { key: "team", href: "/admin/team", label: t("team"), visible: can(role, "staff:manage") },
    { key: "audit", href: "/admin/audit", label: t("audit"), visible: can(role, "audit:read") },
  ];

  return (
    <nav aria-label={t("label")} className="-mx-4 mb-8 overflow-x-auto px-4">
      <ul className="flex gap-2 pb-1">
        {items
          .filter((item) => item.visible)
          .map((item) => (
            <li key={item.key} className="shrink-0">
              <Link
                href={item.href}
                aria-current={item.key === current ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-pill border px-4 text-[0.95rem]",
                  item.key === current
                    ? "border-burgundy bg-burgundy text-ivory"
                    : "border-line-strong bg-ivory-raised text-espresso hover:border-espresso-muted",
                )}
              >
                {item.label}
              </Link>
            </li>
          ))}
      </ul>
    </nav>
  );
}
