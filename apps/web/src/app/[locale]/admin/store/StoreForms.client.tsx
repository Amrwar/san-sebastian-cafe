"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Alert, Button, CheckboxField, Surface, TextField } from "@ssc/ui";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { StoreAdmin, StoreSettingsInput } from "@/server/modules/admin/store";

type Message = { ok: boolean; text: string } | null;

function useSubmit() {
  const t = useTranslations("AdminStore");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const run = async (action: () => Promise<string | null>) => {
    setPending(true);
    setMessage(null);
    try {
      const note = await action();
      setMessage({ ok: true, text: note ?? t("saved") });
      router.refresh();
    } catch (e) {
      const f = e instanceof ApiError ? e.failure : null;
      setMessage({
        ok: false,
        text: f?.kind === "forbidden" ? t("errors.forbidden") : t("errors.generic"),
      });
    } finally {
      setPending(false);
    }
  };
  return { pending, message, setMessage, run };
}

function Feedback({ message }: { message: Message }) {
  return (
    <div aria-live="polite">
      {message ? <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert> : null}
    </div>
  );
}

const NUMBERS = {
  prepMinutes: [0, 240],
  slotMinutes: [5, 120],
  daysAhead: [0, 14],
  orderCutoffMinutes: [0, 240],
  minLeadMinutes: [0, 1440],
  unpaidTtlMinutes: [5, 120],
} as const;
type NumberField = keyof typeof NUMBERS;

export function SettingsForm({ settings }: { settings: StoreAdmin["settings"] }) {
  const t = useTranslations("AdminStore");
  const { pending, message, run } = useSubmit();
  const [flags, setFlags] = useState({
    onlineOrderingEnabled: settings.onlineOrderingEnabled,
    autoAccept: settings.autoAccept,
  });
  const [numbers, setNumbers] = useState<Record<NumberField, string>>({
    prepMinutes: String(settings.prepMinutes),
    slotMinutes: String(settings.slotMinutes),
    daysAhead: String(settings.daysAhead),
    orderCutoffMinutes: String(settings.orderCutoffMinutes ?? 0),
    minLeadMinutes: String(settings.minLeadMinutes ?? 0),
    unpaidTtlMinutes: String(settings.unpaidTtlMinutes),
  });
  const [maxPerSlot, setMaxPerSlot] = useState(
    settings.maxOrdersPerSlot ? String(settings.maxOrdersPerSlot) : "",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    const next: Record<string, string> = {};
    const values = {} as Record<NumberField, number>;
    for (const key of Object.keys(NUMBERS) as NumberField[]) {
      const [min, max] = NUMBERS[key];
      const n = Number(numbers[key]);
      if (!numbers[key].trim() || !Number.isInteger(n) || n < min || n > max)
        next[key] = t("errors.number", { min, max });
      values[key] = n;
    }
    const cap = maxPerSlot.trim() ? Number(maxPerSlot) : null;
    if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 500))
      next.maxOrdersPerSlot = t("errors.number", { min: 1, max: 500 });
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body: StoreSettingsInput = { ...flags, ...values, maxOrdersPerSlot: cap };
    void run(async () => {
      await apiFetch("/api/v1/admin/store/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return null;
    });
  };

  return (
    <Surface>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="font-display text-2xl text-espresso">{t("settingsTitle")}</h2>
        <CheckboxField
          label={t("onlineOrderingEnabled")}
          checked={flags.onlineOrderingEnabled}
          onChange={(e) => {
            const onlineOrderingEnabled = e.currentTarget.checked;
            setFlags((f) => ({ ...f, onlineOrderingEnabled }));
          }}
        />
        <CheckboxField
          label={t("autoAccept")}
          checked={flags.autoAccept}
          onChange={(e) => {
            const autoAccept = e.currentTarget.checked;
            setFlags((f) => ({ ...f, autoAccept }));
          }}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {(Object.keys(NUMBERS) as NumberField[]).map((key) => (
            <TextField
              key={key}
              label={t(key)}
              inputMode="numeric"
              value={numbers[key]}
              error={errors[key]}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setNumbers((n) => ({ ...n, [key]: value }));
              }}
            />
          ))}
          <TextField
            label={t("maxOrdersPerSlot")}
            hint={t("maxOrdersPerSlotHint")}
            inputMode="numeric"
            value={maxPerSlot}
            error={errors.maxOrdersPerSlot}
            onChange={(e) => {
              setMaxPerSlot(e.currentTarget.value);
            }}
          />
        </div>
        <Button type="submit" pending={pending} disabled={pending} className="self-start">
          {t("saveSettings")}
        </Button>
        <Feedback message={message} />
      </form>
    </Surface>
  );
}

interface Period {
  key: number;
  weekday: number;
  opens: string;
  closes: string;
}

const toTime = (minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const toMinute = (time: string, end = false) => {
  const [h, m] = time.split(":").map(Number);
  const minute = (h ?? 0) * 60 + (m ?? 0);
  return end && minute === 0 ? 1440 : minute;
};
/** Monday first, as the café's week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

export function HoursForm({ hours }: { hours: StoreAdmin["hours"] }) {
  const t = useTranslations("AdminStore");
  const tDays = useTranslations("AdminProduct.weekdays");
  const { pending, message, setMessage, run } = useSubmit();
  const [periods, setPeriods] = useState<Period[]>(
    hours.map((h, key) => ({
      key,
      weekday: h.weekday,
      opens: toTime(h.opensAtMinute),
      closes: toTime(h.closesAtMinute),
    })),
  );
  const nextKey = () => periods.reduce((m, p) => Math.max(m, p.key), 0) + 1;
  const update = (key: number, patch: Partial<Period>) => {
    setPeriods((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  };

  const submit = () => {
    const body = periods.map((p) => ({
      weekday: p.weekday,
      opensAtMinute: toMinute(p.opens),
      closesAtMinute: toMinute(p.closes, true),
    }));
    const invalid = body.some(
      (a, i) =>
        a.opensAtMinute >= a.closesAtMinute ||
        body.some(
          (b, j) =>
            j > i &&
            a.weekday === b.weekday &&
            a.opensAtMinute < b.closesAtMinute &&
            b.opensAtMinute < a.closesAtMinute,
        ),
    );
    if (invalid) {
      setMessage({ ok: false, text: t("errors.hours") });
      return;
    }
    void run(async () => {
      await apiFetch("/api/v1/admin/store/hours", {
        method: "PUT",
        body: JSON.stringify({ hours: body }),
      });
      return null;
    });
  };

  return (
    <Surface>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="font-display text-2xl text-espresso">{t("hoursTitle")}</h2>
        <p className="text-sm text-espresso-muted">{t("hoursHint")}</p>
        <ul className="flex flex-col divide-y divide-line">
          {WEEK.map((day) => {
            const dayName = tDays(String(day) as "0");
            const ofDay = periods.filter((p) => p.weekday === day);
            return (
              <li key={day} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
                <span className="w-28 shrink-0 pt-2 font-semibold text-espresso">{dayName}</span>
                <div className="flex flex-1 flex-col gap-2">
                  {ofDay.length === 0 ? (
                    <span className="pt-2 text-espresso-muted">{t("closedDay")}</span>
                  ) : null}
                  {ofDay.map((p) => (
                    <div
                      key={p.key}
                      role="group"
                      aria-label={dayName}
                      className="flex flex-wrap items-end gap-3"
                    >
                      <TextField
                        label={t("opens")}
                        type="time"
                        value={p.opens}
                        onChange={(e) => {
                          update(p.key, { opens: e.currentTarget.value });
                        }}
                      />
                      <TextField
                        label={t("closes")}
                        type="time"
                        value={p.closes}
                        onChange={(e) => {
                          update(p.key, { closes: e.currentTarget.value });
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`${t("removePeriod")} · ${dayName} ${p.opens}`}
                        onClick={() => {
                          setPeriods((ps) => ps.filter((x) => x.key !== p.key));
                        }}
                      >
                        {t("removePeriod")}
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="self-start"
                    aria-label={`${t("addPeriod")} · ${dayName}`}
                    onClick={() => {
                      const last = ofDay.at(-1);
                      setPeriods((ps) => [
                        ...ps,
                        {
                          key: nextKey(),
                          weekday: day,
                          opens: last ? last.closes : "07:00",
                          closes: "18:00",
                        },
                      ]);
                    }}
                  >
                    {t("addPeriod")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <Button type="submit" pending={pending} disabled={pending} className="self-start">
          {t("saveHours")}
        </Button>
        <Feedback message={message} />
      </form>
    </Surface>
  );
}

export function ClosuresForm({
  closures,
  today,
}: {
  closures: StoreAdmin["closures"];
  today: string;
}) {
  const t = useTranslations("AdminStore");
  const format = useFormatter();
  const { pending, message, setMessage, run } = useSubmit();
  const [date, setDate] = useState("");
  const [reasonFr, setReasonFr] = useState("");
  const [reasonEn, setReasonEn] = useState("");
  const [dateError, setDateError] = useState<string | undefined>();
  const longDate = (d: string) => format.dateTime(new Date(`${d}T12:00:00`), { dateStyle: "full" });

  const submit = () => {
    if (!date || date < today) {
      setDateError(t("errors.date"));
      return;
    }
    setDateError(undefined);
    void run(async () => {
      const result = await apiFetch<{ upcomingOrders: number }>("/api/v1/admin/store/closures", {
        method: "POST",
        body: JSON.stringify({ localDate: date, reasonFr, reasonEn }),
      });
      setDate("");
      setReasonFr("");
      setReasonEn("");
      return result.upcomingOrders > 0
        ? `${t("saved")} ${t("bookedWarning", { count: result.upcomingOrders })}`
        : null;
    });
  };

  return (
    <Surface className="flex flex-col gap-4">
      <h2 className="font-display text-2xl text-espresso">{t("closuresTitle")}</h2>
      <p className="text-sm text-espresso-muted">{t("closuresHint")}</p>
      {closures.length === 0 ? (
        <p className="text-espresso-muted">{t("noClosures")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {closures.map((c) => (
            <li
              key={c.localDate}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="flex flex-col">
                <span className="font-medium text-espresso">{longDate(c.localDate)}</span>
                {c.reasonFr || c.reasonEn ? (
                  <span className="text-sm text-espresso-muted">
                    {[c.reasonFr, c.reasonEn].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
                {c.upcomingOrders > 0 ? (
                  <span className="text-sm text-espresso">
                    {t("bookedWarning", { count: c.upcomingOrders })}
                  </span>
                ) : null}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${t("reopen")} · ${longDate(c.localDate)}`}
                disabled={pending}
                onClick={() => {
                  setMessage(null);
                  void run(async () => {
                    await apiFetch(`/api/v1/admin/store/closures/${c.localDate}`, {
                      method: "DELETE",
                    });
                    return null;
                  });
                }}
              >
                {t("reopen")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label={t("date")}
            type="date"
            min={today}
            value={date}
            error={dateError}
            onChange={(e) => {
              setDate(e.currentTarget.value);
            }}
          />
          <TextField
            label={t("reasonFr")}
            optionalLabel={t("optional")}
            lang="fr"
            maxLength={200}
            value={reasonFr}
            onChange={(e) => {
              setReasonFr(e.currentTarget.value);
            }}
          />
          <TextField
            label={t("reasonEn")}
            optionalLabel={t("optional")}
            lang="en"
            maxLength={200}
            value={reasonEn}
            onChange={(e) => {
              setReasonEn(e.currentTarget.value);
            }}
          />
        </div>
        <Button type="submit" pending={pending} disabled={pending} className="self-start">
          {t("addClosure")}
        </Button>
      </form>
      <Feedback message={message} />
    </Surface>
  );
}
