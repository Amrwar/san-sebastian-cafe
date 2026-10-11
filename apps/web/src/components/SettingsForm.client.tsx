"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@ssc/domain";
import { Alert, Button, CheckboxField, SelectField, Surface, TextField } from "@ssc/ui";
import { saveSettings, type SettingsFormState } from "@/app/[locale]/account/actions";

export interface SettingsValues {
  name: string;
  preferredLocale: Locale;
  orderUpdatesEmail: boolean;
  marketingEmail: boolean;
}

/**
 * Profile and/or communication preferences. Works without JavaScript (plain form post to a server
 * action) and is enhanced with pending and result states.
 */
export function SettingsForm({
  initial,
  sections,
  mode = "settings",
  next,
  submitLabel,
}: {
  initial: SettingsValues;
  sections: Array<"profile" | "notifications">;
  mode?: "settings" | "onboarding";
  next?: string;
  submitLabel?: string;
}) {
  const t = useTranslations("Account");
  const locale = useLocale();
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(saveSettings, {
    status: "idle",
  });
  const nameInvalid = state.status === "error" && state.fields.includes("name");

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="sections" value={sections.join(",")} />
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="locale" value={locale} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {sections.includes("profile") ? (
        <Surface className="flex flex-col gap-5" as="fieldset">
          <legend className="float-left mb-1 font-display text-2xl text-espresso">
            {t("profileTitle")}
          </legend>
          <TextField
            className="clear-left"
            label={t("nameLabel")}
            hint={t("nameHint")}
            name="name"
            autoComplete="name"
            maxLength={80}
            required
            defaultValue={initial.name}
            error={nameInvalid ? t("errors.name") : undefined}
          />
          <SelectField
            label={t("languageLabel")}
            name="preferredLocale"
            defaultValue={initial.preferredLocale}
          >
            <option value="fr-CA" lang="fr-CA">
              Français
            </option>
            <option value="en-CA" lang="en-CA">
              English
            </option>
          </SelectField>
        </Surface>
      ) : null}

      {sections.includes("notifications") ? (
        <Surface className="flex flex-col gap-5" as="fieldset">
          <legend className="float-left mb-1 font-display text-2xl text-espresso">
            {t("notificationsTitle")}
          </legend>
          <CheckboxField
            className="clear-left"
            name="orderUpdatesEmail"
            label={t("orderUpdatesLabel")}
            hint={t("orderUpdatesHint")}
            defaultChecked={initial.orderUpdatesEmail}
          />
          <CheckboxField
            name="marketingEmail"
            label={t("marketingLabel")}
            hint={t("marketingHint")}
            defaultChecked={initial.marketingEmail}
          />
        </Surface>
      ) : null}

      <div aria-live="polite">
        {state.status === "saved" ? <Alert tone="success">{t("saved")}</Alert> : null}
        {state.status === "error" && !nameInvalid ? (
          <Alert tone="danger">{t("errors.generic")}</Alert>
        ) : null}
      </div>

      <Button type="submit" pending={pending} className="self-start">
        {submitLabel ?? t("save")}
      </Button>
    </form>
  );
}
