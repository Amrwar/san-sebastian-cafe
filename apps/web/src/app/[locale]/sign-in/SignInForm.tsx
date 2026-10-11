"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, TextField } from "@ssc/ui";
import { authClient } from "@/lib/auth-client";

type Step = "email" | "code";
type ErrorKey = "invalidEmail" | "invalidCode" | "codeFormat" | "tooManyRequests" | "generic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function errorKeyFor(
  error: { status?: number; code?: string | undefined },
  fallback: ErrorKey,
): ErrorKey {
  if (error.status === 429 || error.code === "TOO_MANY_ATTEMPTS") return "tooManyRequests";
  if (error.code === "INVALID_OTP" || error.code === "OTP_EXPIRED") return "invalidCode";
  if (error.code === "INVALID_EMAIL") return "invalidEmail";
  return fallback;
}

/**
 * Two-step passwordless sign-in: request a one-time code, then verify it.
 * Calls Better Auth over HTTP so its server-side rate limits apply.
 */
export function SignInForm({ destination }: { destination: string }) {
  const t = useTranslations("SignIn");
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // Move focus to the field of the step that just appeared (not on first render).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    (step === "code" ? codeRef : emailRef).current?.focus();
  }, [step]);

  async function requestCode(formData: FormData) {
    const value = field(formData, "email").trim().toLowerCase();
    setEmail(value);
    if (!EMAIL_PATTERN.test(value)) {
      setError("invalidEmail");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { error: apiError } = await authClient.emailOtp.sendVerificationOtp({
        email: value,
        type: "sign-in",
      });
      if (apiError) {
        setError(errorKeyFor(apiError, "generic"));
        return;
      }
      setStep("code");
    } catch {
      setError("generic");
    } finally {
      setPending(false);
    }
  }

  async function verifyCode(formData: FormData) {
    const otp = field(formData, "otp").replace(/\s/g, "");
    if (!/^\d{6}$/.test(otp)) {
      setError("codeFormat");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { error: apiError } = await authClient.signIn.emailOtp({ email, otp });
      if (apiError) {
        setError(errorKeyFor(apiError, "invalidCode"));
        setPending(false);
        return;
      }
      // Full navigation so every server component re-renders with the new session.
      window.location.assign(destination);
    } catch {
      setError("generic");
      setPending(false);
    }
  }

  if (step === "email") {
    return (
      <form action={requestCode} noValidate className="flex flex-col gap-5">
        <TextField
          ref={emailRef}
          label={t("emailLabel")}
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          defaultValue={email}
          error={error === "invalidEmail" ? t("errors.invalidEmail") : undefined}
        />
        {error && error !== "invalidEmail" ? (
          <Alert tone="danger" role="alert">
            {t(`errors.${error}`)}
          </Alert>
        ) : null}
        <Button type="submit" pending={pending} className="self-start">
          {t("sendCode")}
        </Button>
      </form>
    );
  }

  const codeError =
    error === "codeFormat" || error === "invalidCode" ? t(`errors.${error}`) : undefined;
  return (
    <form action={verifyCode} noValidate className="flex flex-col gap-5">
      <TextField
        ref={codeRef}
        label={t("codeLabel")}
        hint={t("codeHint", { email })}
        name="otp"
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={6}
        required
        error={codeError}
      />
      {error && !codeError ? (
        <Alert tone="danger" role="alert">
          {t(`errors.${error}`)}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" pending={pending}>
          {t("verify")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setStep("email");
            setError(null);
          }}
        >
          {t("changeEmail")}
        </Button>
      </div>
    </form>
  );
}
