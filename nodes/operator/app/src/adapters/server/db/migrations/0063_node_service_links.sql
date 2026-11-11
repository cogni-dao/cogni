CREATE TABLE "node_service_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"service" text NOT NULL,
	"audience" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"jti" uuid NOT NULL,
	"device_code_enc" "bytea",
	"cnf_private_key_enc" "bytea",
	"encryption_key_id" text NOT NULL,
	"poll_interval_s" integer DEFAULT 5 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"device_code_expires_at" timestamp with time zone NOT NULL,
	"connection_id" uuid,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone,
	CONSTRAINT "node_service_links_service_check" CHECK ("node_service_links"."service" IN ('git-review')),
	CONSTRAINT "node_service_links_state_check" CHECK ("node_service_links"."state" IN ('pending', 'connected', 'needs_reenroll', 'failed', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "node_service_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_provider_check";--> statement-breakpoint
DROP INDEX "connections_billing_account_provider_active_idx";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "audience" text;--> statement-breakpoint
ALTER TABLE "node_service_links" ADD CONSTRAINT "node_service_links_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_service_links" ADD CONSTRAINT "node_service_links_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "node_service_links_jti_idx" ON "node_service_links" USING btree ("jti");--> statement-breakpoint
CREATE UNIQUE INDEX "node_service_links_open_idx" ON "node_service_links" USING btree ("node_id","service") WHERE "node_service_links"."state" IN ('pending', 'connected');--> statement-breakpoint
CREATE INDEX "node_service_links_node_idx" ON "node_service_links" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_billing_account_provider_audience_active_idx" ON "connections" USING btree ("billing_account_id","provider",coalesce("audience", '')) WHERE "connections"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider_check" CHECK ("connections"."provider" IN ('openai-chatgpt', 'openai-compatible', 'github', 'google', 'bluesky', 'cogni-node'));--> statement-breakpoint
ALTER TABLE "node_service_links" FORCE ROW LEVEL SECURITY;
