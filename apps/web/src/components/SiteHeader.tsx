import { getTranslations } from "next-intl/server";
import { can } from "@ssc/domain";
import { Container } from "@ssc/ui";
import { Link } from "@/i18n/navigation";
import { getSessionUser } from "@/server/session";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { NavMenu, type NavItem } from "./NavMenu";

export async function SiteHeader() {
  const t = await getTranslations("Nav");
  const user = await getSessionUser();

  // Only links to pages that exist and that this user may open.
  const items: NavItem[] = [
    { href: "/", label: t("home") },
    { href: "/menu", label: t("menu") },
  ];
  if (user && can(user.role, "staff_console:access"))
    items.push({ href: "/staff", label: t("staff") });
  if (user && can(user.role, "admin_console:access"))
    items.push({ href: "/admin", label: t("admin") });
  items.push(
    user ? { href: "/account", label: t("account") } : { href: "/sign-in", label: t("signIn") },
  );

  return (
    <header className="on-dark sticky top-0 z-40 border-b border-espresso-deep bg-espresso text-ivory">
      <Container className="flex min-h-16 items-center justify-between gap-4">
        <Link href="/" className="font-display text-xl tracking-tight text-ivory sm:text-2xl">
          San Sebastian <span className="text-crema">Café</span>
        </Link>
        <div className="flex items-center gap-2">
          <NavMenu
            items={items}
            label={t("label")}
            openLabel={t("openMenu")}
            closeLabel={t("closeMenu")}
          />
          <LanguageSwitcher />
        </div>
      </Container>
    </header>
  );
}
