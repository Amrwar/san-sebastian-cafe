import {
  and,
  deliveryZones,
  eq,
  gt,
  isNull,
  loadCatalog,
  loyaltyAccounts,
  or,
  promotions,
  rewards,
  sql,
  type CatalogProduct,
  type Database,
  type Tx,
} from "@ssc/db";
import {
  catalogAt,
  computeQuote,
  MAX_LINE_QUANTITY,
  optionPriceForVariant,
  type PromotionRule,
  type Quote,
  type UnavailableReason,
} from "@ssc/domain";
import { z } from "zod";
import type { Actor } from "../../authz";
import { fromZodError } from "../../errors";
import { findGiftCard } from "../gift-cards/ledger";
import { currentRules } from "../loyalty/program";

/** Canadian postal code (A1A 1A1), case-insensitive, optional space. */
export const POSTAL_CODE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/i;

export const cartLineInput = z.object({
  lineId: z.string().min(1).max(64),
  productId: z.uuid(),
  variantId: z.uuid(),
  optionIds: z.array(z.uuid()).max(30),
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  /** Customer instruction for this item ("extra hot"). Not priced. */
  notes: z.string().trim().max(140).optional(),
});

export const cartQuoteInput = z.object({
  lines: z.array(cartLineInput).max(30),
  /** When the order would be prepared (scheduled pickup); availability is checked for that time. */
  pickupAt: z.iso.datetime().optional(),
  promoCode: z.string().trim().max(32).optional(),
  /** Gift card to pay with (as printed; spaces and dashes are fine). */
  giftCardCode: z.string().trim().max(40).optional(),
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
  /** Why the product can't be ordered at the pickup time (null when it can). */
  unavailableReason: UnavailableReason | null;
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
  /** The gift card entered, if any: whether it pays and what is left on it. */
  giftCard: GiftCardQuote | null;
}

export interface GiftCardQuote {
  status: "applied" | "not_found" | "disabled" | "empty";
  /** Last four characters of the code (null when no card matched). */
  last4: string | null;
  /** Balance before this order (null when no card matched). */
  balanceCents: number | null;
}

function displayFor(
  line: Quote["lines"][number],
  product: (CatalogProduct & { unavailableReason: UnavailableReason | null }) | undefined,
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
      priceDeltaCents: optionPriceForVariant(variant, o),
    })),
    imageUrl: product?.imageUrl ?? null,
    isDemo: product?.isDemo ?? false,
    unavailableReason: product ? product.unavailableReason : "hidden",
  };
}

interface OwnedReward {
  id: string;
  valueCapCents: number | null;
  coversModifiers: boolean;
}

/** Everything order placement needs besides the public quote result. */
export interface PricedCart {
  result: CartQuoteResult;
  promotion: PromotionRule | null;
  reward: OwnedReward | null;
  deliveryZoneId: string | null;
  catalog: Map<string, CatalogProduct & { unavailableReason: UnavailableReason | null }>;
}

/**
 * Prices a cart from ids only — the single pricing path for both quotes and order placement.
 * Availability (schedules, temporary disabling) is evaluated at `availableAt` (the pickup time).
 * Promotions are looked up by code, rewards must belong to the signed-in actor and be available,
 * and delivery requires an active zone for the postal code. Read-only: reserves nothing.
 */
export async function priceCart(
  db: Database | Tx,
  actor: Actor | null,
  input: CartQuoteInput,
  {
    now,
    availableAt,
    giftCardBalanceCents,
  }: {
    now: Date;
    availableAt?: Date;
    /** Order placement passes the balance of the card it has locked (instead of a code). */
    giftCardBalanceCents?: number;
  },
): Promise<PricedCart> {
  const catalog = catalogAt(
    await loadCatalog(db, [...new Set(input.lines.map((l) => l.productId))]),
    availableAt ?? (input.pickupAt ? new Date(input.pickupAt) : now),
  );

  let promotion: PromotionRule | null = null;
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
  let ownedReward: OwnedReward | undefined;
  if (actor) {
    // Unexpired available rewards only (expiry exists only if the owner enabled it).
    const rows = await db
      .select({
        id: rewards.id,
        valueCapCents: rewards.valueCapCents,
        coversModifiers: rewards.coversModifiers,
      })
      .from(rewards)
      .innerJoin(loyaltyAccounts, eq(loyaltyAccounts.id, rewards.accountId))
      .where(
        and(
          eq(loyaltyAccounts.userId, actor.userId),
          eq(rewards.status, "available"),
          or(isNull(rewards.expiresAt), gt(rewards.expiresAt, now)),
        ),
      )
      .orderBy(rewards.issuedAt);
    availableRewardIds = rows.map((r) => r.id);
    ownedReward = input.useReward ? rows[0] : undefined;
  }

  let delivery: DeliveryStatus = { status: "not_requested" };
  let deliveryZoneId: string | null = null;
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
        deliveryZoneId = zone.id;
        fulfilment = {
          method: "delivery",
          feeCents: zone.feeCents,
          minimumOrderCents: zone.minimumOrderCents,
        };
      }
    }
  }

  // A gift card pays the total after tax; an unknown, disabled or empty card pays nothing.
  let giftCard: GiftCardQuote | null = null;
  if (input.giftCardCode && giftCardBalanceCents === undefined) {
    const card = await findGiftCard(db, input.giftCardCode);
    giftCard = !card
      ? { status: "not_found", last4: null, balanceCents: null }
      : {
          status:
            card.status !== "active" ? "disabled" : card.balanceCents === 0 ? "empty" : "applied",
          last4: card.codeLast4,
          balanceCents: card.balanceCents,
        };
  }
  const usableBalance =
    giftCardBalanceCents ?? (giftCard?.status === "applied" ? giftCard.balanceCents : null);

  const rules = ownedReward ? await currentRules(db) : null;
  const quote = computeQuote({
    lines: input.lines,
    catalog,
    promotion,
    promotionCodeNotFound,
    reward: ownedReward
      ? {
          rewardId: ownedReward.id,
          valueCapCents: ownedReward.valueCapCents,
          coversModifiers: ownedReward.coversModifiers,
          lineId: input.rewardLineId,
          excludedProductIds: rules?.rewardExcludedProductIds,
          excludedVariantIds: rules?.rewardExcludedVariantIds,
        }
      : null,
    fulfilment,
    tip: input.tip,
    now,
    giftCardBalanceCents: usableBalance,
  });

  // A delivery that cannot be fulfilled blocks checkout even if every line is valid.
  if (input.fulfilment.method === "delivery" && delivery.status !== "available")
    quote.canCheckout = false;

  return {
    result: {
      quote,
      display: quote.lines.map((l) => displayFor(l, catalog.get(l.productId))),
      delivery,
      availableRewardIds,
      giftCard,
    },
    promotion,
    reward: ownedReward ?? null,
    deliveryZoneId,
    catalog,
  };
}

/** POST /api/v1/cart/quote — validated, read-only quote for the cart page and checkout. */
export async function quoteCart(
  db: Database,
  actor: Actor | null,
  rawInput: unknown,
  now = new Date(),
): Promise<CartQuoteResult> {
  const parsed = cartQuoteInput.safeParse(rawInput);
  if (!parsed.success) throw fromZodError(parsed.error);
  return (await priceCart(db, actor, parsed.data, { now })).result;
}
