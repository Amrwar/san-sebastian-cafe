import { getTranslations } from "next-intl/server";
import { can } from "@ssc/domain";
import { Container } from "@ssc/ui";
import { Link } from "@/i18n/navigation";
import { getSessionUser } from "@/server/session";
import { LanguageSwitcher } from "./LanguageSwitcher.client";
import { DesktopNav, type NavHref } from "./Navigation.client";

export async function SiteHeader() {
  const t = await getTranslations("Nav");
  const user = await getSessionUser();

  // Only links to pages that exist and that this user may open.
  const items: Array<{ href: NavHref; label: string }> = [
    { href: "/menu", label: t("menu") },
    { href: "/rewards", label: t("rewards") },
  ];
  if (user) items.push({ href: "/orders", label: t("orders") });
  if (user && can(user.role, "staff_console:access"))
    items.push({ href: "/staff", label: t("staff") });
  if (user && can(user.role, "admin_console:access"))
    items.push({ href: "/admin", label: t("admin") });
  items.push(
    user ? { href: "/account", label: t("account") } : { href: "/sign-in", label: t("signIn") },
  );
  items.push({ href: "/cart", label: t("cart") });

  return (
    <header className="on-dark sticky top-0 z-40 border-b border-espresso-deep bg-espresso text-ivory">
      <Container className="flex min-h-16 items-center justify-between gap-4">
        <Link href="/" className="font-display text-xl tracking-tight text-ivory sm:text-2xl">
          San Sebastian <span className="text-crema">Café</span>
        </Link>
        <div className="flex items-center gap-2">
          <DesktopNav items={items} label={t("label")} />
          <LanguageSwitcher />
        </div>
      </Container>
    </header>
  );
}
