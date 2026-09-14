ALTER TABLE "akash_tx_allocations" ADD COLUMN "node_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "akash_tx_allocations" ADD COLUMN "composite_uid" text NOT NULL;--> statement-breakpoint
ALTER TABLE "akash_tx_allocations" ADD COLUMN "composite_generation" integer NOT NULL;--> statement-breakpoint
CREATE INDEX "akash_tx_allocations_node_idx" ON "akash_tx_allocations" USING btree ("node_id","environment");--> statement-breakpoint
ALTER TABLE "akash_tx_allocations" ADD CONSTRAINT "akash_tx_allocations_generation_check" CHECK ("akash_tx_allocations"."composite_generation" > 0);