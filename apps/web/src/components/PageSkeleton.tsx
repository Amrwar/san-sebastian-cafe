import { getTranslations } from "next-intl/server";
import { Container, Skeleton } from "@ssc/ui";

/** Route-level loading state: a heading placeholder and a grid of card placeholders. */
export async function PageSkeleton({ cards = 6 }: { cards?: number }) {
  const t = await getTranslations("Common");
  return (
    <Container>
      <p role="status" className="sr-only">
        {t("loading")}
      </p>
      <div className="flex flex-col gap-3 pb-8 pt-10 sm:pt-14">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-11 w-2/3 max-w-md" />
        <Skeleton className="h-5 w-full max-w-xl" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-md border border-line bg-ivory-raised">
            <Skeleton className="aspect-[4/3] w-full rounded-none" />
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </Container>
  );
}
