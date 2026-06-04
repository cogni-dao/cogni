ALTER TABLE "graph_runs" ADD COLUMN "state_key" text;--> statement-breakpoint
CREATE INDEX "graph_runs_state_key_idx" ON "graph_runs" USING btree ("state_key");