"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert, Badge, Button, SelectField, Surface, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { TeamMember } from "@/server/modules/admin/team";

const ROLES = ["staff", "shift_lead", "manager"] as const;
type AssignableRole = (typeof ROLES)[number];
const isAssignable = (v: string): v is AssignableRole => (ROLES as readonly string[]).includes(v);

function useTeamAction() {
  const t = useTranslations("AdminTeam");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async (email: string, role: AssignableRole | "customer", ok: string) => {
    setPending(true);
    setMessage(null);
    try {
      await apiFetch("/api/v1/admin/team", {
        method: "PUT",
        body: JSON.stringify({ email, role }),
      });
      setMessage({ ok: true, text: ok });
      router.refresh();
      return true;
    } catch (e) {
      const f = e instanceof ApiError ? e.failure : null;
      const reason = f && "reason" in f ? f.reason : null;
      setMessage({
        ok: false,
        text:
          f?.kind === "forbidden"
            ? t("errors.forbidden")
            : f?.kind === "validation"
              ? t("errors.email")
              : reason && t.has(`errors.${reason}`)
                ? t(`errors.${reason}` as "errors.generic")
                : t("errors.generic"),
      });
      return false;
    } finally {
      setPending(false);
    }
  };
  return { pending, message, send };
}

function Feedback({ message }: { message: { ok: boolean; text: string } | null }) {
  return (
    <div aria-live="polite">
      {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
    </div>
  );
}

export function InviteForm() {
  const t = useTranslations("AdminTeam");
  const tRoles = useTranslations("Roles");
  const { pending, message, send } = useTeamAction();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("staff");

  return (
    <Surface>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const address = email.trim();
          void send(address, role, t("invited", { email: address })).then((ok) => {
            if (ok) setEmail("");
          });
        }}
      >
        <h2 className="font-display text-2xl text-espresso">{t("inviteTitle")}</h2>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <TextField
            label={t("email")}
            type="email"
            autoComplete="off"
            maxLength={254}
            value={email}
            onChange={(e) => {
              setEmail(e.currentTarget.value);
            }}
          />
          <SelectField
            label={t("role")}
            value={role}
            onChange={(e) => {
              const value = e.currentTarget.value;
              if (isAssignable(value)) setRole(value);
            }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {tRoles(r)}
              </option>
            ))}
          </SelectField>
        </div>
        <ul className="flex flex-col gap-1 text-sm text-espresso-muted">
          {ROLES.map((r) => (
            <li key={r}>{t(`rolesHelp.${r}`)}</li>
          ))}
        </ul>
        <Button
          type="submit"
          pending={pending}
          disabled={pending || !email.trim()}
          className="self-start"
        >
          {t("invite")}
        </Button>
        <Feedback message={message} />
      </form>
    </Surface>
  );
}

export function MemberRow({ member, isSelf }: { member: TeamMember; isSelf: boolean }) {
  const t = useTranslations("AdminTeam");
  const tRoles = useTranslations("Roles");
  const format = useFormatter();
  const { pending, message, send } = useTeamAction();
  const [role, setRole] = useState(member.role);
  const [confirming, setConfirming] = useState(false);
  const name = member.name || member.email;
  const editable = !isSelf && member.role !== "owner";

  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-2 font-semibold text-espresso">
            {member.name || t("noName")}
            <Badge tone={member.role === "owner" ? "brand" : "neutral"}>
              {tRoles(member.role)}
            </Badge>
            {isSelf ? <Badge>{t("you")}</Badge> : null}
          </span>
          <span className="break-all text-sm text-espresso-muted">{member.email}</span>
          <span className="text-sm text-espresso-muted">
            {member.lastSignInAt
              ? t("lastSignIn", {
                  date: format.dateTime(member.lastSignInAt, { dateStyle: "medium" }),
                })
              : t("neverSignedIn")}
          </span>
        </div>
        {editable ? (
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label={t("changeRole", { name })}
              value={role}
              onChange={(e) => {
                const value = e.currentTarget.value;
                if (isAssignable(value)) setRole(value);
              }}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {tRoles(r)}
                </option>
              ))}
            </SelectField>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending || role === member.role || !isAssignable(role)}
              onClick={() => {
                if (isAssignable(role)) void send(member.email, role, t("updated"));
              }}
            >
              {t("save")}
            </Button>
            {confirming ? null : (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t("removeAccess")}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {confirming ? (
        <div
          role="group"
          aria-label={t("removeAccess")}
          className="flex flex-wrap items-center gap-2"
        >
          <span className="text-sm text-espresso">{t("confirmRemove", { name })}</span>
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() => {
              setConfirming(false);
              void send(member.email, "customer", t("removed"));
            }}
          >
            {t("confirm")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirming(false);
            }}
          >
            {t("cancel")}
          </Button>
        </div>
      ) : null}
      <Feedback message={message} />
    </li>
  );
}
