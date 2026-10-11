import { getTranslations } from "next-intl/server";
import { can, type Role } from "@ssc/domain";
import { cn } from "@ssc/ui";
import { Link } from "@/i18n/navigation";

type Section = "profile" | "notifications" | "favorites" | "orders" | "payments" | "rewards";

/** Secondary navigation between account pages (also gives staff a route to their tools on mobile). */
export async function AccountNav({ current, role }: { current: Section; role: Role }) {
  const [t, tNav] = await Promise.all([getTranslations("Account"), getTranslations("Nav")]);
  const items: Array<{ key: Section | "staff" | "admin"; href: string; label: string }> = [
    { key: "profile", href: "/account", label: t("profileTab") },
    { key: "notifications", href: "/account/notifications", label: t("notificationsTab") },
    { key: "favorites", href: "/favorites", label: t("favorites") },
    { key: "orders", href: "/orders", label: t("orders") },
    { key: "payments", href: "/account/payments", label: t("paymentsTab") },
    { key: "rewards", href: "/rewards", label: t("rewards") },
  ];
  if (can(role, "staff_console:access"))
    items.push({ key: "staff", href: "/staff", label: tNav("staff") });
  if (can(role, "admin_console:access"))
    items.push({ key: "admin", href: "/admin", label: tNav("admin") });

  return (
    <nav aria-label={t("sectionsLabel")} className="-mx-4 mb-8 overflow-x-auto px-4">
      <ul className="flex gap-2 pb-1">
        {items.map((item) => (
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
