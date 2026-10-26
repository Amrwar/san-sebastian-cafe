ALTER TABLE "modifier_options" ADD COLUMN "low_stock_threshold" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "low_stock_threshold" integer;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_low_stock_nonnegative" CHECK ("modifier_options"."low_stock_threshold" is null or "modifier_options"."low_stock_threshold" >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_low_stock_nonnegative" CHECK ("products"."low_stock_threshold" is null or "products"."low_stock_threshold" >= 0);