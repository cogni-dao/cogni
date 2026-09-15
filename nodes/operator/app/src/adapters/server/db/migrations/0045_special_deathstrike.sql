CREATE TABLE "akash_tx_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_scope" text NOT NULL,
	"cogni_key" text NOT NULL,
	"workload" text NOT NULL,
	"environment" text NOT NULL,
	"state" text NOT NULL,
	"allocation_cursor" text,
	"external_name" text,
	"provider_account" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "akash_tx_allocations_state_check" CHECK ("akash_tx_allocations"."state" IN ('preparing', 'allocated', 'released', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "akash_tx_allocations_key_idx" ON "akash_tx_allocations" USING btree ("wallet_scope","cogni_key");--> statement-breakpoint
CREATE UNIQUE INDEX "akash_tx_allocations_single_writer_idx" ON "akash_tx_allocations" USING btree ("wallet_scope") WHERE "akash_tx_allocations"."state" = 'preparing';--> statement-breakpoint
CREATE INDEX "akash_tx_allocations_external_name_idx" ON "akash_tx_allocations" USING btree ("external_name");