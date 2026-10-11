CREATE TYPE "public"."actor_kind" AS ENUM('customer', 'staff', 'system', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."availability" AS ENUM('available', 'sold_out', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."fulfilment_method" AS ENUM('pickup', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('fr-CA', 'en-CA');--> statement-breakpoint
CREATE TYPE "public"."loyalty_transaction_kind" AS ENUM('earn', 'reverse', 'convert', 'adjust');--> statement-breakpoint
CREATE TYPE "public"."modifier_selection" AS ENUM('single', 'multiple');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'push', 'sms');--> statement-breakpoint
CREATE TYPE "public"."notification_topic" AS ENUM('order_updates', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('awaiting_payment', 'paid', 'accepted', 'in_preparation', 'ready', 'completed', 'cancelled', 'expired', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('fake', 'stripe', 'square');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'requires_action', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."promotion_kind" AS ENUM('percent_off', 'amount_off');--> statement-breakpoint
CREATE TYPE "public"."promotion_scope" AS ENUM('order', 'product', 'category');--> statement-breakpoint
CREATE TYPE "public"."redemption_status" AS ENUM('reserved', 'committed', 'released');--> statement-breakpoint
CREATE TYPE "public"."reward_status" AS ENUM('available', 'reserved', 'redeemed', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('customer', 'staff', 'shift_lead', 'manager', 'owner');--> statement-breakpoint
CREATE TYPE "public"."tax_category" AS ENUM('standard', 'zero_rated', 'exempt');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"preferred_locale" "locale" DEFAULT 'fr-CA' NOT NULL,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"topic" "notification_topic" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"consented_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_channel_topic_pk" PRIMARY KEY("user_id","channel","topic")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" "role" DEFAULT 'customer' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_fr" text NOT NULL,
	"name_en" text NOT NULL,
	"description_fr" text,
	"description_en" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name_fr" text NOT NULL,
	"name_en" text NOT NULL,
	"selection" "modifier_selection" NOT NULL,
	"min_selected" integer DEFAULT 0 NOT NULL,
	"max_selected" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modifier_groups_bounds" CHECK ("modifier_groups"."min_selected" >= 0 and "modifier_groups"."max_selected" >= 1 and "modifier_groups"."min_selected" <= "modifier_groups"."max_selected"),
	CONSTRAINT "modifier_groups_single_max" CHECK ("modifier_groups"."selection" <> 'single' or "modifier_groups"."max_selected" = 1)
);
--> statement-breakpoint
CREATE TABLE "modifier_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"name_fr" text NOT NULL,
	"name_en" text NOT NULL,
	"price_delta_cents" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"availability" "availability" DEFAULT 'available' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_modifier_groups" (
	"product_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_modifier_groups_product_id_group_id_pk" PRIMARY KEY("product_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"name_fr" text NOT NULL,
	"name_en" text NOT NULL,
	"price_cents" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"availability" "availability" DEFAULT 'available' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_price_nonnegative" CHECK ("product_variants"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name_fr" text NOT NULL,
	"name_en" text NOT NULL,
	"description_fr" text,
	"description_en" text,
	"image_url" text,
	"image_alt_fr" text,
	"image_alt_en" text,
	"allergen_note_fr" text,
	"allergen_note_en" text,
	"tax_category" "tax_category" DEFAULT 'standard' NOT NULL,
	"is_drink" boolean DEFAULT false NOT NULL,
	"loyalty_qualifying" boolean DEFAULT false NOT NULL,
	"reward_eligible" boolean DEFAULT false NOT NULL,
	"availability" "availability" DEFAULT 'available' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_image_alt_required" CHECK ("products"."image_url" is null or ("products"."image_alt_fr" is not null and "products"."image_alt_en" is not null)),
	CONSTRAINT "products_loyalty_requires_drink" CHECK (not "products"."loyalty_qualifying" or "products"."is_drink")
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text,
	"name_fr" text NOT NULL,
	"name_en" text NOT NULL,
	"kind" "promotion_kind" NOT NULL,
	"scope" "promotion_scope" DEFAULT 'order' NOT NULL,
	"target_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"value" integer NOT NULL,
	"min_subtotal_cents" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"max_redemptions" integer,
	"max_redemptions_per_customer" integer,
	"stackable_with_rewards" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_value_positive" CHECK ("promotions"."value" > 0),
	CONSTRAINT "promotions_percent_max" CHECK ("promotions"."kind" <> 'percent_off' or "promotions"."value" <= 10000),
	CONSTRAINT "promotions_window" CHECK ("promotions"."ends_at" is null or "promotions"."ends_at" > "promotions"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "delivery_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name_fr" text NOT NULL,
	"name_en" text NOT NULL,
	"postal_prefixes" text[] NOT NULL,
	"fee_cents" integer NOT NULL,
	"minimum_order_cents" integer DEFAULT 0 NOT NULL,
	"estimated_minutes" integer NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_zones_amounts" CHECK ("delivery_zones"."fee_cents" >= 0 and "delivery_zones"."minimum_order_cents" >= 0 and "delivery_zones"."estimated_minutes" > 0),
	CONSTRAINT "delivery_zones_prefixes" CHECK (cardinality("delivery_zones"."postal_prefixes") > 0)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"product_name_fr" text NOT NULL,
	"product_name_en" text NOT NULL,
	"variant_name_fr" text NOT NULL,
	"variant_name_en" text NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"line_total_cents" integer NOT NULL,
	"tax_category" "tax_category" NOT NULL,
	"is_drink" boolean NOT NULL,
	"loyalty_qualifying" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_amounts" CHECK ("order_items"."unit_price_cents" >= 0 and "order_items"."line_total_cents" = "order_items"."unit_price_cents" * "order_items"."quantity")
);
--> statement-breakpoint
CREATE TABLE "order_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"user_id" text,
	"guest_email" text,
	"guest_name" text,
	"status" "order_status" DEFAULT 'awaiting_payment' NOT NULL,
	"fulfilment" "fulfilment_method" DEFAULT 'pickup' NOT NULL,
	"delivery_zone_id" uuid,
	"delivery_address" jsonb,
	"scheduled_for" timestamp with time zone,
	"locale" "locale" NOT NULL,
	"notes" text,
	"promotion_id" uuid,
	"subtotal_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"reward_discount_cents" integer DEFAULT 0 NOT NULL,
	"delivery_fee_cents" integer DEFAULT 0 NOT NULL,
	"gst_cents" integer NOT NULL,
	"qst_cents" integer NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"pricing_snapshot" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_number_unique" UNIQUE("number"),
	CONSTRAINT "orders_idempotencyKey_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "orders_customer_identified" CHECK ("orders"."user_id" is not null or "orders"."guest_email" is not null),
	CONSTRAINT "orders_amounts_nonnegative" CHECK ("orders"."subtotal_cents" >= 0 and "orders"."discount_cents" >= 0 and "orders"."reward_discount_cents" >= 0 and "orders"."delivery_fee_cents" >= 0 and "orders"."gst_cents" >= 0 and "orders"."qst_cents" >= 0 and "orders"."tip_cents" >= 0 and "orders"."total_cents" >= 0),
	CONSTRAINT "orders_total_adds_up" CHECK ("orders"."total_cents" = "orders"."subtotal_cents" - "orders"."discount_cents" - "orders"."reward_discount_cents" + "orders"."delivery_fee_cents" + "orders"."gst_cents" + "orders"."qst_cents" + "orders"."tip_cents"),
	CONSTRAINT "orders_delivery_fields" CHECK (("orders"."fulfilment" = 'delivery') = ("orders"."delivery_zone_id" is not null and "orders"."delivery_address" is not null))
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "payment_events_provider_event_uq" UNIQUE("provider","event_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_payment_id" text NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"amount_cents" integer NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"card_brand" text,
	"card_last4" text,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_ref_uq" UNIQUE("provider","provider_payment_id"),
	CONSTRAINT "payments_amounts" CHECK ("payments"."amount_cents" > 0 and "payments"."refunded_cents" >= 0 and "payments"."refunded_cents" <= "payments"."amount_cents"),
	CONSTRAINT "payments_currency_cad" CHECK ("payments"."currency" = 'CAD')
);
--> statement-breakpoint
CREATE TABLE "loyalty_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"stamp_balance" integer DEFAULT 0 NOT NULL,
	"lifetime_stamps" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_accounts_userId_unique" UNIQUE("user_id"),
	CONSTRAINT "loyalty_accounts_balance_nonnegative" CHECK ("loyalty_accounts"."stamp_balance" >= 0),
	CONSTRAINT "loyalty_accounts_lifetime_nonnegative" CHECK ("loyalty_accounts"."lifetime_stamps" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "loyalty_transaction_kind" NOT NULL,
	"stamps" integer NOT NULL,
	"order_item_id" uuid,
	"reason" text,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_transactions_nonzero" CHECK ("loyalty_transactions"."stamps" <> 0),
	CONSTRAINT "loyalty_transactions_sign" CHECK (("loyalty_transactions"."kind" = 'earn' and "loyalty_transactions"."stamps" > 0) or ("loyalty_transactions"."kind" in ('reverse', 'convert') and "loyalty_transactions"."stamps" < 0) or "loyalty_transactions"."kind" = 'adjust'),
	CONSTRAINT "loyalty_transactions_adjust_reason" CHECK ("loyalty_transactions"."kind" <> 'adjust' or "loyalty_transactions"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "reward_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reward_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid,
	"status" "redemption_status" DEFAULT 'reserved' NOT NULL,
	"discount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_redemptions_discount_nonnegative" CHECK ("reward_redemptions"."discount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "reward_status" DEFAULT 'available' NOT NULL,
	"source_transaction_id" uuid NOT NULL,
	"value_cap_cents" integer,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_sourceTransactionId_unique" UNIQUE("source_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_id_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_modifier_groups" ADD CONSTRAINT "product_modifier_groups_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_modifier_groups" ADD CONSTRAINT "product_modifier_groups_group_id_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_zone_id_delivery_zones_id_fk" FOREIGN KEY ("delivery_zone_id") REFERENCES "public"."delivery_zones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_account_id_loyalty_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."loyalty_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_reward_id_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."rewards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_account_id_loyalty_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."loyalty_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_source_transaction_id_loyalty_transactions_id_fk" FOREIGN KEY ("source_transaction_id") REFERENCES "public"."loyalty_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "categories_sort_idx" ON "categories" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "modifier_options_group_idx" ON "modifier_options" USING btree ("group_id","sort_order");--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("product_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_one_default_uq" ON "product_variants" USING btree ("product_id") WHERE "product_variants"."is_default" and "product_variants"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_code_lower_uq" ON "promotions" USING btree (lower("code")) WHERE "promotions"."code" is not null;--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_status_events_order_idx" ON "order_status_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id","placed_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status","placed_at");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_account_idx" ON "loyalty_transactions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_transactions_item_kind_uq" ON "loyalty_transactions" USING btree ("order_item_id","kind") WHERE "loyalty_transactions"."order_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "reward_redemptions_one_active_uq" ON "reward_redemptions" USING btree ("reward_id") WHERE "reward_redemptions"."status" in ('reserved', 'committed');--> statement-breakpoint
CREATE INDEX "reward_redemptions_order_idx" ON "reward_redemptions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "rewards_account_status_idx" ON "rewards" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");