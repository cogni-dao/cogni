ALTER TABLE "schedule_runs" RENAME TO "graph_runs";
--> statement-breakpoint
ALTER TABLE "graph_runs" ALTER COLUMN "schedule_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "graph_runs" ALTER COLUMN "scheduled_for" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "graph_runs" ADD COLUMN "graph_id" text;
--> statement-breakpoint
ALTER TABLE "graph_runs" ADD COLUMN "run_kind" text;
--> statement-breakpoint
ALTER TABLE "graph_runs" ADD COLUMN "trigger_source" text;
--> statement-breakpoint
ALTER TABLE "graph_runs" ADD COLUMN "trigger_ref" text;
--> statement-breakpoint
ALTER TABLE "graph_runs" ADD COLUMN "requested_by" text;
--> statement-breakpoint
ALTER TABLE "graph_runs" ADD COLUMN "error_code" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "schedule_runs_schedule_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "schedule_runs_scheduled_for_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "schedule_runs_run_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "schedule_runs_schedule_slot_unique";
--> statement-breakpoint
CREATE INDEX "graph_runs_schedule_idx" ON "graph_runs" USING btree ("schedule_id");
--> statement-breakpoint
CREATE INDEX "graph_runs_scheduled_for_idx" ON "graph_runs" USING btree ("scheduled_for");
--> statement-breakpoint
CREATE INDEX "graph_runs_run_id_idx" ON "graph_runs" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "graph_runs_run_kind_idx" ON "graph_runs" USING btree ("run_kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "graph_runs_schedule_slot_unique" ON "graph_runs" ("schedule_id", "scheduled_for") WHERE schedule_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "graph_runs" DROP CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk";
--> statement-breakpoint
ALTER TABLE "graph_runs" ADD CONSTRAINT "graph_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;
