CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"subdomain" text,
	"location_id" integer,
	"message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"notified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "alerts_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"subdomain" text NOT NULL,
	"institution_id" integer,
	"location_id" integer,
	"resource_type" text NOT NULL,
	"event_name" text NOT NULL,
	"event_outcome" text,
	"event_time" timestamp with time zone,
	"record_ids" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"prior_failed_attempts" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"last_duplicate_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "events_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "reconcile_cursors" (
	"subdomain" text NOT NULL,
	"location_id" integer NOT NULL,
	"resource_type" text NOT NULL,
	"cursor" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"last_recovered" integer DEFAULT 0 NOT NULL,
	"total_recovered" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "reconcile_cursors_subdomain_location_id_resource_type_pk" PRIMARY KEY("subdomain","location_id","resource_type")
);
--> statement-breakpoint
CREATE TABLE "rejected_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"claimed_subdomain" text,
	"claimed_event_name" text,
	"timestamp_header" text,
	"body_sha256" text NOT NULL,
	"body_bytes" integer NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_versions" (
	"subdomain" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"location_id" integer,
	"updated_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "resource_versions_subdomain_resource_type_resource_id_pk" PRIMARY KEY("subdomain","resource_type","resource_id")
);
--> statement-breakpoint
CREATE TABLE "sync_health" (
	"subdomain" text NOT NULL,
	"location_id" integer NOT NULL,
	"location_name" text,
	"timezone" text NOT NULL,
	"has_sync" boolean,
	"sync_source_name" text,
	"read_status" text,
	"read_status_at" timestamp with time zone,
	"write_status" text,
	"write_status_at" timestamp with time zone,
	"state" text DEFAULT 'unknown' NOT NULL,
	"red_since" timestamp with time zone,
	"last_source" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sync_health_subdomain_location_id_pk" PRIMARY KEY("subdomain","location_id")
);
--> statement-breakpoint
CREATE TABLE "writes" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_key" text NOT NULL,
	"subdomain" text NOT NULL,
	"location_id" integer NOT NULL,
	"nex_appointment_id" bigint,
	"status" text NOT NULL,
	"status_detail" text,
	"preflight" text NOT NULL,
	"request" jsonb NOT NULL,
	"start_time" timestamp with time zone,
	"patient_initials" text,
	"foreign_id" text,
	"last_error" text,
	"retry_of_id" integer,
	"retried_by_id" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	CONSTRAINT "writes_client_key_unique" UNIQUE("client_key")
);
--> statement-breakpoint
CREATE INDEX "events_subdomain_idx" ON "events" USING btree ("subdomain");--> statement-breakpoint
CREATE INDEX "writes_nex_id_idx" ON "writes" USING btree ("subdomain","nex_appointment_id");