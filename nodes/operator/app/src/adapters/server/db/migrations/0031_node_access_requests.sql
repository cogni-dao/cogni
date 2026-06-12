CREATE TABLE "node_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"agent_user_id" text NOT NULL,
	"role" text DEFAULT 'developer' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_access_requests_node_agent_key" UNIQUE("node_id","agent_user_id"),
	CONSTRAINT "node_access_requests_status_check" CHECK ("node_access_requests"."status" IN ('pending','approved','denied','revoked')),
	CONSTRAINT "node_access_requests_role_check" CHECK ("node_access_requests"."role" IN ('developer'))
);
--> statement-breakpoint
ALTER TABLE "node_access_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "node_access_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "node_access_requests" ADD CONSTRAINT "node_access_requests_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_access_requests" ADD CONSTRAINT "node_access_requests_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_access_requests_node_id_idx" ON "node_access_requests" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "node_access_requests_agent_user_id_idx" ON "node_access_requests" USING btree ("agent_user_id");
