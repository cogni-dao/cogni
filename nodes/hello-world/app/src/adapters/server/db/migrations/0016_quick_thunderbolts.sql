CREATE TABLE "epoch_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"artifact_ref" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"algo_ref" text NOT NULL,
	"inputs_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_json" jsonb,
	"payload_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "epoch_artifacts_status_check" CHECK ("epoch_artifacts"."status" IN ('draft', 'locked')),
	CONSTRAINT "epoch_artifacts_payload_check" CHECK ("epoch_artifacts"."payload_json" IS NOT NULL OR "epoch_artifacts"."payload_ref" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "epochs" ADD COLUMN "artifacts_hash" text;--> statement-breakpoint
ALTER TABLE "epoch_artifacts" ADD CONSTRAINT "epoch_artifacts_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_artifacts_ref_status_unique" ON "epoch_artifacts" USING btree ("epoch_id","artifact_ref","status");--> statement-breakpoint
CREATE INDEX "epoch_artifacts_epoch_idx" ON "epoch_artifacts" USING btree ("epoch_id");
