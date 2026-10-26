import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { Alert, Badge, buttonClasses, Container, EmptyState, PageHeader, Surface } from "@ssc/ui";
import { AccountNav } from "@/components/AccountNav";
import { StampIcon } from "@/components/icons";
import { StampCard } from "@/components/StampCard";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { currentRules } from "@/server/modules/loyalty/program";
import { getMyReferral } from "@/server/modules/loyalty/referrals";
import {
  getLoyaltySummary,
  HISTORY_PAGE_SIZE,
  type LedgerEntryView,
} from "@/server/modules/loyalty/summary";
import { getSessionUser } from "@/server/session";
import { CardCode } from "./CardCode.client";
import { Referral } from "./Referral.client";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/rewards">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Rewards" });
  return { title: t("title") };
}

export default async function RewardsPage({
  params,
  searchParams,
}: PageProps<"/[locale]/rewards">) {
  const { locale } = await params;
  const sp = await searchParams;
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const user = await getSessionUser();
  const [t, tCommon, format, program] = await Promise.all([
    getTranslations("Rewards"),
    getTranslations("Common"),
    getFormatter(),
    currentRules(db()),
  ]);

  const rules = (
    <Surface className="flex flex-col gap-3">
      <h2 className="font-display text-2xl text-espresso">{t("rulesTitle")}</h2>
      <ul className="flex list-disc flex-col gap-1.5 ps-5 text-espresso-muted">
        <li>{program.inStoreEnabled ? t("rule1InStore") : t("rule1")}</li>
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
          <p>{t("intro", { total: program.stampsPerReward })}</p>
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

  const [loyalty, referral] = await Promise.all([
    getLoyaltySummary(db(), user, { page }),
    getMyReferral(db(), user),
  ]);
  const pages = Math.max(1, Math.ceil(loyalty.historyTotal / HISTORY_PAGE_SIZE));
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
          {loyalty.stampDebt > 0 ? (
            <Alert tone="warning">{t("debtNote", { count: loyalty.stampDebt })}</Alert>
          ) : null}
        </section>

        {loyalty.inStoreEnabled ? <CardCode /> : null}

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
                        {r.expiresAt ? (
                          <p className="text-sm text-espresso-muted">
                            {t("expires", {
                              date: format.dateTime(r.expiresAt, { dateStyle: "long" }),
                            })}
                          </p>
                        ) : null}
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
            <>
              <ul className="divide-y divide-line rounded-md border border-line bg-ivory-raised">
                {loyalty.history.map((h) => (
                  <HistoryEntry key={h.id} entry={h} locale={locale} />
                ))}
              </ul>
              {pages > 1 ? (
                <nav
                  aria-label={t("historyTitle")}
                  className="flex flex-wrap items-center justify-between gap-3"
                >
                  {page > 1 ? (
                    <Link href={`/rewards?page=${page - 1}`} className={buttonClasses("secondary")}>
                      {t("previous")}
                    </Link>
                  ) : (
                    <span />
                  )}
                  <span className="text-sm text-espresso-muted">
                    {t("pageOf", { page, pages })}
                  </span>
                  {page < pages ? (
                    <Link href={`/rewards?page=${page + 1}`} className={buttonClasses("secondary")}>
                      {t("next")}
                    </Link>
                  ) : (
                    <span />
                  )}
                </nav>
              ) : null}
            </>
          )}
        </section>

        {referral.enabled ? <Referral referral={referral} /> : null}
        {rules}
      </div>
    </Container>
  );
}

/** One ledger entry, explained: which drinks counted, which didn't and why, and any reason. */
async function HistoryEntry({ entry: h, locale }: { entry: LedgerEntryView; locale: string }) {
  const [t, format] = await Promise.all([getTranslations("Rewards"), getFormatter()]);
  const pick = (name: { fr: string; en: string }) => (locale === "fr" ? name.fr : name.en);
  const d = h.details;
  const notes: string[] = [];
  if (d.cause) notes.push(t(`causes.${d.cause}`));
  if (d.drink) notes.push(pick(d.drink));
  if (d.referral) notes.push(t(`referral.${d.referral}`));
  if (d.forgiven) notes.push(t("forgiven", { count: d.forgiven }));
  if (h.debtDelta > 0) notes.push(t("owed", { count: h.debtDelta }));
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-espresso">{t(`kinds.${h.kind}`)}</span>
        <span className="text-sm text-espresso-muted">
          {format.dateTime(h.createdAt, { dateStyle: "medium" })}
          {h.orderNumber && h.orderId ? (
            <>
              {" · "}
              <Link href={`/orders/${h.orderId}`} className="underline underline-offset-4">
                {t("orderRef", { number: h.orderNumber })}
              </Link>
            </>
          ) : null}
          {d.receiptReference ? ` · ${t("inStoreRef", { receipt: d.receiptReference })}` : null}
        </span>
        {notes.length > 0 ? (
          <span className="text-sm text-espresso-muted">{notes.join(" · ")}</span>
        ) : null}
        {h.kind === "earn" || h.kind === "reverse"
          ? d.lines?.map((l, i) => (
              <span key={i} className="text-sm text-espresso-muted">
                {t("counted", { quantity: l.stamps, name: pick(l.name), size: pick(l.size) })}
              </span>
            ))
          : null}
        {d.notCounted?.map((n, i) => (
          <span key={i} className="text-sm text-espresso-muted">
            {t("notCountedLine", {
              quantity: n.quantity,
              name: pick(n.name),
              reason: t(`notCounted.${n.reason}`),
            })}
          </span>
        ))}
        {h.reason ? (
          <span className="text-sm text-espresso">{t("reasonLine", { reason: h.reason })}</span>
        ) : null}
      </div>
      {h.stamps !== 0 ? (
        <Badge tone={h.stamps > 0 ? "success" : "neutral"}>
          {h.stamps > 0 ? `+${h.stamps}` : h.stamps}
        </Badge>
      ) : null}
    </li>
  );
}
