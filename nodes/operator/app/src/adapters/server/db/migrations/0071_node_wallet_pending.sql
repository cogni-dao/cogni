ALTER TABLE "nodes" ADD COLUMN "pending_node_wallet_key_sha256" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "pending_node_wallet_id" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "pending_node_wallet_address" text;