CREATE TYPE "public"."loyalty_earn_trigger" AS ENUM('paid', 'completed');--> statement-breakpoint
CREATE TYPE "public"."loyalty_source" AS ENUM('online_order', 'in_store', 'staff', 'system');--> statement-breakpoint
CREATE TYPE "public"."loyalty_refund_shortfall_policy" AS ENUM('carry_forward', 'forgive');--> statement-breakpoint
CREATE TYPE "public"."loyalty_reward_refund_policy" AS ENUM('reinstate', 'keep_redeemed');--> statement-breakpoint
ALTER TYPE "public"."loyalty_transaction_kind" ADD VALUE 'revoke';--> statement-breakpoint
ALTER TYPE "public"."loyalty_transaction_kind" ADD VALUE 'repay';--> statement-breakpoint
ALTER TYPE "public"."loyalty_transaction_kind" ADD VALUE 'redeem';--> statement-breakpoint
ALTER TYPE "public"."loyalty_transaction_kind" ADD VALUE 'reinstate';--> statement-breakpoint
ALTER TYPE "public"."loyalty_transaction_kind" ADD VALUE 'expire';--> statement-breakpoint
ALTER TYPE "public"."reward_status" ADD VALUE 'expired';--> statement-breakpoint
CREATE TABLE "loyalty_card_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_in_store_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"staff_user_id" text,
	"receipt_reference" text NOT NULL,
	"items" jsonb NOT NULL,
	"stamps_earned" integer DEFAULT 0 NOT NULL,
	"program_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" text,
	"void_reason" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_in_store_visits_idempotencyKey_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "loyalty_in_store_visits_stamps" CHECK ("loyalty_in_store_visits"."stamps_earned" >= 0),
	CONSTRAINT "loyalty_in_store_visits_void" CHECK (("loyalty_in_store_visits"."voided_at" is null) = ("loyalty_in_store_visits"."void_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "loyalty_programs" (
	"version" integer PRIMARY KEY NOT NULL,
	"stamps_per_reward" integer NOT NULL,
	"earn_on" "loyalty_earn_trigger" DEFAULT 'paid' NOT NULL,
	"min_paid_cents_per_drink" integer DEFAULT 1 NOT NULL,
	"max_stamps_per_purchase" integer,
	"excluded_product_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"excluded_variant_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"reward_excluded_product_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"reward_excluded_variant_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"reward_value_cap_cents" integer,
	"reward_covers_modifiers" boolean DEFAULT false NOT NULL,
	"reward_expiry_days" integer,
	"refund_shortfall_policy" "loyalty_refund_shortfall_policy" DEFAULT 'carry_forward' NOT NULL,
	"reward_on_refund" "loyalty_reward_refund_policy" DEFAULT 'reinstate' NOT NULL,
	"in_store_enabled" boolean DEFAULT true NOT NULL,
	"in_store_max_stamps_per_visit" integer DEFAULT 10 NOT NULL,
	"in_store_max_stamps_per_day" integer DEFAULT 10 NOT NULL,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_programs_version_positive" CHECK ("loyalty_programs"."version" > 0),
	CONSTRAINT "loyalty_programs_stamps" CHECK ("loyalty_programs"."stamps_per_reward" between 2 and 20),
	CONSTRAINT "loyalty_programs_min_paid" CHECK ("loyalty_programs"."min_paid_cents_per_drink" >= 0),
	CONSTRAINT "loyalty_programs_caps" CHECK (("loyalty_programs"."max_stamps_per_purchase" is null or "loyalty_programs"."max_stamps_per_purchase" > 0) and "loyalty_programs"."in_store_max_stamps_per_visit" > 0 and "loyalty_programs"."in_store_max_stamps_per_day" > 0),
	CONSTRAINT "loyalty_programs_reward" CHECK (("loyalty_programs"."reward_value_cap_cents" is null or "loyalty_programs"."reward_value_cap_cents" > 0) and ("loyalty_programs"."reward_expiry_days" is null or "loyalty_programs"."reward_expiry_days" > 0))
);
--> statement-breakpoint
ALTER TABLE "loyalty_transactions" DROP CONSTRAINT "loyalty_transactions_nonzero";--> statement-breakpoint
ALTER TABLE "loyalty_transactions" DROP CONSTRAINT "loyalty_transactions_sign";--> statement-breakpoint
DROP INDEX "loyalty_transactions_item_kind_uq";--> statement-breakpoint
DROP INDEX "loyalty_transactions_account_idx";--> statement-breakpoint
ALTER TABLE "reward_redemptions" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "reward_discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD COLUMN "stamp_debt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "seq" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "loyalty_transactions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "source" "loyalty_source" DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "debt_delta" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "balance_after" integer;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "debt_after" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "refund_id" uuid;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "in_store_visit_id" uuid;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "reward_id" uuid;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "program_version" integer;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "reward_redemptions" ADD COLUMN "in_store_visit_id" uuid;--> statement-breakpoint
ALTER TABLE "rewards" ADD COLUMN "stamps_cost" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "rewards" ADD COLUMN "program_version" integer;--> statement-breakpoint
ALTER TABLE "rewards" ADD COLUMN "covers_modifiers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rewards" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rewards" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
-- Backfill Phase 3 ledger rows (hand-written): running balance, a legacy idempotency key,
-- the order, the reward a conversion produced, and the source. Then require the new columns.
UPDATE "loyalty_transactions" t SET "balance_after" = s.running FROM (
	SELECT "id", GREATEST(0, sum("stamps") OVER (
		PARTITION BY "account_id"
		ORDER BY "created_at", CASE "kind"::text WHEN 'convert' THEN 2 WHEN 'reverse' THEN 1 ELSE 0 END, "id"
	)) AS running
	FROM "loyalty_transactions"
) s WHERE s."id" = t."id";--> statement-breakpoint
UPDATE "loyalty_transactions" SET "idempotency_key" = 'legacy:' || "id";--> statement-breakpoint
UPDATE "loyalty_transactions" t SET "order_id" = oi."order_id", "source" = 'online_order'
	FROM "order_items" oi WHERE oi."id" = t."order_item_id";--> statement-breakpoint
UPDATE "loyalty_transactions" SET "source" = 'staff' WHERE "kind"::text = 'adjust';--> statement-breakpoint
UPDATE "loyalty_transactions" t SET "reward_id" = r."id"
	FROM "rewards" r WHERE r."source_transaction_id" = t."id";--> statement-breakpoint
UPDATE "rewards" SET "program_version" = 1;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ALTER COLUMN "balance_after" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
-- Version 1 of the program: every five qualifying paid drinks earn one free eligible drink.
INSERT INTO "loyalty_programs" ("version", "stamps_per_reward", "note")
	VALUES (1, 5, 'Initial rule: 5 qualifying paid drinks = 1 free eligible drink')
	ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "loyalty_card_codes" ADD CONSTRAINT "loyalty_card_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_in_store_visits" ADD CONSTRAINT "loyalty_in_store_visits_account_id_loyalty_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."loyalty_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_in_store_visits" ADD CONSTRAINT "loyalty_in_store_visits_staff_user_id_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_in_store_visits" ADD CONSTRAINT "loyalty_in_store_visits_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_card_codes_user_idx" ON "loyalty_card_codes" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_in_store_visits_receipt_uq" ON "loyalty_in_store_visits" USING btree ("receipt_reference");--> statement-breakpoint
CREATE INDEX "loyalty_in_store_visits_account_idx" ON "loyalty_in_store_visits" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_in_store_visit_id_loyalty_in_store_visits_id_fk" FOREIGN KEY ("in_store_visit_id") REFERENCES "public"."loyalty_in_store_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_reward_id_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."rewards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_in_store_visit_id_loyalty_in_store_visits_id_fk" FOREIGN KEY ("in_store_visit_id") REFERENCES "public"."loyalty_in_store_visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_transactions_order_idx" ON "loyalty_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_kind_idx" ON "loyalty_transactions" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_account_idx" ON "loyalty_transactions" USING btree ("account_id","seq");--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_idempotencyKey_unique" UNIQUE("idempotency_key");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_discounts" CHECK ("order_items"."discount_cents" >= 0 and "order_items"."reward_discount_cents" >= 0 and "order_items"."discount_cents" + "order_items"."reward_discount_cents" <= "order_items"."line_total_cents");--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_debt_nonnegative" CHECK ("loyalty_accounts"."stamp_debt" >= 0);--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_after_nonnegative" CHECK ("loyalty_transactions"."balance_after" >= 0 and "loyalty_transactions"."debt_after" >= 0);--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_sign" CHECK (case "loyalty_transactions"."kind"::text
        when 'earn' then "loyalty_transactions"."stamps" > 0 and "loyalty_transactions"."debt_delta" = 0
        when 'convert' then "loyalty_transactions"."stamps" < 0 and "loyalty_transactions"."debt_delta" = 0
        when 'reverse' then "loyalty_transactions"."stamps" <= 0 and "loyalty_transactions"."debt_delta" >= 0
        when 'repay' then "loyalty_transactions"."stamps" < 0 and "loyalty_transactions"."debt_delta" = "loyalty_transactions"."stamps"
        when 'revoke' then "loyalty_transactions"."stamps" >= 0 and "loyalty_transactions"."debt_delta" = 0 and "loyalty_transactions"."reward_id" is not null
        when 'adjust' then ("loyalty_transactions"."stamps" <> 0 or "loyalty_transactions"."debt_delta" < 0) and "loyalty_transactions"."debt_delta" <= 0
        else "loyalty_transactions"."stamps" = 0 and "loyalty_transactions"."debt_delta" = 0 and "loyalty_transactions"."reward_id" is not null
      end);--> statement-breakpoint
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_one_target" CHECK (("reward_redemptions"."order_id" is null) <> ("reward_redemptions"."in_store_visit_id" is null));--> statement-breakpoint
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_cost_positive" CHECK ("rewards"."stamps_cost" > 0);