CREATE TABLE "epoch_distribution_leaves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"leaf_index" integer NOT NULL,
	"claimant_key" text NOT NULL,
	"account" text NOT NULL,
	"account_lower" text NOT NULL,
	"amount" bigint NOT NULL,
	"leaf_hash" text NOT NULL,
	"proof_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epoch_distribution_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"distribution_id" text NOT NULL,
	"statement_hash" text NOT NULL,
	"merkle_root" text NOT NULL,
	"chain_id" bigint NOT NULL,
	"token_address" text NOT NULL,
	"distribution_amount" bigint NOT NULL,
	"total_allocated" bigint NOT NULL,
	"distributor_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "epoch_distribution_leaves" ADD CONSTRAINT "epoch_distribution_leaves_manifest_id_epoch_distribution_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."epoch_distribution_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_distribution_leaves" ADD CONSTRAINT "epoch_distribution_leaves_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_distribution_manifests" ADD CONSTRAINT "epoch_distribution_manifests_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_distribution_leaves_manifest_index_unique" ON "epoch_distribution_leaves" USING btree ("manifest_id","leaf_index");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_distribution_leaves_manifest_account_unique" ON "epoch_distribution_leaves" USING btree ("manifest_id","account_lower");--> statement-breakpoint
CREATE INDEX "epoch_distribution_leaves_epoch_idx" ON "epoch_distribution_leaves" USING btree ("epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_distribution_manifests_node_scope_epoch_unique" ON "epoch_distribution_manifests" USING btree ("node_id","scope_id","epoch_id");--> statement-breakpoint
CREATE INDEX "epoch_distribution_manifests_epoch_idx" ON "epoch_distribution_manifests" USING btree ("epoch_id");