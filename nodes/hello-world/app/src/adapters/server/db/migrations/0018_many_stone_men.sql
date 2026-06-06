CREATE TABLE "epoch_receipt_claimants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"receipt_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"resolver_ref" text NOT NULL,
	"algo_ref" text NOT NULL,
	"inputs_hash" text NOT NULL,
	"claimants_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "epoch_receipt_claimants_status_check" CHECK ("epoch_receipt_claimants"."status" IN ('draft', 'locked'))
);
--> statement-breakpoint
ALTER TABLE "epoch_receipt_claimants" ADD CONSTRAINT "epoch_receipt_claimants_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_receipt_claimants_draft_uniq" ON "epoch_receipt_claimants" USING btree ("node_id","epoch_id","receipt_id") WHERE "epoch_receipt_claimants"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_receipt_claimants_locked_uniq" ON "epoch_receipt_claimants" USING btree ("node_id","epoch_id","receipt_id") WHERE "epoch_receipt_claimants"."status" = 'locked';--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_receipt_claimants_inputs_uniq" ON "epoch_receipt_claimants" USING btree ("node_id","epoch_id","receipt_id","inputs_hash");--> statement-breakpoint
CREATE INDEX "epoch_receipt_claimants_epoch_status_idx" ON "epoch_receipt_claimants" USING btree ("node_id","epoch_id","status");