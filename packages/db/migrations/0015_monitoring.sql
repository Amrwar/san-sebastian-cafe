CREATE TABLE "job_runs" (
	"job" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"last_error" text,
	"runs" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "job_runs_job" CHECK ("job_runs"."job" in ('outbox', 'payments', 'retention', 'monitor'))
);
--> statement-breakpoint
CREATE TABLE "monitor_signals" (
	"signal" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "monitor_signals_status" CHECK ("monitor_signals"."status" in ('ok', 'warn', 'fail'))
);
