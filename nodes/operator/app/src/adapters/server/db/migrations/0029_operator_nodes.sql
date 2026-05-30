CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"repo_url" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"repo_visibility" text DEFAULT 'public' NOT NULL,
	"owner_user_id" text NOT NULL,
	"status" text DEFAULT 'dao_pending' NOT NULL,
	"chain_id" integer,
	"dao_address" text,
	"plugin_address" text,
	"signal_address" text,
	"token_address" text,
	"operator_wallet_address" text,
	"operator_wallet_privy_id" text,
	"split_address" text,
	"dao_tx_hash" text,
	"signal_tx_hash" text,
	"signal_block_number" bigint,
	"split_tx_hash" text,
	"publish_pr_url" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_slug_unique" UNIQUE("slug"),
	CONSTRAINT "nodes_repo_url_unique" UNIQUE("repo_url"),
	CONSTRAINT "nodes_status_check" CHECK ("nodes"."status" IN ('dao_pending','dao_formed','wallet_ready','payments_ready','active','failed')),
	CONSTRAINT "nodes_repo_visibility_check" CHECK ("nodes"."repo_visibility" IN ('public','private'))
);
--> statement-breakpoint
ALTER TABLE "nodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "nodes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nodes_owner_user_id_idx" ON "nodes" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "nodes_status_idx" ON "nodes" USING btree ("status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "nodes"
  USING ("owner_user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("owner_user_id" = current_setting('app.current_user_id', true));
