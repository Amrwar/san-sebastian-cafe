import { pgEnum } from "drizzle-orm/pg-core";
import {
  AVAILABILITY,
  FULFILMENT_METHODS,
  LOCALES,
  LOYALTY_TRANSACTION_KINDS,
  MODIFIER_SELECTION,
  NOTIFICATION_CHANNELS,
  ORDER_STATUSES,
  PAYMENT_PROVIDERS,
  PAYMENT_STATUSES,
  PROMOTION_KINDS,
  PROMOTION_SCOPES,
  REDEMPTION_STATUSES,
  REWARD_STATUSES,
  ROLES,
  TAX_CATEGORIES,
} from "@ssc/domain";

// Enum values come from @ssc/domain so the schema and business rules share one vocabulary.
export const roleEnum = pgEnum("role", ROLES);
export const localeEnum = pgEnum("locale", LOCALES);
export const notificationChannelEnum = pgEnum("notification_channel", NOTIFICATION_CHANNELS);
export const notificationTopicEnum = pgEnum("notification_topic", ["order_updates", "marketing"]);
export const availabilityEnum = pgEnum("availability", AVAILABILITY);
export const modifierSelectionEnum = pgEnum("modifier_selection", MODIFIER_SELECTION);
export const taxCategoryEnum = pgEnum("tax_category", TAX_CATEGORIES);
export const orderStatusEnum = pgEnum("order_status", ORDER_STATUSES);
export const fulfilmentMethodEnum = pgEnum("fulfilment_method", FULFILMENT_METHODS);
export const actorKindEnum = pgEnum("actor_kind", ["customer", "staff", "system", "webhook"]);
export const paymentProviderEnum = pgEnum("payment_provider", PAYMENT_PROVIDERS);
export const paymentStatusEnum = pgEnum("payment_status", PAYMENT_STATUSES);
export const loyaltyTransactionKindEnum = pgEnum(
  "loyalty_transaction_kind",
  LOYALTY_TRANSACTION_KINDS,
);
export const rewardStatusEnum = pgEnum("reward_status", REWARD_STATUSES);
export const redemptionStatusEnum = pgEnum("redemption_status", REDEMPTION_STATUSES);
export const promotionKindEnum = pgEnum("promotion_kind", PROMOTION_KINDS);
export const promotionScopeEnum = pgEnum("promotion_scope", PROMOTION_SCOPES);
