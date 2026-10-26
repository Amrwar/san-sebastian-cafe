"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Alert, Badge, Button, Surface, TextField } from "@ssc/ui";
import { ApiError, apiFetch } from "@/lib/api-client";
import { money } from "@/lib/format";

interface CardView {
  id: string;
  last4: string;
  initialCents: number;
  balanceCents: number;
  status: "active" | "disabled";
  issuedAt: string;
  note: string | null;
  history: Array<{
    id: string;
    kind: "issue" | "redeem" | "release" | "refund" | "adjustment";
    deltaCents: number;
    balanceAfterCents: number;
    note: string | null;
    createdAt: string;
    orderNumber: string | null;
    actorName: string | null;
  }>;
}

/** "12,50" or "12.50" → 1250; null when not a positive amount with at most two decimals. */
function toCents(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return cents > 0 ? cents : null;
}

/** Turns a refusal into the message staff see. */
function useProblem() {
  const t = useTranslations("StaffGiftCards");
  return (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.failure.kind === "not_found") return t("errors.notFound");
      if (e.failure.kind === "forbidden") return t("errors.forbidden");
      const reason = e.failure.kind === "unprocessable" ? e.failure.reason : undefined;
      if (reason === "gift_card_insufficient") return t("errors.insufficient");
      if (reason === "gift_card_disabled") return t("errors.disabled");
      if (e.failure.kind === "validation") return t("errors.invalid");
    }
    return t("errors.generic");
  };
}

/** The counter's gift card desk. Every change is recorded in the card's ledger and the audit log. */
export function GiftCardDesk({ canIssue, canAdjust }: { canIssue: boolean; canAdjust: boolean }) {
  const [card, setCard] = useState<CardView | null>(null);
  return (
    <div className="flex flex-col gap-8">
      {canIssue ? <IssueCard /> : null}
      <FindCard onFound={setCard} />
      {card ? (
        <CardPanel card={card} onChange={setCard} canIssue={canIssue} canAdjust={canAdjust} />
      ) : null}
    </div>
  );
}

function IssueCard() {
  const t = useTranslations("StaffGiftCards");
  const locale = useLocale();
  const problem = useProblem();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ code: string; balanceCents: number } | null>(null);

  const submit = async () => {
    const amountCents = toCents(amount);
    if (amountCents === null || amountCents < 500 || amountCents > 50_000) {
      setError(t("issue.amountInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setIssued(
        await apiFetch<{ code: string; balanceCents: number }>("/api/v1/staff/gift-cards", {
          method: "POST",
          body: JSON.stringify({ amountCents, note: note.trim() || undefined }),
        }),
      );
      setAmount("");
      setNote("");
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface as="section" aria-labelledby="gc-issue" className="flex flex-col gap-4">
      <h2 id="gc-issue" className="font-display text-2xl text-espresso">
        {t("issue.title")}
      </h2>
      <p className="text-sm text-espresso-muted">{t("issue.help")}</p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t("issue.amount")}
          hint={t("issue.amountHint")}
          inputMode="decimal"
          className="w-48"
          value={amount}
          onChange={(e) => {
            setAmount(e.currentTarget.value);
          }}
        />
        <TextField
          label={t("issue.note")}
          hint={t("issue.noteHint")}
          className="min-w-0 flex-1"
          value={note}
          onChange={(e) => {
            setNote(e.currentTarget.value);
          }}
        />
        <Button type="submit" pending={busy} disabled={busy}>
          {t("issue.submit")}
        </Button>
      </form>
      <div aria-live="polite">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {issued ? (
          <Alert
            tone="success"
            title={t("issue.done", { amount: money(issued.balanceCents, locale) })}
          >
            <p
              className="mt-2 font-mono text-3xl tracking-wider text-espresso"
              data-testid="gift-card-code"
            >
              {issued.code}
            </p>
            <p className="mt-2 text-sm">{t("issue.shownOnce")}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => {
                window.print();
              }}
            >
              {t("issue.print")}
            </Button>
          </Alert>
        ) : null}
      </div>
    </Surface>
  );
}

function FindCard({ onFound }: { onFound: (card: CardView | null) => void }) {
  const t = useTranslations("StaffGiftCards");
  const problem = useProblem();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (code.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      onFound(
        await apiFetch<CardView>("/api/v1/staff/gift-cards/lookup", {
          method: "POST",
          body: JSON.stringify({ code: code.trim() }),
        }),
      );
    } catch (e) {
      onFound(null);
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface as="section" aria-labelledby="gc-find" className="flex flex-col gap-4">
      <h2 id="gc-find" className="font-display text-2xl text-espresso">
        {t("find.title")}
      </h2>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t("find.code")}
          hint={t("find.codeHint")}
          autoComplete="off"
          className="min-w-0 flex-1"
          value={code}
          onChange={(e) => {
            setCode(e.currentTarget.value);
          }}
        />
        <Button type="submit" variant="secondary" pending={busy} disabled={busy}>
          {t("find.submit")}
        </Button>
      </form>
      <div aria-live="polite">{error ? <Alert tone="danger">{error}</Alert> : null}</div>
    </Surface>
  );
}

function CardPanel({
  card,
  onChange,
  canIssue,
  canAdjust,
}: {
  card: CardView;
  onChange: (card: CardView) => void;
  canIssue: boolean;
  canAdjust: boolean;
}) {
  const t = useTranslations("StaffGiftCards");
  const locale = useLocale();
  const problem = useProblem();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const when = new Intl.DateTimeFormat(locale === "en" ? "en-CA" : "fr-CA", {
    dateStyle: "short",
    timeStyle: "short",
  });

  const act = async (path: string, body: object, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      onChange(
        await apiFetch<CardView>(`/api/v1/staff/gift-cards/${card.id}/${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      setMessage({ ok: true, text: done });
      return true;
    } catch (e) {
      setMessage({ ok: false, text: problem(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface as="section" aria-labelledby="gc-card" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="gc-card" className="font-display text-2xl text-espresso">
          {t("card.title", { last4: card.last4 })}
        </h2>
        <Badge tone={card.status === "active" ? "success" : "warning"}>
          {t(`card.status.${card.status}`)}
        </Badge>
      </div>
      <p className="font-display text-4xl tabular-nums text-espresso">
        {money(card.balanceCents, locale)}
      </p>
      <p className="text-sm text-espresso-muted">
        {t("card.issued", {
          amount: money(card.initialCents, locale),
          date: when.format(new Date(card.issuedAt)),
        })}
      </p>

      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>

      {card.status === "active" ? (
        <AmountForm
          title={t("redeem.title")}
          amountLabel={t("redeem.amount")}
          noteLabel={t("redeem.note")}
          submitLabel={t("redeem.submit")}
          busy={busy}
          onSubmit={(amountCents, note) =>
            act("redeem", { amountCents, note: note || undefined }, t("redeem.done"))
          }
        />
      ) : null}

      {canIssue ? (
        <ReasonForm
          title={card.status === "active" ? t("status.disableTitle") : t("status.enableTitle")}
          submitLabel={card.status === "active" ? t("status.disable") : t("status.enable")}
          busy={busy}
          onSubmit={(reason) =>
            act(
              "status",
              { status: card.status === "active" ? "disabled" : "active", reason },
              t("status.done"),
            )
          }
        />
      ) : null}

      {canAdjust ? (
        <AmountForm
          title={t("adjust.title")}
          amountLabel={t("adjust.amount")}
          noteLabel={t("adjust.reason")}
          submitLabel={t("adjust.submit")}
          signed
          noteRequired
          busy={busy}
          onSubmit={(deltaCents, reason) => act("adjust", { deltaCents, reason }, t("adjust.done"))}
        />
      ) : null}

      <section aria-labelledby="gc-history" className="flex flex-col gap-2">
        <h3 id="gc-history" className="font-semibold text-espresso">
          {t("history.title")}
        </h3>
        <ol className="flex flex-col gap-1 text-sm text-espresso">
          {card.history.map((h) => (
            <li key={h.id} className="flex flex-wrap gap-x-2">
              <time dateTime={h.createdAt} className="tabular-nums text-espresso-muted">
                {when.format(new Date(h.createdAt))}
              </time>
              <span className="font-semibold tabular-nums">
                {h.deltaCents > 0 ? "+" : "−"}
                {money(Math.abs(h.deltaCents), locale)}
              </span>
              <span>{t(`history.kind.${h.kind}`, { number: h.orderNumber ?? "—" })}</span>
              {h.actorName ? <span>{t("history.by", { name: h.actorName })}</span> : null}
              {h.note ? <span className="text-espresso-muted">« {h.note} »</span> : null}
              <span className="text-espresso-muted">
                {t("history.after", { amount: money(h.balanceAfterCents, locale) })}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </Surface>
  );
}

function AmountForm({
  title,
  amountLabel,
  noteLabel,
  submitLabel,
  signed = false,
  noteRequired = false,
  busy,
  onSubmit,
}: {
  title: string;
  amountLabel: string;
  noteLabel: string;
  submitLabel: string;
  /** Allows a leading minus (corrections). */
  signed?: boolean;
  noteRequired?: boolean;
  busy: boolean;
  onSubmit: (cents: number, note: string) => Promise<boolean>;
}) {
  const t = useTranslations("StaffGiftCards");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  return (
    <form
      className="flex flex-col gap-3 border-t border-line pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        const negative = signed && amount.trim().startsWith("-");
        const cents = toCents(negative ? amount.trim().slice(1) : amount);
        if (cents === null) {
          setError(t("errors.amount"));
          return;
        }
        if (noteRequired && note.trim().length < 3) {
          setError(t("errors.reason"));
          return;
        }
        setError(undefined);
        void onSubmit(negative ? -cents : cents, note.trim()).then((ok) => {
          if (ok) {
            setAmount("");
            setNote("");
          }
        });
      }}
    >
      <h3 className="font-semibold text-espresso">{title}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={amountLabel}
          inputMode="decimal"
          className="w-48"
          value={amount}
          error={error}
          onChange={(e) => {
            setAmount(e.currentTarget.value);
          }}
        />
        <TextField
          label={noteLabel}
          className="min-w-0 flex-1"
          value={note}
          onChange={(e) => {
            setNote(e.currentTarget.value);
          }}
        />
        <Button type="submit" variant="secondary" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function ReasonForm({
  title,
  submitLabel,
  busy,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (reason: string) => Promise<boolean>;
}) {
  const t = useTranslations("StaffGiftCards");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  return (
    <form
      className="flex flex-col gap-3 border-t border-line pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length < 3) {
          setError(t("errors.reason"));
          return;
        }
        setError(undefined);
        void onSubmit(reason.trim()).then((ok) => {
          if (ok) setReason("");
        });
      }}
    >
      <h3 className="font-semibold text-espresso">{title}</h3>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={t("status.reason")}
          className="min-w-0 flex-1"
          value={reason}
          error={error}
          onChange={(e) => {
            setReason(e.currentTarget.value);
          }}
        />
        <Button type="submit" variant="secondary" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
