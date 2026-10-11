import { getTranslations } from "next-intl/server";
import { buttonClasses, Container } from "@ssc/ui";
import { Link } from "@/i18n/navigation";

export default async function HomePage() {
  const t = await getTranslations("Home");

  const coming = [
    { title: t("coming1Title"), body: t("coming1Body") },
    { title: t("coming2Title"), body: t("coming2Body") },
    { title: t("coming3Title"), body: t("coming3Body") },
  ];

  return (
    <>
      <section className="on-dark bg-espresso text-ivory">
        <Container className="grid gap-8 pb-14 pt-12 sm:pb-20 sm:pt-16 lg:grid-cols-[1.3fr_1fr] lg:items-end">
          <div className="flex flex-col gap-5">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-crema">
              {t("eyebrow")}
            </p>
            <h1 className="font-display text-5xl leading-[1.02] text-balance sm:text-6xl lg:text-7xl">
              {t("title")}
            </h1>
            <p className="max-w-xl text-lg leading-relaxed text-ivory/85">{t("intro")}</p>
            <div className="mt-2 flex flex-wrap gap-3">
              <Link href="/menu" className={buttonClasses("accent", "lg")}>
                {t("viewMenu")}
              </Link>
              <Link href="/sign-in" className={buttonClasses("inverse", "lg")}>
                {t("signIn")}
              </Link>
            </div>
          </div>
        </Container>
      </section>

      <Container as="section" className="py-14" aria-labelledby="coming-title">
        <h2 id="coming-title" className="font-display text-3xl text-espresso">
          {t("comingTitle")}
        </h2>
        <p className="mt-2 text-espresso-muted">{t("comingNote")}</p>
        <ol className="mt-8 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3">
          {coming.map((item, index) => (
            <li key={item.title} className="flex flex-col gap-2 bg-ivory-raised p-6">
              <span aria-hidden="true" className="font-display text-3xl text-burgundy">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="text-lg font-semibold text-espresso">{item.title}</h3>
              <p className="text-espresso-muted">{item.body}</p>
            </li>
          ))}
        </ol>
      </Container>
    </>
  );
}
