ALTER TABLE "work_item_sessions" ADD COLUMN "repo_full_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "work_item_sessions_one_session_per_pr_idx" ON "work_item_sessions" USING btree ("repo_full_name","pr_number") WHERE "work_item_sessions"."status" IN ('active','idle') AND "work_item_sessions"."repo_full_name" IS NOT NULL AND "work_item_sessions"."pr_number" IS NOT NULL;
