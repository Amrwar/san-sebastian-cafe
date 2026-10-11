import { and, asc, eq, gt, isNull, lte, or, promotions, type Database } from "@ssc/db";
import type { PromotionKind, PromotionScope } from "@ssc/domain";

export interface PublicPromotion {
  id: string;
  code: string | null;
  nameFr: string;
  nameEn: string;
  kind: PromotionKind;
  value: number;
  scope: PromotionScope;
  minSubtotalCents: number;
  endsAt: Date | null;
  stackableWithRewards: boolean;
  isDemo: boolean;
}

/** Promotions customers can use right now (active and within their date window). */
export async function listActivePromotions(
  db: Database,
  now = new Date(),
): Promise<PublicPromotion[]> {
  return db
    .select({
      id: promotions.id,
      code: promotions.code,
      nameFr: promotions.nameFr,
      nameEn: promotions.nameEn,
      kind: promotions.kind,
      value: promotions.value,
      scope: promotions.scope,
      minSubtotalCents: promotions.minSubtotalCents,
      endsAt: promotions.endsAt,
      stackableWithRewards: promotions.stackableWithRewards,
      isDemo: promotions.isDemo,
    })
    .from(promotions)
    .where(
      and(
        eq(promotions.isActive, true),
        lte(promotions.startsAt, now),
        or(isNull(promotions.endsAt), gt(promotions.endsAt, now)),
      ),
    )
    .orderBy(asc(promotions.endsAt));
}
