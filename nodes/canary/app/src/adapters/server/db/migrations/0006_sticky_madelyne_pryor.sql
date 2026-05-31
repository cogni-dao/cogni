CREATE TABLE "ai_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"state_key" text NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_threads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_threads_owner_state_key_unique" ON "ai_threads" USING btree ("owner_user_id","state_key");--> statement-breakpoint
CREATE INDEX "ai_threads_owner_updated_idx" ON "ai_threads" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_threads" AS PERMISSIVE FOR ALL TO public USING ("owner_user_id" = current_setting('app.current_user_id', true)) WITH CHECK ("owner_user_id" = current_setting('app.current_user_id', true));