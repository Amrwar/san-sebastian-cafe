CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid,
	"option_id" uuid,
	"delta" integer NOT NULL,
	"quantity_after" integer,
	"reason" text NOT NULL,
	"order_id" uuid,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_one_item" CHECK (("stock_movements"."product_id" is null) <> ("stock_movements"."option_id" is null)),
	CONSTRAINT "stock_movements_reason" CHECK ("stock_movements"."reason" in ('sale', 'release', 'restock', 'adjustment'))
);
--> statement-breakpoint
ALTER TABLE "modifier_options" ADD COLUMN "stock_quantity" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "stock_quantity" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_option_id_modifier_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."modifier_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_movements_order_idx" ON "stock_movements" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "stock_movements_product_idx" ON "stock_movements" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_option_idx" ON "stock_movements" USING btree ("option_id","created_at");--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_stock_nonnegative" CHECK ("modifier_options"."stock_quantity" is null or "modifier_options"."stock_quantity" >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_stock_nonnegative" CHECK ("products"."stock_quantity" is null or "products"."stock_quantity" >= 0);