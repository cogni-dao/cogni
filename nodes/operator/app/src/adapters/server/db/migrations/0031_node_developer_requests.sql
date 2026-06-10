CREATE TABLE "node_developer_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"agent_user_id" text NOT NULL,
	"scope" text DEFAULT 'flight' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_developer_requests_node_agent_key" UNIQUE("node_id","agent_user_id"),
	CONSTRAINT "node_developer_requests_status_check" CHECK ("node_developer_requests"."status" IN ('pending','approved','denied','revoked')),
	CONSTRAINT "node_developer_requests_scope_check" CHECK ("node_developer_requests"."scope" IN ('flight'))
);
--> statement-breakpoint
ALTER TABLE "node_developer_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "node_developer_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "node_developer_requests" ADD CONSTRAINT "node_developer_requests_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_developer_requests" ADD CONSTRAINT "node_developer_requests_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_developer_requests_node_id_idx" ON "node_developer_requests" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "node_developer_requests_agent_user_id_idx" ON "node_developer_requests" USING btree ("agent_user_id");
