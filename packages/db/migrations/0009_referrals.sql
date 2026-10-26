CREATE TABLE "referral_codes" (
	"user_id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_user_id" text NOT NULL,
	"referee_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"order_id" uuid,
	"rewarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_refereeUserId_unique" UNIQUE("referee_user_id"),
	CONSTRAINT "referrals_status" CHECK ("referrals"."status" in ('pending', 'rewarded', 'declined')),
	CONSTRAINT "referrals_not_self" CHECK ("referrals"."referrer_user_id" <> "referrals"."referee_user_id")
);
--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN "referral_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN "referrer_stamps" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN "referee_stamps" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN "referral_min_order_cents" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD COLUMN "referral_monthly_cap" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_user_id_users_id_fk" FOREIGN KEY ("referee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_user_id","rewarded_at");--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_referral" CHECK ("loyalty_programs"."referrer_stamps" between 0 and 10 and "loyalty_programs"."referee_stamps" between 0 and 10 and "loyalty_programs"."referral_min_order_cents" >= 0 and "loyalty_programs"."referral_monthly_cap" between 1 and 50);