ALTER TABLE "knowledge" ADD COLUMN "evaluate_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "resolution_strategy" text;--> statement-breakpoint
CREATE INDEX "idx_knowledge_resolver_due" ON "knowledge" USING btree ("evaluate_at","resolution_strategy");