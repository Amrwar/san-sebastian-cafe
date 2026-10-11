CREATE TYPE "public"."order_event_type" AS ENUM('created', 'status_changed', 'payment_recorded', 'payment_failed', 'refund_recorded', 'customer_updated', 'staff_note_updated');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE "product_availability_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	CONSTRAINT "product_availability_windows_range" CHECK ("product_availability_windows"."weekday" between 0 and 6 and "product_availability_windows"."start_minute" >= 0 and "product_availability_windows"."end_minute" <= 1440 and "product_availability_windows"."start_minute" < "product_availability_windows"."end_minute")
);
--> statement-breakpoint
CREATE TABLE "variant_option_rules" (
	"variant_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"price_delta_cents" integer,
	"excluded" boolean DEFAULT false NOT NULL,
	CONSTRAINT "variant_option_rules_variant_id_option_id_pk" PRIMARY KEY("variant_id","option_id"),
	CONSTRAINT "variant_option_rules_meaningful" CHECK ("variant_option_rules"."excluded" or "variant_option_rules"."price_delta_cents" is not null)
);
--> statement-breakpoint
CREATE TABLE "order_counters" (
	"local_date" date PRIMARY KEY NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"type" "order_event_type" NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_user_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"provider_refund_id" text,
	"requested_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "store_settings" DROP CONSTRAINT "store_settings_ranges";--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "unavailable_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "unavailable_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "staff_notes" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "guest_phone" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "guest_access_token_hash" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "slot_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "order_cutoff_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "min_lead_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "max_orders_per_slot" integer;--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "auto_accept" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "unpaid_ttl_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_availability_windows" ADD CONSTRAINT "product_availability_windows_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_option_rules" ADD CONSTRAINT "variant_option_rules_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_option_rules" ADD CONSTRAINT "variant_option_rules_option_id_modifier_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."modifier_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_availability_windows_product_idx" ON "product_availability_windows" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_slot_idx" ON "orders" USING btree ("slot_start","status");--> statement-breakpoint
ALTER TABLE "store_settings" ADD CONSTRAINT "store_settings_ranges" CHECK ("store_settings"."prep_minutes" between 0 and 240 and "store_settings"."slot_minutes" between 5 and 120 and "store_settings"."days_ahead" between 0 and 14 and "store_settings"."order_cutoff_minutes" between 0 and 240 and "store_settings"."min_lead_minutes" between 0 and 1440 and ("store_settings"."max_orders_per_slot" is null or "store_settings"."max_orders_per_slot" > 0) and "store_settings"."unpaid_ttl_minutes" between 5 and 120);