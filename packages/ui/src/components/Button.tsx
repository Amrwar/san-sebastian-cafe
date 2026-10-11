import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../cn";

/** `accent` and `inverse` are for dark (espresso) surfaces. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "accent" | "inverse";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 font-medium leading-tight text-center " +
  "rounded-pill transition-colors duration-150 ease-out-soft select-none " +
  "disabled:cursor-not-allowed disabled:opacity-55 aria-busy:cursor-progress";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-burgundy text-ivory hover:bg-burgundy-hover",
  secondary:
    "border border-espresso/25 bg-transparent text-espresso hover:border-espresso/60 hover:bg-ivory-sunken",
  ghost: "bg-transparent text-espresso hover:bg-ivory-sunken",
  danger: "bg-danger text-ivory hover:brightness-90",
  accent: "bg-crema text-espresso hover:bg-crema-soft",
  inverse:
    "border border-ivory/40 bg-transparent text-ivory hover:border-ivory hover:bg-espresso-deep",
};

// md and lg meet the 44px minimum touch target (WCAG 2.5.5); sm is for dense desktop toolbars.
const sizes: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3.5 text-sm",
  md: "min-h-11 px-5 text-[0.95rem]",
  lg: "min-h-13 px-7 text-base",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a busy state and blocks repeat submission. */
  pending?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    pending = false,
    className,
    disabled,
    type = "button",
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClasses(variant, size, className)}
      disabled={disabled ?? pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? (
        <span
          aria-hidden="true"
          className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      ) : null}
      {children}
    </button>
  );
});
