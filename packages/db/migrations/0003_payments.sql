CREATE TYPE "public"."payment_attempt_status" AS ENUM('open', 'processing', 'succeeded', 'failed', 'expired', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."order_event_type" ADD VALUE 'checkout_started';--> statement-breakpoint
ALTER TYPE "public"."order_event_type" ADD VALUE 'payment_processing';--> statement-breakpoint
ALTER TYPE "public"."order_event_type" ADD VALUE 'refund_requested';--> statement-breakpoint
ALTER TYPE "public"."order_event_type" ADD VALUE 'refund_failed';--> statement-breakpoint
ALTER TYPE "public"."order_event_type" ADD VALUE 'dispute_updated';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'partially_refunded';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'refunded';--> statement-breakpoint
ALTER TYPE "public"."refund_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_session_id" text NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'open' NOT NULL,
	"amount_cents" integer NOT NULL,
	"checkout_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_provider_session_uq" UNIQUE("provider","provider_session_id"),
	CONSTRAINT "payment_attempts_amount_positive" CHECK ("payment_attempts"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_customers" (
	"user_id" text NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_customers_user_provider_uq" UNIQUE("user_id","provider"),
	CONSTRAINT "payment_customers_provider_ref_uq" UNIQUE("provider","provider_customer_id")
);
--> statement-breakpoint
CREATE TABLE "payment_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid,
	"order_id" uuid,
	"provider" "payment_provider" NOT NULL,
	"provider_dispute_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"evidence_due_by" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_disputes_provider_ref_uq" UNIQUE("provider","provider_dispute_id")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reconciliation" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "source" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_customers" ADD CONSTRAINT "payment_customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_one_live_per_order_uq" ON "payment_attempts" USING btree ("order_id") WHERE "payment_attempts"."status" in ('open', 'processing');--> statement-breakpoint
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payment_disputes_status_idx" ON "payment_disputes" USING btree ("status");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_primary_per_order_uq" ON "payments" USING btree ("order_id") WHERE "payments"."reconciliation" is null and "payments"."status" <> 'failed';--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_ref_uq" ON "refunds" USING btree ("provider_refund_id") WHERE "refunds"."provider_refund_id" is not null;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconciliation" CHECK ("payments"."reconciliation" is null or "payments"."reconciliation" in ('late', 'duplicate', 'amount_mismatch'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_source" CHECK ("refunds"."source" in ('staff', 'customer_cancel', 'system', 'provider'));