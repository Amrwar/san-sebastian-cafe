import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { DEFAULT_STAMPS_PER_REWARD } from "@ssc/domain";
import { Badge, buttonClasses, Container, EmptyState, PageHeader, Surface } from "@ssc/ui";
import { AccountNav } from "@/components/AccountNav";
import { StampIcon } from "@/components/icons";
import { StampCard } from "@/components/StampCard";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { getLoyaltySummary } from "@/server/modules/loyalty/summary";
import { getSessionUser } from "@/server/session";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/rewards">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Rewards" });
  return { title: t("title") };
}

export default async function RewardsPage({ params }: PageProps<"/[locale]/rewards">) {
  const { locale } = await params;
  const user = await getSessionUser();
  const [t, tCommon, format] = await Promise.all([
    getTranslations("Rewards"),
    getTranslations("Common"),
    getFormatter(),
  ]);

  const rules = (
    <Surface className="flex flex-col gap-3">
      <h2 className="font-display text-2xl text-espresso">{t("rulesTitle")}</h2>
      <ul className="flex list-disc flex-col gap-1.5 ps-5 text-espresso-muted">
        <li>{t("rule1")}</li>
        <li>{t("rule2")}</li>
        <li>{t("rule3")}</li>
      </ul>
    </Surface>
  );

  // Signed-out visitors see how the programme works and an invitation to join (no fake balance).
  if (!user) {
    return (
      <Container className="max-w-3xl">
        <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
          <p>{t("intro", { total: DEFAULT_STAMPS_PER_REWARD })}</p>
        </PageHeader>
        <div className="flex flex-col gap-6">
          <Link
            href={`/sign-in?mode=register&next=${encodeURIComponent(`/${locale}/rewards`)}`}
            className={buttonClasses("primary", "lg", "self-start")}
          >
            {tCommon("signIn")}
          </Link>
          {rules}
        </div>
      </Container>
    );
  }

  const loyalty = await getLoyaltySummary(db(), user);
  return (
    <Container className="max-w-3xl">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
        <p>{t("intro", { total: loyalty.stampsPerReward })}</p>
      </PageHeader>
      <AccountNav current="rewards" role={user.role} />

      <div className="flex flex-col gap-8">
        <section aria-labelledby="stamp-card" className="flex flex-col gap-3">
          <h2 id="stamp-card" className="sr-only">
            {t("cardLabel", { count: loyalty.stampBalance, total: loyalty.stampsPerReward })}
          </h2>
          <StampCard count={loyalty.stampBalance} total={loyalty.stampsPerReward} />
          <p className="text-sm text-espresso-muted">
            {t("lifetime", { count: loyalty.lifetimeStamps })}
            {loyalty.isDemo ? ` · ${t("demoNote")}` : ""}
          </p>
        </section>

        <section aria-labelledby="wallet-title" className="flex flex-col gap-3">
          <h2 id="wallet-title" className="font-display text-2xl text-espresso">
            {t("walletTitle")}
          </h2>
          {loyalty.availableRewards.length === 0 ? (
            <EmptyState title={t("walletEmpty")} />
          ) : (
            <>
              <ul className="grid gap-3 sm:grid-cols-2">
                {loyalty.availableRewards.map((r) => (
                  <li key={r.id}>
                    <Surface className="flex items-center gap-4">
                      <span className="on-dark flex size-12 shrink-0 items-center justify-center rounded-pill bg-espresso text-crema">
                        <StampIcon className="size-6" />
                      </span>
                      <div>
                        <p className="font-semibold text-espresso">{t("rewardItem")}</p>
                        <p className="text-sm text-espresso-muted">
                          {t("rewardIssued", {
                            date: format.dateTime(r.issuedAt, { dateStyle: "long" }),
                          })}
                        </p>
                      </div>
                    </Surface>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-espresso-muted">{t("rewardHowTo")}</p>
            </>
          )}
        </section>

        <section aria-labelledby="history-title" className="flex flex-col gap-3">
          <h2 id="history-title" className="font-display text-2xl text-espresso">
            {t("historyTitle")}
          </h2>
          {loyalty.history.length === 0 ? (
            <EmptyState title={t("historyEmpty")} />
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line bg-ivory-raised">
              {loyalty.history.map((h) => (
                <li
                  key={h.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                >
                  <div className="flex flex-col">
                    <span className="font-medium text-espresso">{t(`kinds.${h.kind}`)}</span>
                    <span className="text-sm text-espresso-muted">
                      {format.dateTime(h.createdAt, { dateStyle: "medium" })}
                      {h.orderNumber && h.orderId ? (
                        <>
                          {" · "}
                          <Link
                            href={`/orders/${h.orderId}`}
                            className="underline underline-offset-4"
                          >
                            {t("orderRef", { number: h.orderNumber })}
                          </Link>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <Badge tone={h.stamps > 0 ? "success" : "neutral"}>
                    {h.stamps > 0 ? `+${h.stamps}` : h.stamps}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>

        {rules}
      </div>
    </Container>
  );
}
