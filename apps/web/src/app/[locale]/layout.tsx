import type { Metadata, Viewport } from "next";
import { Figtree, Newsreader } from "next/font/google";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { SkipLink } from "@ssc/ui";
import "../globals.css";
import { CartSync } from "@/components/CartSync.client";
import { BottomNav } from "@/components/Navigation.client";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration.client";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { routing, toDomainLocale } from "@/i18n/routing";
import { getSessionUser } from "@/server/session";

const display = Newsreader({
  subsets: ["latin", "latin-ext"],
  variable: "--font-display-family",
  display: "swap",
});
const sans = Figtree({
  subsets: ["latin", "latin-ext"],
  variable: "--font-sans-family",
  display: "swap",
});

// No generateStaticParams: every page reads the session and/or the database, so pages render
// on request. Prerendering at build time would require runtime secrets inside `next build`.

export async function generateMetadata({ params }: LayoutProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Metadata" });
  return {
    title: { default: t("title"), template: `%s · ${t("title")}` },
    description: t("description"),
    alternates: { languages: { "fr-CA": "/fr", "en-CA": "/en" } },
    // Development build: keep it out of search engines until launch.
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  themeColor: "#38251f",
  width: "device-width",
  initialScale: 1,
};

export default async function LocaleLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const [t, user] = await Promise.all([getTranslations("Common"), getSessionUser()]);

  return (
    <html lang={toDomainLocale(locale)} className={`${display.variable} ${sans.variable}`}>
      <body className="flex min-h-dvh flex-col bg-ivory text-espresso antialiased">
        <NextIntlClientProvider>
          <SkipLink>{t("skipToContent")}</SkipLink>
          <SiteHeader />
          <main id="main" tabIndex={-1} className="flex-1 pb-16 outline-none">
            {children}
          </main>
          <SiteFooter />
          <BottomNav />
          <ServiceWorkerRegistration />
          {user ? <CartSync userId={user.userId} /> : null}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
