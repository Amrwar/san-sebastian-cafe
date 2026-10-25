import { cn } from "@ssc/ui";

export interface Bar {
  key: string;
  /** Axis label (only a few are shown). */
  label: string;
  value: number;
  /** Hover text: the exact figures for this bar. */
  tooltip: string;
}

/**
 * Single-series column chart, server-rendered (no client script). Columns are capped at 24px with
 * a 4px rounded top and 2px gaps; the axis shows the maximum and a few labels, and hovering a
 * column shows its figures. It is an image for assistive technology: every page using it also
 * offers the same figures as a table.
 */
export function BarChart({
  bars,
  label,
  maxLabel,
  className,
}: {
  bars: Bar[];
  /** Accessible name, e.g. "Sales by day, Oct 1 to Oct 31". */
  label: string;
  /** Formatted maximum, shown at the top of the axis. */
  maxLabel: string;
  className?: string;
}) {
  const max = Math.max(0, ...bars.map((b) => b.value));
  // First, last and a few evenly spaced labels; never one under every column.
  const step = Math.max(1, Math.ceil(bars.length / 6));
  const labelled = (i: number) =>
    i === bars.length - 1 || (i % step === 0 && bars.length - 1 - i > step / 2);

  return (
    <figure role="img" aria-label={label} className={cn("flex flex-col gap-1", className)}>
      <div className="flex justify-between text-xs text-espresso-muted" aria-hidden="true">
        <span>{maxLabel}</span>
      </div>
      <div className="flex h-40 items-end gap-[2px] border-b border-line" aria-hidden="true">
        {bars.map((b) => (
          <div key={b.key} className="group relative flex h-full flex-1 items-end justify-center">
            {b.value > 0 ? (
              <div
                className="w-full max-w-6 rounded-t-[4px] bg-burgundy transition-colors group-hover:bg-burgundy-hover"
                style={{ height: `max(2px, ${(b.value / max) * 100}%)` }}
              />
            ) : null}
            <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-sm bg-espresso px-2 py-1 text-xs text-ivory shadow-soft group-hover:block">
              {b.tooltip}
            </span>
          </div>
        ))}
      </div>
      <div className="flex gap-[2px] text-xs text-espresso-muted" aria-hidden="true">
        {bars.map((b, i) => (
          <span key={b.key} className="relative flex-1">
            {labelled(i) ? (
              <span
                className={cn(
                  "absolute whitespace-nowrap",
                  i === 0
                    ? "left-0"
                    : i === bars.length - 1
                      ? "right-0"
                      : "left-1/2 -translate-x-1/2",
                )}
              >
                {b.label}
              </span>
            ) : null}
          </span>
        ))}
      </div>
      <div className="h-4" aria-hidden="true" />
    </figure>
  );
}
