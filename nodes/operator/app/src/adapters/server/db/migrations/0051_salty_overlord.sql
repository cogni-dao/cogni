CREATE TABLE "node_migration_reports" (
	"node_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"declared" jsonb NOT NULL,
	"applied" jsonb NOT NULL,
	"applied_count" integer NOT NULL,
	"bundle_digest" text,
	"reporter" text NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_migration_reports_pkey" PRIMARY KEY("node_id","environment")
);
--> statement-breakpoint
CREATE INDEX "node_migration_reports_reported_at_idx" ON "node_migration_reports" USING btree ("reported_at");