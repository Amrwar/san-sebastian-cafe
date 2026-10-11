import {
  and,
  deliveryZones,
  eq,
  loadCatalog,
  loyaltyAccounts,
  promotions,
  rewards,
  sql,
  type CatalogProduct,
  type Database,
} from "@ssc/db";
import { computeQuote, MAX_LINE_QUANTITY, type Quote } from "@ssc/domain";
import { z } from "zod";
import type { Actor } from "../../authz";
import { fromZodError } from "../../errors";

/** Canadian postal code (A1A 1A1), case-insensitive, optional space. */
export const POSTAL_CODE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/i;

export const cartQuoteInput = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1).max(64),
        productId: z.uuid(),
        variantId: z.uuid(),
        optionIds: z.array(z.uuid()).max(30),
        quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
      }),
    )
    .max(30),
  promoCode: z.string().trim().max(32).optional(),
  /** Apply the customer's oldest available free-drink reward (server chooses which). */
  useReward: z.boolean().optional(),
  rewardLineId: z.string().max(64).optional(),
  fulfilment: z
    .discriminatedUnion("method", [
      z.object({ method: z.literal("pickup") }),
      z.object({ method: z.literal("delivery"), postalCode: z.string().trim().max(7) }),
    ])
    .default({ method: "pickup" }),
  tip: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      z.object({ kind: z.literal("percent"), basisPoints: z.number().int() }),
      z.object({ kind: z.literal("amount"), cents: z.number().int() }),
    ])
    .default({ kind: "none" }),
});
export type CartQuoteInput = z.infer<typeof cartQuoteInput>;

export interface QuoteLineDisplay {
  lineId: string;
  slug: string | null;
  nameFr: string;
  nameEn: string;
  variantNameFr: string;
  variantNameEn: string;
  options: Array<{ nameFr: string; nameEn: string; priceDeltaCents: number }>;
  imageUrl: string | null;
  isDemo: boolean;
}

export type DeliveryStatus =
  | { status: "not_requested" }
  | { status: "unavailable" }
  | { status: "invalid_postal_code" }
  | { status: "outside_zone" }
  | { status: "available"; zoneNameFr: string; zoneNameEn: string; estimatedMinutes: number };

export interface CartQuoteResult {
  quote: Quote;
  display: QuoteLineDisplay[];
  delivery: DeliveryStatus;
  /** Rewards the signed-in customer could apply (ids only; null when anonymous). */
  availableRewardIds: string[] | null;
}

function displayFor(
  line: Quote["lines"][number],
  product: CatalogProduct | undefined,
): QuoteLineDisplay {
  const variant = product?.variants.find((v) => v.id === line.variantId);
  const options =
    product?.groups.flatMap((g) => g.options).filter((o) => line.optionIds.includes(o.id)) ?? [];
  return {
    lineId: line.lineId,
    slug: product?.slug ?? null,
    nameFr: product?.nameFr ?? "Produit retiré",
    nameEn: product?.nameEn ?? "Item no longer available",
    variantNameFr: variant?.nameFr ?? "",
    variantNameEn: variant?.nameEn ?? "",
    options: options.map((o) => ({
      nameFr: o.nameFr,
      nameEn: o.nameEn,
      priceDeltaCents: o.priceDeltaCents,
    })),
    imageUrl: product?.imageUrl ?? null,
    isDemo: product?.isDemo ?? false,
  };
}

/**
 * Prices a cart from ids only. Promotions are looked up by code, rewards must belong to the
 * signed-in actor and be available, and delivery requires an active zone for the postal code.
 * Read-only: nothing is reserved until an order is placed (Phase 6).
 */
export async function quoteCart(
  db: Database,
  actor: Actor | null,
  rawInput: unknown,
  now = new Date(),
): Promise<CartQuoteResult> {
  const parsed = cartQuoteInput.safeParse(rawInput);
  if (!parsed.success) throw fromZodError(parsed.error);
  const input = parsed.data;

  const catalog = await loadCatalog(db, [...new Set(input.lines.map((l) => l.productId))]);

  let promotion = null;
  let promotionCodeNotFound = false;
  if (input.promoCode) {
    const found = await db.query.promotions.findFirst({
      where: sql`lower(${promotions.code}) = lower(${input.promoCode})`,
    });
    if (found) {
      promotion = {
        id: found.id,
        code: found.code,
        kind: found.kind,
        value: found.value,
        scope: found.scope,
        targetIds: found.targetIds,
        minSubtotalCents: found.minSubtotalCents,
        startsAt: found.startsAt,
        endsAt: found.endsAt,
        isActive: found.isActive,
        stackableWithRewards: found.stackableWithRewards,
      };
    } else promotionCodeNotFound = true;
  }

  let availableRewardIds: string[] | null = null;
  let ownedReward: { id: string; valueCapCents: number | null } | undefined;
  if (actor) {
    const rows = await db
      .select({ id: rewards.id, valueCapCents: rewards.valueCapCents })
      .from(rewards)
      .innerJoin(loyaltyAccounts, eq(loyaltyAccounts.id, rewards.accountId))
      .where(and(eq(loyaltyAccounts.userId, actor.userId), eq(rewards.status, "available")))
      .orderBy(rewards.issuedAt);
    availableRewardIds = rows.map((r) => r.id);
    ownedReward = input.useReward ? rows[0] : undefined;
  }

  let delivery: DeliveryStatus = { status: "not_requested" };
  let fulfilment: Parameters<typeof computeQuote>[0]["fulfilment"] = { method: "pickup" };
  if (input.fulfilment.method === "delivery") {
    const zones = await db.select().from(deliveryZones).where(eq(deliveryZones.isActive, true));
    const postal = input.fulfilment.postalCode.toUpperCase().replace(/\s/g, "");
    if (zones.length === 0) delivery = { status: "unavailable" };
    else if (!POSTAL_CODE.test(postal)) delivery = { status: "invalid_postal_code" };
    else {
      const zone = zones.find((z) =>
        z.postalPrefixes.some((p) => postal.startsWith(p.toUpperCase())),
      );
      if (!zone) delivery = { status: "outside_zone" };
      else {
        delivery = {
          status: "available",
          zoneNameFr: zone.nameFr,
          zoneNameEn: zone.nameEn,
          estimatedMinutes: zone.estimatedMinutes,
        };
        fulfilment = {
          method: "delivery",
          feeCents: zone.feeCents,
          minimumOrderCents: zone.minimumOrderCents,
        };
      }
    }
  }

  const quote = computeQuote({
    lines: input.lines,
    catalog,
    promotion,
    promotionCodeNotFound,
    reward: ownedReward
      ? {
          rewardId: ownedReward.id,
          valueCapCents: ownedReward.valueCapCents,
          lineId: input.rewardLineId,
        }
      : null,
    fulfilment,
    tip: input.tip,
    now,
  });

  // A delivery that cannot be fulfilled blocks checkout even if every line is valid.
  if (input.fulfilment.method === "delivery" && delivery.status !== "available")
    quote.canCheckout = false;

  return {
    quote,
    display: quote.lines.map((l) => displayFor(l, catalog.get(l.productId))),
    delivery,
    availableRewardIds,
  };
}
