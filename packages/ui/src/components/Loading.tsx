import { cn } from "../cn";

/** Decorative placeholder block; pair it with a visually hidden "loading" status for assistive tech. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("animate-pulse rounded-sm bg-ivory-sunken", className)} />
  );
}

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      role={label ? "status" : undefined}
      className={cn("inline-flex items-center gap-2", className)}
    >
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
