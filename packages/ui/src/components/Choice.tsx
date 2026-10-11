import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

/**
 * A native radio or checkbox styled as a selectable chip. The real input stays in the
 * accessibility tree (keyboard, screen readers, form posts); only its box is visually hidden.
 */
export interface ChoiceChipProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className"
> {
  type: "radio" | "checkbox";
  label: ReactNode;
  /** Secondary text such as a price difference ("+1,00 $"). */
  detail?: ReactNode;
  /** Reason the choice is unavailable, shown in place of the detail. */
  unavailableLabel?: ReactNode;
  className?: string;
}

export function ChoiceChip({
  type,
  label,
  detail,
  unavailableLabel,
  disabled,
  className,
  ...input
}: ChoiceChipProps) {
  return (
    <label
      className={cn(
        "group relative inline-flex",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        className,
      )}
    >
      <input
        type={type}
        disabled={disabled}
        className="peer absolute inset-0 m-0 size-full cursor-[inherit] opacity-0"
        {...input}
      />
      <span
        className={cn(
          "flex min-h-11 w-full flex-col justify-center rounded-pill border px-4 py-2 text-[0.95rem] leading-tight transition-colors",
          "border-line-strong bg-ivory-raised text-espresso",
          "peer-hover:border-espresso-muted",
          "peer-checked:border-burgundy peer-checked:bg-burgundy peer-checked:text-ivory",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-burgundy",
          "peer-disabled:border-dashed peer-disabled:bg-ivory-sunken peer-disabled:text-espresso-muted",
        )}
      >
        <span className="font-medium">{label}</span>
        {unavailableLabel && disabled ? (
          <span className="text-xs">{unavailableLabel}</span>
        ) : detail ? (
          <span className="text-xs opacity-85">{detail}</span>
        ) : null}
      </span>
    </label>
  );
}

/** Groups choices under a visible legend with optional requirement text. */
export function ChoiceGroup({
  legend,
  hint,
  error,
  children,
  className,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn("flex flex-col gap-3", className)}>
      <legend className="mb-3 flex w-full flex-wrap items-baseline justify-between gap-2">
        <span className="text-lg font-semibold text-espresso">{legend}</span>
        {hint ? <span className="text-sm text-espresso-muted">{hint}</span> : null}
      </legend>
      <div className="flex flex-wrap gap-2">{children}</div>
      {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
    </fieldset>
  );
}
