ALTER TABLE "node_workload_attempts" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "node_workload_attempts" ADD COLUMN "parked_at" timestamp with time zone;