import { cn } from "../cn";

export interface QuantityStepperProps {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  /** Accessible name of the quantity, e.g. "Quantity, Latte". */
  label: string;
  decreaseLabel: string;
  increaseLabel: string;
  disabled?: boolean;
  className?: string;
}

/** − value + control with 44px targets. The value is announced politely when it changes. */
export function QuantityStepper({
  value,
  min = 1,
  max = 20,
  onChange,
  label,
  decreaseLabel,
  increaseLabel,
  disabled,
  className,
}: QuantityStepperProps) {
  const button =
    "inline-flex size-11 items-center justify-center rounded-pill text-xl leading-none text-espresso transition-colors hover:bg-ivory-sunken disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex items-center rounded-pill border border-line-strong bg-ivory-raised",
        className,
      )}
    >
      <button
        type="button"
        className={button}
        aria-label={decreaseLabel}
        disabled={disabled || value <= min}
        onClick={() => {
          onChange(Math.max(min, value - 1));
        }}
      >
        <span aria-hidden="true">−</span>
      </button>
      <output aria-live="polite" className="min-w-8 text-center font-semibold tabular-nums">
        {value}
      </output>
      <button
        type="button"
        className={button}
        aria-label={increaseLabel}
        disabled={disabled || value >= max}
        onClick={() => {
          onChange(Math.min(max, value + 1));
        }}
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}
