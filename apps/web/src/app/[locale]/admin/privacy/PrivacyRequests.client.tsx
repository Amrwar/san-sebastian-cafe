"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert, Badge, Button, SelectField, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";

const KINDS = ["access", "export", "rectification", "deletion", "withdrawal", "other"] as const;
const CHANNELS = ["email", "phone", "in_person", "mail"] as const;

export interface RequestView {
  id: string;
  kind: string;
  channel: string;
  status: string;
  contact: string | null;
  hasAccount: boolean;
  details: string | null;
  receivedAt: string;
  dueAt: string;
  completedAt: string | null;
  outcome: string | null;
  overdue: boolean;
}

/** Privacy requests: the list (open ones first, by due date), logging a new one, closing one. */
export function PrivacyRequests({ requests }: { requests: RequestView[] }) {
  const t = useTranslations("AdminPrivacy.requests");
  const tMenu = useTranslations("AdminMenu");
  const format = useFormatter();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    kind: "access",
    channel: "email",
    contact: "",
    details: "",
    receivedOn: "",
  });
  const [closing, setClosing] = useState<{
    id: string;
    status: "completed" | "refused";
    outcome: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });

  const run = async (call: () => Promise<unknown>, ok: string, after: () => void) => {
    setPending(true);
    setMessage(null);
    try {
      await call();
      after();
      setMessage({ ok: true, text: ok });
      router.refresh();
    } catch (e) {
      const f = e instanceof ApiError ? e.failure : null;
      setMessage({
        ok: false,
        text:
          f?.kind === "validation"
            ? tMenu("errors.validation")
            : f?.kind === "unprocessable"
              ? t("errors.future")
              : tMenu("errors.generic"),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {requests.length === 0 ? (
        <p className="text-espresso-muted">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {requests.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-espresso">
                  {t(`kinds.${r.kind as (typeof KINDS)[number]}`)}
                </span>
                <Badge tone={r.status === "open" ? (r.overdue ? "danger" : "warning") : "success"}>
                  {r.status === "open" && r.overdue
                    ? t("overdue")
                    : t(`statuses.${r.status as "open"}`)}
                </Badge>
                <span className="text-sm text-espresso-muted">
                  {t(`channels.${r.channel as "email"}`)} ·{" "}
                  {t("received", { date: date(r.receivedAt) })}
                  {r.status === "open" ? ` · ${t("due", { date: date(r.dueAt) })}` : ""}
                </span>
              </div>
              {r.contact ? (
                <p className="text-sm">
                  {r.contact}
                  {r.hasAccount ? (
                    <span className="text-espresso-muted"> · {t("hasAccount")}</span>
                  ) : null}
                </p>
              ) : null}
              {r.details ? <p className="text-sm text-espresso-muted">{r.details}</p> : null}
              {r.outcome ? <p className="text-sm">{t("outcome", { outcome: r.outcome })}</p> : null}
              {r.status === "open" ? (
                closing?.id === r.id ? (
                  <form
                    noValidate
                    className="flex flex-col gap-2 rounded-sm border border-line p-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(
                        () =>
                          apiFetch(`/api/v1/admin/privacy/requests/${r.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({
                              status: closing.status,
                              outcome: closing.outcome,
                            }),
                          }),
                        t("closed"),
                        () => {
                          setClosing(null);
                        },
                      );
                    }}
                  >
                    <SelectField
                      label={t("closeAs")}
                      value={closing.status}
                      onChange={(e) => {
                        setClosing({
                          ...closing,
                          status: e.currentTarget.value as "completed" | "refused",
                        });
                      }}
                    >
                      <option value="completed">{t("statuses.completed")}</option>
                      <option value="refused">{t("statuses.refused")}</option>
                    </SelectField>
                    <TextField
                      label={t("outcomeLabel")}
                      hint={t("outcomeHint")}
                      value={closing.outcome}
                      maxLength={1000}
                      onChange={(e) => {
                        setClosing({ ...closing, outcome: e.currentTarget.value });
                      }}
                    />
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        pending={pending}
                        disabled={pending || closing.outcome.trim().length < 3}
                      >
                        {t("close")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setClosing(null);
                        }}
                      >
                        {tMenu("cancel")}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="self-start"
                    onClick={() => {
                      setClosing({ id: r.id, status: "completed", outcome: "" });
                    }}
                  >
                    {t("close")}
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form
          noValidate
          className="flex flex-col gap-3 rounded-sm border border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                apiFetch("/api/v1/admin/privacy/requests", {
                  method: "POST",
                  body: JSON.stringify({
                    kind: draft.kind,
                    channel: draft.channel,
                    contact: draft.contact,
                    details: draft.details || null,
                    receivedOn: draft.receivedOn || null,
                  }),
                }),
              t("logged"),
              () => {
                setAdding(false);
                setDraft({
                  kind: "access",
                  channel: "email",
                  contact: "",
                  details: "",
                  receivedOn: "",
                });
              },
            );
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label={t("kind")}
              value={draft.kind}
              onChange={(e) => {
                setDraft({ ...draft, kind: e.currentTarget.value });
              }}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kinds.${k}`)}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={t("channel")}
              value={draft.channel}
              onChange={(e) => {
                setDraft({ ...draft, channel: e.currentTarget.value });
              }}
            >
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {t(`channels.${c}`)}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t("contact")}
              hint={t("contactHint")}
              value={draft.contact}
              maxLength={200}
              onChange={(e) => {
                setDraft({ ...draft, contact: e.currentTarget.value });
              }}
            />
            <TextField
              label={t("receivedOn")}
              type="date"
              value={draft.receivedOn}
              onChange={(e) => {
                setDraft({ ...draft, receivedOn: e.currentTarget.value });
              }}
            />
          </div>
          <TextField
            label={t("details")}
            optionalLabel={t("optional")}
            value={draft.details}
            maxLength={1000}
            onChange={(e) => {
              setDraft({ ...draft, details: e.currentTarget.value });
            }}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              pending={pending}
              disabled={pending || draft.contact.trim().length < 3}
            >
              {t("log")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setAdding(false);
              }}
            >
              {tMenu("cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          onClick={() => {
            setAdding(true);
          }}
        >
          {t("new")}
        </Button>
      )}
      <div aria-live="polite">
        {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
      </div>
    </div>
  );
}
