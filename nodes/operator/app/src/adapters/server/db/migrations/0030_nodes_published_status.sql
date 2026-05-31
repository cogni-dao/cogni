ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "nodes_status_check";
--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_status_check" CHECK ("status" IN ('dao_pending','dao_formed','published','wallet_ready','payments_ready','active','failed'));
