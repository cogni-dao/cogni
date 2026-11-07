CREATE TABLE "metric_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"metric_id" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"definition_hash" text NOT NULL,
	"evaluation_at" timestamp with time zone NOT NULL,
	"snapshot" jsonb NOT NULL,
	"observation" jsonb NOT NULL,
	"status" text NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "metric_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "metric_refresh_cursors" (
	"scope" text PRIMARY KEY NOT NULL,
	"last_metric_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "metric_refresh_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "metric_scheduled_slot" ON "metric_observations" USING btree ("scope","metric_id","definition_hash","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_observation_slot" ON "metric_observations" USING btree ("scope","metric_id","definition_hash","evaluation_at");--> statement-breakpoint
ALTER TABLE "metric_observations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "metric_refresh_cursors" FORCE ROW LEVEL SECURITY;
