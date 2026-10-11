import { getTranslations } from "next-intl/server";
import { cn } from "@ssc/ui";

/**
 * Visual stamp card. The list is labelled with the full progress for screen readers; each stamp
 * also has its own label. Crema is used only on the espresso surface (7.5:1 contrast).
 */
export async function StampCard({
  count,
  total,
  compact = false,
}: {
  count: number;
  total: number;
  compact?: boolean;
}) {
  const t = await getTranslations("Rewards");
  const filled = Math.min(count, total);
  return (
    <div className="on-dark rounded-md bg-espresso p-5 text-ivory">
      <ol
        aria-label={t("cardLabel", { count: filled, total })}
        className={cn("flex flex-wrap gap-3", compact ? "gap-2" : "gap-3")}
      >
        {Array.from({ length: total }, (_, i) => {
          const done = i < filled;
          return (
            <li
              key={i}
              aria-label={`${t("stamp", { n: i + 1 })}${done ? " ✓" : ""}`}
              className={cn(
                "flex items-center justify-center rounded-pill border-2 transition-colors motion-safe:duration-300",
                compact ? "size-10" : "size-12 sm:size-14",
                done ? "border-crema bg-crema text-espresso" : "border-ivory/35 text-ivory/50",
              )}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="size-1/2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {done ? (
                  <path d="m6 12 4 4 8-8" />
                ) : (
                  <path d="M5 9h12l-1.2 8.2A2 2 0 0 1 13.8 19H8.2a2 2 0 0 1-2-1.8z" />
                )}
              </svg>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-sm text-ivory/85">
        {filled >= total ? null : t("nextReward", { count: total - filled })}
      </p>
    </div>
  );
}
