import type { ReactNode } from "react";
import { cn } from "../cn";

export type Tone = "neutral" | "success" | "warning" | "danger" | "brand";

const alertTones: Record<Tone, string> = {
  neutral: "border-line bg-ivory-raised text-espresso",
  success: "border-success/30 bg-success-tint text-success",
  warning: "border-warning/30 bg-warning-tint text-warning",
  danger: "border-danger/30 bg-danger-tint text-danger",
  brand: "border-burgundy/25 bg-burgundy-tint text-burgundy",
};

export interface AlertProps {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  /** "alert" interrupts screen readers: reserve it for errors that need immediate attention. */
  role?: "status" | "alert" | "note";
  className?: string;
}

export function Alert({
  tone = "neutral",
  title,
  children,
  role = "status",
  className,
}: AlertProps) {
  return (
    <div
      role={role}
      className={cn("rounded-sm border px-4 py-3 text-sm", alertTones[tone], className)}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? (
        <div className={cn(title ? "mt-0.5" : null, "leading-relaxed")}>{children}</div>
      ) : null}
    </div>
  );
}

const badgeTones: Record<Tone, string> = {
  neutral: "bg-ivory-sunken text-espresso",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  danger: "bg-danger-tint text-danger",
  brand: "bg-burgundy-tint text-burgundy",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pill px-2.5 py-0.5 text-xs font-semibold tracking-wide",
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="font-display text-xl text-espresso">{title}</p>
      {children ? (
        <div className="mx-auto mt-2 max-w-prose text-espresso-muted">{children}</div>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}
