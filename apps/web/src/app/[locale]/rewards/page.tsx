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
  type LoyaltySummary,
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

  const steps = [
    { title: t("step1Title"), body: program.inStoreEnabled ? t("rule1InStore") : t("rule1") },
    { title: t("step2Title"), body: t("rule2") },
    { title: t("step3Title"), body: t("rule3") },
  ];
  const howItWorks = (
    <section aria-labelledby="how-title" className="bg-ivory-sunken py-12">
      <Container>
        <h2 id="how-title" className="mb-6 font-display text-3xl text-espresso">
          {t("rulesTitle")}
        </h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={i} className="rounded-md border border-line bg-ivory-raised p-6">
              <span aria-hidden="true" className="font-display text-4xl text-burgundy">
                {i + 1}
              </span>
              <p className="mt-2 text-lg font-semibold text-espresso">{s.title}</p>
              <p className="mt-1 leading-relaxed text-espresso-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );

  // Signed-out visitors see an empty card, how the programme works and an invitation to join.
  if (!user) {
    return (
      <>
        <Container className="grid items-center gap-10 pb-12 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <div className="flex flex-col items-start gap-2 lg:order-2">
            <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
              <p>{t("intro", { total: program.stampsPerReward })}</p>
            </PageHeader>
            <Link
              href={`/sign-in?mode=register&next=${encodeURIComponent(`/${locale}/rewards`)}`}
              className={buttonClasses("primary", "lg")}
            >
              {tCommon("signIn")}
            </Link>
          </div>
          <div className="lg:order-1 lg:pt-14">
            <StampCard count={0} total={program.stampsPerReward} />
          </div>
        </Container>
        {howItWorks}
      </>
    );
  }

  const [loyalty, referral] = await Promise.all([
    getLoyaltySummary(db(), user, { page }),
    getMyReferral(db(), user),
  ]);
  const pages = Math.max(1, Math.ceil(loyalty.historyTotal / HISTORY_PAGE_SIZE));
  const { newStamps, justUnlocked } = page === 1 ? recentActivity(loyalty) : NO_ACTIVITY;
  const wallet = loyalty.availableRewards;
  return (
    <>
      {/* Phones read title → card → wallet; desktops put the card on the left of both. */}
      <Container className="grid gap-x-16 gap-y-8 pb-12 lg:grid-cols-[1.1fr_1fr]">
        <div className="lg:col-start-2 lg:row-start-1 lg:self-end">
          <PageHeader eyebrow={t("eyebrow")} title={t("title")}>
            <p>{t("intro", { total: loyalty.stampsPerReward })}</p>
          </PageHeader>
        </div>
        <section
          aria-labelledby="stamp-card"
          className="flex flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:self-center lg:pt-14"
        >
          <h2 id="stamp-card" className="sr-only">
            {t("cardLabel", { count: loyalty.stampBalance, total: loyalty.stampsPerReward })}
          </h2>
          <StampCard
            count={loyalty.stampBalance}
            total={loyalty.stampsPerReward}
            newStamps={newStamps}
            justUnlocked={justUnlocked}
          />
          <p className="text-sm text-espresso-muted">
            {t("lifetime", { count: loyalty.lifetimeStamps })}
            {loyalty.isDemo ? ` · ${t("demoNote")}` : ""}
          </p>
          {loyalty.stampDebt > 0 ? (
            <Alert tone="warning">{t("debtNote", { count: loyalty.stampDebt })}</Alert>
          ) : null}
        </section>
        <section
          aria-labelledby="wallet-title"
          className="on-dark flex flex-wrap items-center justify-between gap-4 self-start rounded-lg bg-espresso p-6 text-ivory lg:col-start-2 lg:row-start-2"
        >
          <div>
            <h2
              id="wallet-title"
              className="text-xs font-semibold uppercase tracking-[0.14em] text-crema"
            >
              {t("inWallet")}
            </h2>
            <p className="mt-1 font-display text-3xl">
              {wallet.length === 0 ? t("walletEmpty") : t("walletCount", { count: wallet.length })}
            </p>
          </div>
          {wallet.length > 0 ? (
            <Link
              href="/menu"
              className="inline-flex min-h-11 shrink-0 items-center rounded-pill bg-ivory px-5 font-semibold text-espresso hover:bg-ivory-raised"
            >
              {t("useIt")}
            </Link>
          ) : null}
        </section>
      </Container>

      <Container className="pb-10">
        <AccountNav current="rewards" role={user.role} />
      </Container>

      {wallet.length > 0 ? (
        <Container className="pb-12">
          <section aria-labelledby="wallet-detail" className="flex flex-col gap-3">
            <h2 id="wallet-detail" className="font-display text-3xl text-espresso">
              {t("walletTitle")}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {wallet.map((r) => (
                <li key={r.id}>
                  <Surface className="flex items-center gap-4">
                    <span className="on-dark flex size-12 shrink-0 items-center justify-center rounded-pill bg-burgundy text-ivory">
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
          </section>
        </Container>
      ) : null}

      {howItWorks}

      <Container className="flex flex-col gap-10 py-12">
        {loyalty.inStoreEnabled ? <CardCode /> : null}

        <section aria-labelledby="history-title" className="flex flex-col gap-3">
          <h2 id="history-title" className="font-display text-3xl text-espresso">
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
      </Container>
    </>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_ACTIVITY = { newStamps: 0, justUnlocked: false };

/**
 * What happened to the card in the last day, read from the newest ledger entries: stamps earned
 * since the card last started over, and whether a free drink was unlocked.
 */
function recentActivity(loyalty: LoyaltySummary): { newStamps: number; justUnlocked: boolean } {
  const since = Date.now() - DAY_MS;
  let newStamps = 0;
  for (const h of loyalty.history) {
    if (h.createdAt.getTime() < since || h.kind === "convert") break;
    if (h.kind === "earn") newStamps += h.stamps;
  }
  const justUnlocked =
    loyalty.stampBalance === 0 &&
    loyalty.availableRewards.some((r) => r.issuedAt.getTime() >= since);
  return { newStamps, justUnlocked };
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
