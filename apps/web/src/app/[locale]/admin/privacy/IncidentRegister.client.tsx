"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  Alert,
  Badge,
  Button,
  CheckboxField,
  SelectField,
  TextAreaField,
  TextField,
} from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { IncidentInput } from "@/server/modules/privacy/incidents";

export interface IncidentView extends IncidentInput {
  id: string;
  recordedAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface Draft {
  occurredOn: string;
  discoveredOn: string;
  description: string;
  dataInvolved: string;
  peopleAffected: string;
  risk: "unknown" | "yes" | "no";
  riskAssessment: string;
  measuresTaken: string;
  commissionNotifiedOn: string;
  peopleNotifiedOn: string;
  closed: boolean;
}

const toDraft = (i: IncidentView | null): Draft => ({
  occurredOn: i?.occurredOn ?? "",
  discoveredOn: i?.discoveredOn ?? "",
  description: i?.description ?? "",
  dataInvolved: i?.dataInvolved ?? "",
  peopleAffected: i?.peopleAffected === null || i === null ? "" : String(i.peopleAffected),
  risk:
    i?.riskOfSeriousInjury === true ? "yes" : i?.riskOfSeriousInjury === false ? "no" : "unknown",
  riskAssessment: i?.riskAssessment ?? "",
  measuresTaken: i?.measuresTaken ?? "",
  commissionNotifiedOn: i?.commissionNotifiedOn ?? "",
  peopleNotifiedOn: i?.peopleNotifiedOn ?? "",
  closed: i?.closed ?? false,
});

/** The incident register: every entry, newest first, each correctable; nothing is ever deleted. */
export function IncidentRegister({ incidents }: { incidents: IncidentView[] }) {
  const t = useTranslations("AdminPrivacy.incidents");
  const tMenu = useTranslations("AdminMenu");
  const format = useFormatter();
  const router = useRouter();
  /** "new", an incident id, or null when no form is open. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  const open = (incident: IncidentView | null) => {
    setEditing(incident?.id ?? "new");
    setDraft(toDraft(incident));
    setMessage(null);
  };

  const save = async () => {
    const body: IncidentInput = {
      occurredOn: draft.occurredOn || null,
      discoveredOn: draft.discoveredOn,
      description: draft.description,
      dataInvolved: draft.dataInvolved,
      peopleAffected: draft.peopleAffected.trim() === "" ? null : Number(draft.peopleAffected),
      riskOfSeriousInjury: draft.risk === "unknown" ? null : draft.risk === "yes",
      riskAssessment: draft.riskAssessment || null,
      measuresTaken: draft.measuresTaken || null,
      commissionNotifiedOn: draft.commissionNotifiedOn || null,
      peopleNotifiedOn: draft.peopleNotifiedOn || null,
      closed: draft.closed,
    };
    setPending(true);
    setMessage(null);
    try {
      await apiFetch(
        editing === "new"
          ? "/api/v1/admin/privacy/incidents"
          : `/api/v1/admin/privacy/incidents/${editing}`,
        { method: editing === "new" ? "POST" : "PUT", body: JSON.stringify(body) },
      );
      setEditing(null);
      setMessage({ ok: true, text: t("saved") });
      router.refresh();
    } catch (e) {
      const f = e instanceof ApiError ? e.failure : null;
      const fields = f?.kind === "validation" ? f.fields : [];
      setMessage({
        ok: false,
        text: fields.some((p) => p === "commissionNotifiedOn" || p === "peopleNotifiedOn")
          ? t("errors.notify")
          : fields.includes("riskOfSeriousInjury")
            ? t("errors.assess")
            : f?.kind === "validation"
              ? t("errors.fields")
              : tMenu("errors.generic"),
      });
    } finally {
      setPending(false);
    }
  };

  const form = (
    <form
      noValidate
      className="flex flex-col gap-3 rounded-sm border border-line p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t("discoveredOn")}
          type="date"
          value={draft.discoveredOn}
          onChange={(e) => {
            set({ discoveredOn: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("occurredOn")}
          optionalLabel={t("ifKnown")}
          type="date"
          value={draft.occurredOn}
          onChange={(e) => {
            set({ occurredOn: e.currentTarget.value });
          }}
        />
      </div>
      <TextAreaField
        label={t("description")}
        hint={t("descriptionHint")}
        value={draft.description}
        maxLength={4000}
        onChange={(e) => {
          set({ description: e.currentTarget.value });
        }}
      />
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <TextField
          label={t("dataInvolved")}
          hint={t("dataInvolvedHint")}
          value={draft.dataInvolved}
          maxLength={1000}
          onChange={(e) => {
            set({ dataInvolved: e.currentTarget.value });
          }}
        />
        <TextField
          label={t("peopleAffected")}
          optionalLabel={t("ifKnown")}
          type="number"
          min={0}
          inputMode="numeric"
          value={draft.peopleAffected}
          onChange={(e) => {
            set({ peopleAffected: e.currentTarget.value });
          }}
        />
      </div>
      <SelectField
        label={t("risk")}
        hint={t("riskHint")}
        value={draft.risk}
        onChange={(e) => {
          set({ risk: e.currentTarget.value as Draft["risk"] });
        }}
      >
        <option value="unknown">{t("riskUnknown")}</option>
        <option value="yes">{t("riskYes")}</option>
        <option value="no">{t("riskNo")}</option>
      </SelectField>
      <TextAreaField
        label={t("riskAssessment")}
        optionalLabel={t("optional")}
        value={draft.riskAssessment}
        rows={3}
        maxLength={4000}
        onChange={(e) => {
          set({ riskAssessment: e.currentTarget.value });
        }}
      />
      <TextAreaField
        label={t("measuresTaken")}
        optionalLabel={t("optional")}
        value={draft.measuresTaken}
        rows={3}
        maxLength={4000}
        onChange={(e) => {
          set({ measuresTaken: e.currentTarget.value });
        }}
      />
      {draft.risk === "yes" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t("commissionNotifiedOn")}
            type="date"
            value={draft.commissionNotifiedOn}
            onChange={(e) => {
              set({ commissionNotifiedOn: e.currentTarget.value });
            }}
          />
          <TextField
            label={t("peopleNotifiedOn")}
            type="date"
            value={draft.peopleNotifiedOn}
            onChange={(e) => {
              set({ peopleNotifiedOn: e.currentTarget.value });
            }}
          />
        </div>
      ) : null}
      <CheckboxField
        label={t("closedLabel")}
        hint={t("closedHint")}
        checked={draft.closed}
        onChange={(e) => {
          set({ closed: e.currentTarget.checked });
        }}
      />
      <div className="flex gap-2">
        <Button type="submit" pending={pending} disabled={pending}>
          {t("save")}
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
    <div className="flex flex-col gap-4">
      {incidents.length === 0 ? <p className="text-espresso-muted">{t("empty")}</p> : null}
      <ul className="flex flex-col divide-y divide-line">
        {incidents.map((i) => (
          <li key={i.id} className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-espresso">
                {t("discovered", { date: day(i.discoveredOn) })}
              </span>
              <Badge tone={i.closed ? "success" : "warning"}>
                {i.closed ? t("closedBadge") : t("openBadge")}
              </Badge>
              {i.riskOfSeriousInjury === true ? <Badge tone="danger">{t("serious")}</Badge> : null}
              {i.riskOfSeriousInjury === null ? <Badge>{t("notAssessed")}</Badge> : null}
            </div>
            <p className="text-sm">{i.description}</p>
            <p className="text-sm text-espresso-muted">
              {t("dataSummary", { data: i.dataInvolved, count: i.peopleAffected ?? -1 })}
            </p>
            {i.riskOfSeriousInjury ? (
              <p className="text-sm text-espresso-muted">
                {t("notices", {
                  commission: i.commissionNotifiedOn ? day(i.commissionNotifiedOn) : t("notYet"),
                  people: i.peopleNotifiedOn ? day(i.peopleNotifiedOn) : t("notYet"),
                })}
              </p>
            ) : null}
            {editing === i.id ? (
              form
            ) : (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="self-start"
                onClick={() => {
                  open(i);
                }}
              >
                {t("edit")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {editing === "new" ? (
        form
      ) : (
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          onClick={() => {
            open(null);
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
