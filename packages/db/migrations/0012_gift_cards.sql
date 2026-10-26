CREATE TABLE "gift_card_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"delta_cents" integer NOT NULL,
	"balance_after_cents" integer NOT NULL,
	"order_id" uuid,
	"refund_id" uuid,
	"actor_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_transactions_kind" CHECK ("gift_card_transactions"."kind" in ('issue', 'redeem', 'release', 'refund', 'adjustment')),
	CONSTRAINT "gift_card_transactions_balance" CHECK ("gift_card_transactions"."balance_after_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"code_last4" text NOT NULL,
	"initial_cents" integer NOT NULL,
	"balance_cents" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_by_user_id" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_cards_codeHash_unique" UNIQUE("code_hash"),
	CONSTRAINT "gift_cards_amounts" CHECK ("gift_cards"."initial_cents" > 0 and "gift_cards"."balance_cents" >= 0),
	CONSTRAINT "gift_cards_status" CHECK ("gift_cards"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_card_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_card_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "gift_card_id" uuid;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gift_card_transactions_card_idx" ON "gift_card_transactions" USING btree ("gift_card_id","created_at");--> statement-breakpoint
CREATE INDEX "gift_card_transactions_order_idx" ON "gift_card_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "gift_cards_status_idx" ON "gift_cards" USING btree ("status");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_gift_card_within_total" CHECK ("orders"."gift_card_cents" >= 0 and "orders"."gift_card_cents" <= "orders"."total_cents" and ("orders"."gift_card_cents" = 0 or "orders"."gift_card_id" is not null));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_one_tender" CHECK ("refunds"."payment_id" is null or "refunds"."gift_card_id" is null);