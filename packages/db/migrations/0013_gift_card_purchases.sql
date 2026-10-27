CREATE TABLE "gift_card_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'awaiting_payment' NOT NULL,
	"amount_cents" integer NOT NULL,
	"purchaser_user_id" text,
	"purchaser_name" text NOT NULL,
	"purchaser_email" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_email" text NOT NULL,
	"message" text,
	"locale" text DEFAULT 'fr-CA' NOT NULL,
	"access_token_hash" text,
	"provider" "payment_provider" NOT NULL,
	"provider_session_id" text,
	"checkout_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"provider_payment_id" text,
	"paid_at" timestamp with time zone,
	"gift_card_id" uuid,
	"provider_refund_id" text,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_purchases_providerSessionId_unique" UNIQUE("provider_session_id"),
	CONSTRAINT "gift_card_purchases_amount" CHECK ("gift_card_purchases"."amount_cents" > 0),
	CONSTRAINT "gift_card_purchases_status" CHECK ("gift_card_purchases"."status" in ('awaiting_payment', 'paid', 'expired', 'refunded')),
	CONSTRAINT "gift_card_purchases_paid_has_card" CHECK ("gift_card_purchases"."status" not in ('paid', 'refunded') or "gift_card_purchases"."gift_card_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "gift_card_purchases" ADD CONSTRAINT "gift_card_purchases_purchaser_user_id_users_id_fk" FOREIGN KEY ("purchaser_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_purchases" ADD CONSTRAINT "gift_card_purchases_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gift_card_purchases_status_idx" ON "gift_card_purchases" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "gift_card_purchases_user_idx" ON "gift_card_purchases" USING btree ("purchaser_user_id");