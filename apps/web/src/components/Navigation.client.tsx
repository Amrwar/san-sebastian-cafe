"use client";

import { useTranslations } from "next-intl";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@ssc/ui";
import { Link, usePathname } from "@/i18n/navigation";
import { useCartCount } from "@/lib/cart";
import { BagIcon, CupIcon, HomeIcon, StampIcon, UserIcon } from "./icons";

export type NavHref =
  "/" | "/menu" | "/cart" | "/rewards" | "/orders" | "/account" | "/sign-in" | "/staff" | "/admin";

export function isCurrentPath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function CartBadge({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-pill bg-crema px-1.5 text-[0.7rem] font-bold leading-5 text-espresso",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Desktop navigation links (inside the header). */
export function DesktopNav({
  items,
  label,
}: {
  items: Array<{ href: NavHref; label: string }>;
  label: string;
}) {
  const pathname = usePathname();
  const t = useTranslations("Nav");
  const count = useCartCount();
  return (
    <nav aria-label={label} className="hidden md:block">
      <ul className="flex items-center gap-1">
        {items.map((item) => {
          const current = isCurrentPath(pathname, item.href);
          const isCart = item.href === "/cart";
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                aria-label={isCart ? t("cartWithCount", { count }) : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-sm px-3 text-[0.95rem] transition-colors",
                  current
                    ? "text-crema underline decoration-crema decoration-2 underline-offset-8"
                    : "text-ivory/90 hover:text-ivory",
                )}
              >
                {isCart ? <BagIcon className="size-5" /> : null}
                {item.label}
                {isCart ? <CartBadge count={count} /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const TABS: Array<{
  href: NavHref;
  key: "home" | "menu" | "cart" | "rewards" | "account";
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  { href: "/", key: "home", icon: HomeIcon },
  { href: "/menu", key: "menu", icon: CupIcon },
  { href: "/cart", key: "cart", icon: BagIcon },
  { href: "/rewards", key: "rewards", icon: StampIcon },
  { href: "/account", key: "account", icon: UserIcon },
];

/** Fixed bottom tab bar on small screens. Respects the iOS home-indicator safe area. */
export function BottomNav() {
  const t = useTranslations("Nav");
  const pathname = usePathname();
  const count = useCartCount();
  return (
    <nav
      aria-label={t("mobileLabel")}
      className="on-dark fixed inset-x-0 bottom-0 z-40 border-t border-espresso-deep bg-espresso pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {TABS.map(({ href, key, icon: TabIcon }) => {
          const current =
            isCurrentPath(pathname, href) ||
            (href === "/account" && pathname.startsWith("/sign-in"));
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                aria-label={key === "cart" ? t("cartWithCount", { count }) : undefined}
                className={cn(
                  "relative flex min-h-16 flex-col items-center justify-center gap-1 text-[0.72rem] font-medium transition-colors",
                  current ? "text-crema" : "text-ivory/80 hover:text-ivory",
                )}
              >
                <span className="relative">
                  <TabIcon className="size-6" />
                  {key === "cart" ? (
                    <CartBadge count={count} className="absolute -end-3 -top-2" />
                  ) : null}
                </span>
                <span>{t(key)}</span>
                {current ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-0 h-0.5 w-8 rounded-pill bg-crema"
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
