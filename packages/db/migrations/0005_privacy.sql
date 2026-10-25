CREATE TABLE "confidentiality_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone,
	"discovered_at" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"data_involved" text NOT NULL,
	"people_affected" integer,
	"risk_of_serious_injury" boolean,
	"risk_assessment" text,
	"measures_taken" text,
	"commission_notified_at" timestamp with time zone,
	"people_notified_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confidentiality_incidents_status" CHECK ("confidentiality_incidents"."status" in ('open', 'closed')),
	CONSTRAINT "confidentiality_incidents_closed" CHECK (("confidentiality_incidents"."status" = 'closed') = ("confidentiality_incidents"."closed_at" is not null)),
	CONSTRAINT "confidentiality_incidents_people" CHECK ("confidentiality_incidents"."people_affected" is null or "confidentiality_incidents"."people_affected" >= 0)
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"subject_user_id" text,
	"subject_contact" text,
	"details" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" text,
	"handled_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_requests_kind" CHECK ("privacy_requests"."kind" in ('access', 'export', 'rectification', 'deletion', 'withdrawal', 'other')),
	CONSTRAINT "privacy_requests_channel" CHECK ("privacy_requests"."channel" in ('self_service', 'email', 'phone', 'in_person', 'mail')),
	CONSTRAINT "privacy_requests_status" CHECK ("privacy_requests"."status" in ('open', 'completed', 'refused')),
	CONSTRAINT "privacy_requests_closed" CHECK (("privacy_requests"."status" = 'open') = ("privacy_requests"."completed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "privacy_officer_name" text;--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "privacy_officer_email" text;--> statement-breakpoint
ALTER TABLE "confidentiality_incidents" ADD CONSTRAINT "confidentiality_incidents_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_handled_by_user_id_users_id_fk" FOREIGN KEY ("handled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "confidentiality_incidents_discovered_idx" ON "confidentiality_incidents" USING btree ("discovered_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_status_idx" ON "privacy_requests" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_subject_idx" ON "privacy_requests" USING btree ("subject_user_id");