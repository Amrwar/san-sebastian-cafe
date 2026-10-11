CREATE TABLE "favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"option_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opening_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"weekday" smallint NOT NULL,
	"opens_at_minute" integer NOT NULL,
	"closes_at_minute" integer NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_hours_range" CHECK ("opening_hours"."weekday" between 0 and 6 and "opening_hours"."opens_at_minute" >= 0 and "opening_hours"."closes_at_minute" <= 1440 and "opening_hours"."opens_at_minute" < "opening_hours"."closes_at_minute")
);
--> statement-breakpoint
CREATE TABLE "store_closures" (
	"local_date" date PRIMARY KEY NOT NULL,
	"reason_fr" text,
	"reason_en" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"online_ordering_enabled" boolean DEFAULT false NOT NULL,
	"prep_minutes" integer DEFAULT 10 NOT NULL,
	"slot_minutes" integer DEFAULT 15 NOT NULL,
	"days_ahead" integer DEFAULT 2 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_settings_singleton" CHECK ("store_settings"."id" = 1),
	CONSTRAINT "store_settings_ranges" CHECK ("store_settings"."prep_minutes" between 0 and 240 and "store_settings"."slot_minutes" between 5 and 120 and "store_settings"."days_ahead" between 0 and 14)
);
--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_user_configuration_uq" ON "favorites" USING btree ("user_id","product_id","variant_id","option_ids");--> statement-breakpoint
CREATE INDEX "favorites_user_idx" ON "favorites" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "opening_hours_weekday_idx" ON "opening_hours" USING btree ("weekday");