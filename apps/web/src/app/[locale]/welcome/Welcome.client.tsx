"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, buttonClasses, cn } from "@ssc/ui";
import { CupIcon, StampIcon } from "@/components/icons";
import { Link } from "@/i18n/navigation";
import { WELCOMED_COOKIE } from "@/lib/welcome";

const STEPS = [
  { title: "step1Title", body: "step1Body", icon: CupIcon },
  { title: "step2Title", body: "step2Body", icon: StampIcon },
  { title: "step3Title", body: "step3Body", icon: CupIcon },
] as const;

function markWelcomed() {
  document.cookie = `${WELCOMED_COOKIE}=1; max-age=31536000; path=/; samesite=lax`;
}

/** Three-step introduction. Each step is announced by moving focus to its heading. */
export function Welcome() {
  const t = useTranslations("Welcome");
  const [step, setStep] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const current = STEPS[step] ?? STEPS[0];
  const StepIcon = current.icon;
  const last = step === STEPS.length - 1;

  return (
    <section className="mx-auto flex max-w-xl flex-col gap-8 py-10">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-burgundy">
          {t("stepOf", { current: step + 1, total: STEPS.length })}
        </p>
        <Link
          href="/menu"
          onClick={markWelcomed}
          className="text-sm text-espresso-muted underline underline-offset-4"
        >
          {t("skip")}
        </Link>
      </div>

      <div aria-hidden="true" className="flex gap-2">
        {STEPS.map((s, i) => (
          <span
            key={s.title}
            className={cn("h-1 flex-1 rounded-pill", i <= step ? "bg-burgundy" : "bg-line")}
          />
        ))}
      </div>

      <div className="on-dark flex aspect-[4/3] items-center justify-center rounded-md bg-espresso text-crema">
        <StepIcon className="size-28" strokeWidth={1} />
      </div>

      <div className="flex flex-col gap-3">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-4xl leading-tight text-espresso outline-none"
        >
          {t(current.title)}
        </h1>
        <p className="text-lg leading-relaxed text-espresso-muted">{t(current.body)}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {step > 0 ? (
          <Button
            variant="secondary"
            onClick={() => {
              setStep(step - 1);
            }}
          >
            {t("back")}
          </Button>
        ) : null}
        {last ? (
          <>
            <Link href="/menu" onClick={markWelcomed} className={buttonClasses("primary")}>
              {t("browseMenu")}
            </Link>
            <Link
              href="/sign-in?mode=register"
              onClick={markWelcomed}
              className={buttonClasses("secondary")}
            >
              {t("signIn")}
            </Link>
          </>
        ) : (
          <Button
            onClick={() => {
              setStep(step + 1);
            }}
          >
            {t("next")}
          </Button>
        )}
      </div>
    </section>
  );
}
