ALTER TYPE "public"."order_status" ADD VALUE 'out_for_delivery';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "out_for_delivery_at" timestamp with time zone;