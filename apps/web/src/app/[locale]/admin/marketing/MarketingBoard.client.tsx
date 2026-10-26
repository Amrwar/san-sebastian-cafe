"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert, Badge, Button, Surface, TextAreaField, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";

interface CampaignRow {
  id: string;
  subjectFr: string;
  subjectEn: string;
  bodyFr: string;
  bodyEn: string;
  status: "draft" | "sent";
  recipientCount: number | null;
  sentAt: string | null;
  createdAt: string;
  delivered: number;
  skipped: number;
  pending: number;
}

const EMPTY = { subjectFr: "", subjectEn: "", bodyFr: "", bodyEn: "" };

export function MarketingBoard({
  sender,
  audienceCount,
  campaigns,
}: {
  sender: { name: string | null; address: string | null };
  audienceCount: number;
  campaigns: CampaignRow[];
}) {
  const t = useTranslations("AdminMarketing");
  const tMenu = useTranslations("AdminMenu");
  const format = useFormatter();
  const router = useRouter();
  const [name, setName] = useState(sender.name ?? "");
  const [address, setAddress] = useState(sender.address ?? "");
  /** "new", a draft id, or null. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const senderReady = Boolean(sender.name && sender.address);

  const run = async (call: () => Promise<unknown>, ok: string, after?: () => void) => {
    setPending(true);
    setMessage(null);
    try {
      await call();
      after?.();
      setMessage({ ok: true, text: ok });
      router.refresh();
    } catch (e) {
      const f = e instanceof ApiError ? e.failure : null;
      const reason = f?.kind === "unprocessable" || f?.kind === "conflict" ? f.reason : null;
      setMessage({
        ok: false,
        text:
          reason === "sender_missing"
            ? t("errors.sender")
            : reason === "campaign_sent"
              ? t("errors.sent")
              : f?.kind === "validation"
                ? t("errors.fields")
                : tMenu("errors.generic"),
      });
    } finally {
      setPending(false);
    }
  };

  const editor = (
    <form
      noValidate
      className="flex flex-col gap-3 rounded-sm border border-line p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            apiFetch(
              editing === "new"
                ? "/api/v1/admin/marketing/campaigns"
                : `/api/v1/admin/marketing/campaigns/${editing}`,
              { method: editing === "new" ? "POST" : "PUT", body: JSON.stringify(draft) },
            ),
          t("draftSaved"),
          () => {
            setEditing(null);
          },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t("subjectFr")}
          lang="fr"
          value={draft.subjectFr}
          maxLength={120}
          onChange={(e) => {
            setDraft({ ...draft, subjectFr: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("subjectEn")}
          lang="en"
          value={draft.subjectEn}
          maxLength={120}
          onChange={(e) => {
            setDraft({ ...draft, subjectEn: e.currentTarget.value });
          }}
        />
        <TextAreaField
          label={t("bodyFr")}
          hint={t("bodyHint")}
          lang="fr"
          rows={8}
          value={draft.bodyFr}
          maxLength={5000}
          onChange={(e) => {
            setDraft({ ...draft, bodyFr: e.currentTarget.value });
          }}
        />
        <TextAreaField
          label={t("bodyEn")}
          hint={t("bodyHint")}
          lang="en"
          rows={8}
          value={draft.bodyEn}
          maxLength={5000}
          onChange={(e) => {
            setDraft({ ...draft, bodyEn: e.currentTarget.value });
          }}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" pending={pending} disabled={pending}>
          {t("saveDraft")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setEditing(null);
          }}
        >
          {tMenu("cancel")}
        </Button>
      </div>
    </form>
  );

  return (
    <div className="flex flex-col gap-6">
      <Surface className="flex flex-col gap-3">
        <h2 className="font-display text-2xl text-espresso">{t("sender.title")}</h2>
        <p className="text-sm text-espresso-muted">{t("sender.hint")}</p>
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                apiFetch("/api/v1/admin/marketing/sender", {
                  method: "PUT",
                  body: JSON.stringify({ name, address }),
                }),
              t("sender.saved"),
            );
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={t("sender.name")}
              value={name}
              maxLength={120}
              onChange={(e) => {
                setName(e.currentTarget.value);
              }}
            />
            <TextField
              label={t("sender.address")}
              hint={t("sender.addressHint")}
              value={address}
              maxLength={300}
              onChange={(e) => {
                setAddress(e.currentTarget.value);
              }}
            />
          </div>
          <Button type="submit" variant="secondary" className="self-start" disabled={pending}>
            {t("sender.save")}
          </Button>
        </form>
      </Surface>

      <Surface className="flex flex-col gap-3">
        <h2 className="font-display text-2xl text-espresso">{t("campaigns")}</h2>
        <p className="text-sm text-espresso-muted">{t("audience", { count: audienceCount })}</p>
        {!senderReady ? <Alert tone="warning">{t("errors.sender")}</Alert> : null}
        {editing === "new" ? (
          editor
        ) : (
          <Button
            type="button"
            className="self-start"
            onClick={() => {
              setEditing("new");
              setDraft(EMPTY);
              setMessage(null);
            }}
          >
            {t("new")}
          </Button>
        )}
        <div aria-live="polite">
          {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
        </div>
        {campaigns.length === 0 ? <p className="text-espresso-muted">{t("empty")}</p> : null}
        <ul className="flex flex-col divide-y divide-line">
          {campaigns.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-espresso">{c.subjectFr}</span>
                <Badge tone={c.status === "sent" ? "success" : "neutral"}>
                  {t(`statuses.${c.status}`)}
                </Badge>
              </div>
              {c.status === "sent" && c.sentAt ? (
                <p className="text-sm text-espresso-muted">
                  {t("sentSummary", {
                    date: format.dateTime(new Date(c.sentAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                    recipients: c.recipientCount ?? 0,
                    delivered: c.delivered,
                    skipped: c.skipped,
                    pending: c.pending,
                  })}
                </p>
              ) : null}
              {editing === c.id ? (
                editor
              ) : c.status === "draft" ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setEditing(c.id);
                      setDraft({
                        subjectFr: c.subjectFr,
                        subjectEn: c.subjectEn,
                        bodyFr: c.bodyFr,
                        bodyEn: c.bodyEn,
                      });
                      setMessage(null);
                    }}
                  >
                    {t("edit")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pending || !senderReady}
                    onClick={() =>
                      void run(
                        () =>
                          apiFetch(`/api/v1/admin/marketing/campaigns/${c.id}/test`, {
                            method: "POST",
                            body: JSON.stringify({ locale: "fr" }),
                          }),
                        t("testSent"),
                      )
                    }
                  >
                    {t("sendTest")}
                  </Button>
                  {confirming === c.id ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        pending={pending}
                        disabled={pending}
                        onClick={() =>
                          void run(
                            () =>
                              apiFetch(`/api/v1/admin/marketing/campaigns/${c.id}/send`, {
                                method: "POST",
                              }),
                            t("sent", { count: audienceCount }),
                            () => {
                              setConfirming(null);
                            },
                          )
                        }
                      >
                        {t("confirmSend", { count: audienceCount })}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setConfirming(null);
                        }}
                      >
                        {tMenu("cancel")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      disabled={pending || !senderReady || audienceCount === 0}
                      onClick={() => {
                        setConfirming(c.id);
                      }}
                    >
                      {t("send")}
                    </Button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Surface>
    </div>
  );
}
