import type { ElementType, ReactNode } from "react";
import { cn } from "../cn";

export function Container({
  children,
  className,
  as: As = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
}) {
  return (
    <As className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8", className)}>{children}</As>
  );
}

export function SkipLink({ href = "#main", children }: { href?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="sr-only rounded-sm bg-espresso px-4 py-3 text-ivory focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50"
    >
      {children}
    </a>
  );
}

export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 pb-8 pt-10 sm:pt-14">
      {eyebrow ? (
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-burgundy">{eyebrow}</p>
      ) : null}
      <h1 className="font-display text-4xl leading-[1.05] text-balance text-espresso sm:text-5xl">
        {title}
      </h1>
      {children ? (
        <div className="max-w-2xl text-lg leading-relaxed text-espresso-muted">{children}</div>
      ) : null}
    </header>
  );
}

export function Surface({
  children,
  className,
  as: As = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
}) {
  return (
    <As
      className={cn(
        "rounded-md border border-line bg-ivory-raised p-5 shadow-soft sm:p-6",
        className,
      )}
    >
      {children}
    </As>
  );
}
