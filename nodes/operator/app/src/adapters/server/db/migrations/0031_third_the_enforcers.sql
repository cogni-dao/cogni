CREATE TABLE "agent_transcript_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_id" text NOT NULL,
	"principal_name" text,
	"session_id" text NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"repo" text,
	"node" text,
	"head_sha" text,
	"branch" text,
	"cwd" text,
	"transcript_path" text,
	"body" text NOT NULL,
	"byte_len" integer DEFAULT 0 NOT NULL,
	"pr_number" integer,
	"harvested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_transcript_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_transcript_chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_transcript_chunks" ADD CONSTRAINT "agent_transcript_chunks_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_transcript_chunks_session_cursor_idx" ON "agent_transcript_chunks" USING btree ("session_id","cursor");--> statement-breakpoint
CREATE INDEX "agent_transcript_chunks_principal_idx" ON "agent_transcript_chunks" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "agent_transcript_chunks_session_idx" ON "agent_transcript_chunks" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_transcript_chunks_head_sha_idx" ON "agent_transcript_chunks" USING btree ("head_sha");--> statement-breakpoint
CREATE INDEX "agent_transcript_chunks_unharvested_idx" ON "agent_transcript_chunks" USING btree ("created_at") WHERE "agent_transcript_chunks"."harvested_at" IS NULL;
