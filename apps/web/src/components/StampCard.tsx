import { getTranslations } from "next-intl/server";
import { cn } from "@ssc/ui";

/** Fixed tilts so each pressed stamp looks hand-stamped but the card never shifts between renders. */
const TILTS = [-8, 5, -3, 9, -6, 4, -10, 7, -2, 6];

function Cup({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 10h11v4a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z" />
      <path d="M16 11h1.5a2 2 0 0 1 0 4H16" />
      <path d="M9 4c0 1.2 1 1.6 1 3M12 4c0 1.2 1 1.6 1 3" />
    </svg>
  );
}

/**
 * The stamp card as a piece of crema cardstock. Pressed stamps are burgundy with an ivory cup;
 * text is espresso on crema (both pairs stay above 7:1). Stamps earned today get a short ink
 * animation; when a free drink was just unlocked the card shows its back. Both animations are
 * dropped under reduced motion. The list is labelled with the full progress for screen readers.
 */
export async function StampCard({
  count,
  total,
  compact = false,
  newStamps = 0,
  justUnlocked = false,
}: {
  count: number;
  total: number;
  compact?: boolean;
  /** Stamps earned today, the most recent ones on the card. */
  newStamps?: number;
  /** A free drink was issued today and the card started over. */
  justUnlocked?: boolean;
}) {
  const t = await getTranslations("Rewards");
  const filled = Math.min(count, total);
  const fresh = Math.min(newStamps, filled);

  if (justUnlocked && filled === 0 && !compact) {
    return (
      <div className="on-dark stamp-flip flex min-h-56 flex-col justify-between gap-4 rounded-lg border border-burgundy-hover bg-burgundy p-6 text-ivory shadow-[0_18px_40px_rgba(56,37,31,0.2)] sm:p-8">
        <p className="font-display text-xl">{t("cardBrand")}</p>
        <div className="flex items-center gap-4">
          <span className="flex size-16 shrink-0 items-center justify-center rounded-pill border-2 border-ivory">
            <Cup className="size-8" />
          </span>
          <div>
            <p className="font-display text-3xl">{t("unlockedTitle")}</p>
            <p className="text-ivory/85">{t("unlockedBody")}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-[#b89659] bg-crema text-espresso",
        compact
          ? "gap-3 p-4"
          : "-rotate-[1.5deg] gap-6 p-6 shadow-[0_18px_40px_rgba(56,37,31,0.2)] motion-reduce:rotate-0 sm:p-8",
      )}
    >
      {compact ? null : (
        <div>
          <p className="font-display text-2xl font-semibold sm:text-3xl">{t("cardBrand")}</p>
          <p className="mt-1 text-sm">{t("cardRule", { total })}</p>
        </div>
      )}
      <ol
        aria-label={t("cardLabel", { count: filled, total })}
        className={cn("grid", compact ? "gap-2" : "gap-3 sm:gap-4")}
        style={{ gridTemplateColumns: `repeat(${Math.min(total, 5)}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: total }, (_, i) => {
          const done = i < filled;
          const isNew = done && i >= filled - fresh;
          return (
            <li
              key={i}
              aria-label={`${t("stamp", { n: i + 1 })}${done ? " ✓" : ""}`}
              className={cn(
                "flex aspect-square items-center justify-center rounded-pill border-2 border-espresso",
                compact ? "max-w-12" : "max-w-20",
                done ? "bg-burgundy text-ivory" : "border-dashed font-display text-espresso",
                isNew && "stamp-ink shadow-[0_0_0_5px_rgba(119,47,59,0.25)]",
              )}
              style={done ? { transform: `rotate(${TILTS[i % TILTS.length]}deg)` } : undefined}
            >
              {done ? (
                <Cup className="size-3/5" />
              ) : (
                <span aria-hidden="true" className={compact ? "text-base" : "text-xl sm:text-2xl"}>
                  {i + 1}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className={cn("font-semibold", compact ? "text-sm" : "text-base")}>
        {fresh > 0 && !compact ? `${t("newStamp", { count: fresh })} ` : ""}
        {filled >= total ? null : t("nextReward", { count: total - filled })}
      </p>
    </div>
  );
}
