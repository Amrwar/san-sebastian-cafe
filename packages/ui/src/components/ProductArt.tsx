import { cn } from "../cn";

/**
 * Original line illustration used where no approved product photograph exists yet.
 * It is deliberately an illustration (never photo-like) and always carries a visible caption
 * such as "Photo à venir / Photo coming soon", so it cannot be mistaken for a real photo.
 */
export function ProductArt({
  kind,
  caption,
  className,
}: {
  kind: "drink" | "food";
  caption: string;
  className?: string;
}) {
  return (
    <figure
      className={cn(
        "relative flex aspect-[4/3] flex-col items-center justify-center overflow-hidden bg-espresso text-crema",
        className,
      )}
    >
      <svg
        viewBox="0 0 120 90"
        aria-hidden="true"
        className="h-3/5 w-auto"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === "drink" ? (
          <>
            <path d="M40 22c0-4 4-4 4-8M52 22c0-4 4-4 4-8M64 22c0-4 4-4 4-8" opacity=".6" />
            <path d="M30 30h52l-5 34a8 8 0 0 1-8 7H43a8 8 0 0 1-8-7z" />
            <path d="M82 38h5a8 8 0 0 1 0 16h-7" />
            <path d="M22 76h68" />
            <path d="M44 44c6 4 18 4 24 0" opacity=".6" />
          </>
        ) : (
          <>
            <path d="M24 60c4-18 18-30 36-30s32 12 36 30" />
            <path d="M24 60c10 6 62 6 72 0" />
            <path d="M44 34c2 8 2 18 0 26M60 30v30M76 34c-2 8-2 18 0 26" opacity=".6" />
            <path d="M18 72h84" />
          </>
        )}
      </svg>
      <figcaption className="absolute bottom-2 end-3 text-[0.7rem] font-medium uppercase tracking-[0.12em] text-ivory/80">
        {caption}
      </figcaption>
    </figure>
  );
}
