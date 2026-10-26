CREATE TABLE "marketing_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_fr" text NOT NULL,
	"subject_en" text NOT NULL,
	"body_fr" text NOT NULL,
	"body_en" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"recipient_count" integer,
	"sent_at" timestamp with time zone,
	"created_by_user_id" text,
	"sent_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_campaigns_status" CHECK ("marketing_campaigns"."status" in ('draft', 'sent')),
	CONSTRAINT "marketing_campaigns_sent" CHECK (("marketing_campaigns"."status" = 'sent') = ("marketing_campaigns"."sent_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "sender_name" text;--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "sender_address" text;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;