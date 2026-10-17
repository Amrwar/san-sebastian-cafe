import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { can } from "@ssc/domain";
import { Alert, Badge, buttonClasses, Container, PageHeader, Surface } from "@ssc/ui";
import { Forbidden } from "@/components/Forbidden";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { inStoreCatalog } from "@/server/modules/loyalty/in-store";
import { currentRules } from "@/server/modules/loyalty/program";
import { getCustomerLoyalty } from "@/server/modules/loyalty/staff";
import { requirePermissionForPage } from "@/server/session";
import { AdjustForm, ReasonAction } from "./CardActions.client";
import { CounterVisit } from "./CounterVisit.client";
import { CustomerSearch } from "./CustomerSearch.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/staff/loyalty">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "StaffLoyalty" });
  return { title: t("title"), robots: { index: false } };
}

/** Counter stamps (staff) and loyalty support: look up a card, correct it (shift lead+). */
export default async function StaffLoyaltyPage({
  params,
  searchParams,
}: PageProps<"/[locale]/staff/loyalty">) {
  const { locale } = await params;
  const sp = await searchParams;
  const customerId = typeof sp.customer === "string" ? sp.customer : "";
  const access = await requirePermissionForPage(
    locale,
    `/${locale}/staff/loyalty`,
    "customers:lookup",
  );
  if (access.status === "forbidden") return <Forbidden />;
  const { user } = access;
  const counter = can(user.role, "loyalty:in_store");
  const corrects = can(user.role, "loyalty:adjust");

  const [t, tRewards, format, rules] = await Promise.all([
    getTranslations("StaffLoyalty"),
    getTranslations("Rewards"),
    getFormatter(),
    currentRules(db()),
  ]);
  const [catalog, card] = await Promise.all([
    counter && rules.inStoreEnabled ? inStoreCatalog(db(), user) : Promise.resolve(null),
    customerId
      ? getCustomerLoyalty(db(), user, customerId).catch((e: unknown) => {
          if (e instanceof AppError && e.code === "not_found") return null;
          throw e;
        })
      : Promise.resolve(null),
  ]);
  const pick = (name: { fr: string; en: string }) => (locale === "fr" ? name.fr : name.en);
  const when = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });

  return (
    <Container className="max-w-4xl pb-10">
      <PageHeader title={t("title")}>
        <p>{t("intro")}</p>
      </PageHeader>
      <Link href="/staff" className={`${buttonClasses("secondary")} mb-6`}>
        {t("back")}
      </Link>

      <div className="flex flex-col gap-6">
        {counter ? (
          <Surface className="flex flex-col gap-3">
            <h2 className="font-display text-2xl text-espresso">{t("counterTitle")}</h2>
            {catalog ? (
              <>
                <p className="text-espresso-muted">{t("counterIntro")}</p>
                <CounterVisit catalog={catalog} />
              </>
            ) : (
              <Alert tone="neutral">{t("errors.in_store_disabled")}</Alert>
            )}
          </Surface>
        ) : null}

        <Surface className="flex flex-col gap-3">
          <h2 className="font-display text-2xl text-espresso">{t("supportTitle")}</h2>
          <p className="text-espresso-muted">{t("supportIntro")}</p>
          <CustomerSearch />
          {customerId && !card ? <Alert tone="neutral">{t("notFound")}</Alert> : null}
        </Surface>

        {card ? (
          <>
            <Surface className="flex flex-col gap-3">
              <h2 className="font-display text-2xl text-espresso">
                {card.firstName || card.maskedEmail}
              </h2>
              <p className="text-espresso-muted">{card.maskedEmail}</p>
              <p className="text-lg font-semibold text-espresso">
                {t("balance", { balance: card.stampBalance, total: card.stampsPerReward })}
                {card.stampDebt > 0 ? ` · ${t("owes", { count: card.stampDebt })}` : ""}
              </p>
              <p className="text-sm text-espresso-muted">
                {t("lifetime", { count: card.lifetimeStamps })}
              </p>
              <h3 className="font-semibold text-espresso">{t("rewards")}</h3>
              {card.rewards.length === 0 ? (
                <p className="text-espresso-muted">{t("noRewards")}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {card.rewards.map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone={r.status === "available" ? "success" : "neutral"}>
                          {t(`rewardStatus.${r.status}`)}
                        </Badge>
                        <span className="text-sm text-espresso-muted">
                          {tRewards("rewardIssued", {
                            date: format.dateTime(r.issuedAt, { dateStyle: "medium" }),
                          })}
                        </span>
                      </span>
                      {corrects && r.status === "available" ? (
                        <ReasonAction
                          label={t("voidReward")}
                          path={`/api/v1/staff/loyalty/customers/${encodeURIComponent(card.userId)}/adjust`}
                          body={{
                            action: "void_reward",
                            rewardId: r.id,
                            idempotencyKey: randomUUID(),
                          }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Surface>

            {corrects && card.userId !== user.userId ? (
              <Surface className="flex flex-col gap-3">
                <h2 className="font-display text-2xl text-espresso">{t("adjustTitle")}</h2>
                <p className="text-espresso-muted">{t("adjustIntro")}</p>
                <AdjustForm userId={card.userId} debt={card.stampDebt} />
              </Surface>
            ) : null}

            {card.visits.length > 0 ? (
              <Surface className="flex flex-col gap-3">
                <h2 className="font-display text-2xl text-espresso">{t("visits")}</h2>
                <ul className="divide-y divide-line">
                  {card.visits.map((v) => (
                    <li
                      key={v.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="flex flex-col">
                        <span className="font-medium text-espresso">
                          {tRewards("inStoreRef", { receipt: v.receiptReference })}
                        </span>
                        <span className="text-sm text-espresso-muted">
                          {when(v.createdAt)} · {t("visitStamps", { count: v.stampsEarned })}
                          {v.rewardUsed ? ` · ${t("recordedReward")}` : ""}
                        </span>
                        {v.voidedAt ? (
                          <span className="text-sm text-espresso">
                            {t("voided", { reason: v.voidReason ?? "" })}
                          </span>
                        ) : null}
                      </span>
                      {corrects && !v.voidedAt ? (
                        <ReasonAction
                          label={t("voidVisit")}
                          path={`/api/v1/staff/loyalty/visits/${v.id}/void`}
                          body={{}}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Surface>
            ) : null}

            <Surface className="flex flex-col gap-3">
              <h2 className="font-display text-2xl text-espresso">{t("history")}</h2>
              {card.history.length === 0 ? (
                <p className="text-espresso-muted">{tRewards("historyEmpty")}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {card.history.map((h) => (
                    <li
                      key={h.id}
                      className="flex flex-wrap items-start justify-between gap-2 py-2"
                    >
                      <span className="flex flex-col">
                        <span className="font-medium text-espresso">
                          {tRewards(`kinds.${h.kind}`)}
                        </span>
                        <span className="text-sm text-espresso-muted">
                          {when(h.createdAt)}
                          {h.orderNumber
                            ? ` · ${tRewards("orderRef", { number: h.orderNumber })}`
                            : ""}
                          {h.details.receiptReference
                            ? ` · ${tRewards("inStoreRef", { receipt: h.details.receiptReference })}`
                            : ""}
                          {h.details.cause ? ` · ${tRewards(`causes.${h.details.cause}`)}` : ""}
                          {h.details.drink ? ` · ${pick(h.details.drink)}` : ""}
                        </span>
                        {h.reason ? (
                          <span className="text-sm text-espresso">
                            {tRewards("reasonLine", { reason: h.reason })}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex gap-1">
                        {h.stamps !== 0 ? (
                          <Badge tone={h.stamps > 0 ? "success" : "neutral"}>
                            {h.stamps > 0 ? `+${h.stamps}` : h.stamps}
                          </Badge>
                        ) : null}
                        {h.debtDelta > 0 ? (
                          <Badge tone="warning">{tRewards("owed", { count: h.debtDelta })}</Badge>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Surface>
          </>
        ) : null}
      </div>
    </Container>
  );
}
