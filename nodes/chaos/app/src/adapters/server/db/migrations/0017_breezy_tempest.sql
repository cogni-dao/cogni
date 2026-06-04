CREATE TABLE "epoch_final_claimant_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"claimant_key" text NOT NULL,
	"claimant_json" jsonb NOT NULL,
	"final_units" bigint NOT NULL,
	"receipt_ids_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epoch_review_subject_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"subject_ref" text NOT NULL,
	"override_units" bigint,
	"override_shares_json" jsonb,
	"override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_transactions_provider_check" CHECK ("link_transactions"."provider" IN ('github', 'discord', 'google'))
);
--> statement-breakpoint
ALTER TABLE "link_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "epoch_artifacts" RENAME TO "epoch_evaluations";--> statement-breakpoint
ALTER TABLE "activity_curation" RENAME TO "epoch_selection";--> statement-breakpoint
ALTER TABLE "statement_signatures" RENAME TO "epoch_statement_signatures";--> statement-breakpoint
ALTER TABLE "payout_statements" RENAME TO "epoch_statements";--> statement-breakpoint
ALTER TABLE "epoch_allocations" RENAME TO "epoch_user_projections";--> statement-breakpoint
ALTER TABLE "source_cursors" RENAME TO "ingestion_cursors";--> statement-breakpoint
ALTER TABLE "activity_events" RENAME TO "ingestion_receipts";--> statement-breakpoint
ALTER TABLE "epoch_selection" RENAME COLUMN "event_id" TO "receipt_id";--> statement-breakpoint
ALTER TABLE "ingestion_receipts" RENAME COLUMN "id" TO "receipt_id";--> statement-breakpoint
ALTER TABLE "epoch_user_projections" RENAME COLUMN "proposed_units" TO "projected_units";--> statement-breakpoint
ALTER TABLE "epoch_user_projections" RENAME COLUMN "activity_count" TO "receipt_count";--> statement-breakpoint
ALTER TABLE "epoch_evaluations" RENAME COLUMN "artifact_ref" TO "evaluation_ref";--> statement-breakpoint
ALTER TABLE "epoch_statements" RENAME COLUMN "allocation_set_hash" TO "final_allocation_set_hash";--> statement-breakpoint
ALTER TABLE "epoch_statements" RENAME COLUMN "payouts_json" TO "statement_lines_json";--> statement-breakpoint
ALTER TABLE "epoch_evaluations" DROP CONSTRAINT "epoch_artifacts_status_check";--> statement-breakpoint
ALTER TABLE "epoch_evaluations" DROP CONSTRAINT "epoch_artifacts_payload_check";--> statement-breakpoint
ALTER TABLE "epoch_selection" DROP CONSTRAINT "activity_curation_epoch_id_epochs_id_fk";
--> statement-breakpoint
ALTER TABLE "epoch_selection" DROP CONSTRAINT "activity_curation_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "epoch_user_projections" DROP CONSTRAINT "epoch_allocations_epoch_id_epochs_id_fk";
--> statement-breakpoint
ALTER TABLE "epoch_user_projections" DROP CONSTRAINT "epoch_allocations_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "epoch_evaluations" DROP CONSTRAINT "epoch_artifacts_epoch_id_epochs_id_fk";
--> statement-breakpoint
ALTER TABLE "epoch_statements" DROP CONSTRAINT "payout_statements_epoch_id_epochs_id_fk";
--> statement-breakpoint
ALTER TABLE "epoch_statements" DROP CONSTRAINT "payout_statements_supersedes_statement_id_payout_statements_id_fk";
--> statement-breakpoint
ALTER TABLE "epoch_statement_signatures" DROP CONSTRAINT "statement_signatures_statement_id_payout_statements_id_fk";
--> statement-breakpoint
DROP INDEX "activity_curation_epoch_event_unique";--> statement-breakpoint
DROP INDEX "activity_curation_epoch_idx";--> statement-breakpoint
DROP INDEX "activity_events_node_time_idx";--> statement-breakpoint
DROP INDEX "activity_events_source_type_idx";--> statement-breakpoint
DROP INDEX "activity_events_platform_user_idx";--> statement-breakpoint
DROP INDEX "epoch_allocations_epoch_user_unique";--> statement-breakpoint
DROP INDEX "epoch_allocations_epoch_idx";--> statement-breakpoint
DROP INDEX "epoch_artifacts_ref_status_unique";--> statement-breakpoint
DROP INDEX "epoch_artifacts_epoch_idx";--> statement-breakpoint
DROP INDEX "payout_statements_node_epoch_unique";--> statement-breakpoint
DROP INDEX "statement_signatures_statement_signer_unique";--> statement-breakpoint
ALTER TABLE "ingestion_receipts" DROP CONSTRAINT "activity_events_node_id_id_pk";--> statement-breakpoint
ALTER TABLE "ingestion_cursors" DROP CONSTRAINT "source_cursors_node_id_scope_id_source_stream_source_ref_pk";--> statement-breakpoint
ALTER TABLE "ingestion_receipts" ADD CONSTRAINT "ingestion_receipts_node_id_receipt_id_pk" PRIMARY KEY("node_id","receipt_id");--> statement-breakpoint
ALTER TABLE "ingestion_cursors" ADD CONSTRAINT "ingestion_cursors_node_id_scope_id_source_stream_source_ref_pk" PRIMARY KEY("node_id","scope_id","source","stream","source_ref");--> statement-breakpoint
ALTER TABLE "epoch_statements" ADD COLUMN "review_overrides_json" jsonb;--> statement-breakpoint
ALTER TABLE "epoch_final_claimant_allocations" ADD CONSTRAINT "epoch_final_claimant_allocations_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_review_subject_overrides" ADD CONSTRAINT "epoch_review_subject_overrides_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_transactions" ADD CONSTRAINT "link_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_final_claimant_allocations_epoch_claimant_unique" ON "epoch_final_claimant_allocations" USING btree ("epoch_id","claimant_key");--> statement-breakpoint
CREATE INDEX "epoch_final_claimant_allocations_epoch_idx" ON "epoch_final_claimant_allocations" USING btree ("epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_review_subject_overrides_epoch_ref_unique" ON "epoch_review_subject_overrides" USING btree ("epoch_id","subject_ref");--> statement-breakpoint
CREATE INDEX "epoch_review_subject_overrides_epoch_idx" ON "epoch_review_subject_overrides" USING btree ("epoch_id");--> statement-breakpoint
CREATE INDEX "link_transactions_user_id_idx" ON "link_transactions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "epoch_selection" ADD CONSTRAINT "epoch_selection_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_selection" ADD CONSTRAINT "epoch_selection_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_user_projections" ADD CONSTRAINT "epoch_user_projections_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_user_projections" ADD CONSTRAINT "epoch_user_projections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_evaluations" ADD CONSTRAINT "epoch_evaluations_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_statements" ADD CONSTRAINT "epoch_statements_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_statements" ADD CONSTRAINT "epoch_statements_supersedes_statement_id_epoch_statements_id_fk" FOREIGN KEY ("supersedes_statement_id") REFERENCES "public"."epoch_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_statement_signatures" ADD CONSTRAINT "epoch_statement_signatures_statement_id_epoch_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."epoch_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_selection_epoch_receipt_unique" ON "epoch_selection" USING btree ("epoch_id","receipt_id");--> statement-breakpoint
CREATE INDEX "epoch_selection_epoch_idx" ON "epoch_selection" USING btree ("epoch_id");--> statement-breakpoint
CREATE INDEX "ingestion_receipts_node_time_idx" ON "ingestion_receipts" USING btree ("node_id","event_time");--> statement-breakpoint
CREATE INDEX "ingestion_receipts_source_type_idx" ON "ingestion_receipts" USING btree ("source","event_type");--> statement-breakpoint
CREATE INDEX "ingestion_receipts_platform_user_idx" ON "ingestion_receipts" USING btree ("platform_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_user_projections_epoch_user_unique" ON "epoch_user_projections" USING btree ("epoch_id","user_id");--> statement-breakpoint
CREATE INDEX "epoch_user_projections_epoch_idx" ON "epoch_user_projections" USING btree ("epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_evaluations_ref_status_unique" ON "epoch_evaluations" USING btree ("epoch_id","evaluation_ref","status");--> statement-breakpoint
CREATE INDEX "epoch_evaluations_epoch_idx" ON "epoch_evaluations" USING btree ("epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_statements_node_epoch_unique" ON "epoch_statements" USING btree ("node_id","epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_statement_signatures_statement_signer_unique" ON "epoch_statement_signatures" USING btree ("statement_id","signer_wallet");--> statement-breakpoint
ALTER TABLE "ingestion_receipts" DROP COLUMN "scope_id";--> statement-breakpoint
ALTER TABLE "epoch_user_projections" DROP COLUMN "final_units";--> statement-breakpoint
ALTER TABLE "epoch_user_projections" DROP COLUMN "override_reason";--> statement-breakpoint
ALTER TABLE "epoch_evaluations" ADD CONSTRAINT "epoch_evaluations_status_check" CHECK ("epoch_evaluations"."status" IN ('draft', 'locked'));--> statement-breakpoint
ALTER TABLE "epoch_evaluations" ADD CONSTRAINT "epoch_evaluations_payload_check" CHECK ("epoch_evaluations"."payload_json" IS NOT NULL OR "epoch_evaluations"."payload_ref" IS NOT NULL);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "link_transactions" AS PERMISSIVE FOR ALL TO public USING ("link_transactions"."user_id" = current_setting('app.current_user_id', true)) WITH CHECK ("link_transactions"."user_id" = current_setting('app.current_user_id', true));--> statement-breakpoint

-- Handwritten appendix: RLS enforcement and trigger/function preservation.
ALTER TABLE "link_transactions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP TRIGGER IF EXISTS activity_events_immutable ON "ingestion_receipts";--> statement-breakpoint
DROP TRIGGER IF EXISTS epoch_pool_components_immutable ON "epoch_pool_components";--> statement-breakpoint
DROP TRIGGER IF EXISTS activity_curation_freeze ON "epoch_selection";--> statement-breakpoint
DROP FUNCTION IF EXISTS curation_freeze_on_finalize();--> statement-breakpoint

CREATE TRIGGER ingestion_receipts_immutable
  BEFORE UPDATE OR DELETE ON "ingestion_receipts"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();--> statement-breakpoint

CREATE TRIGGER epoch_pool_components_immutable
  BEFORE UPDATE OR DELETE ON "epoch_pool_components"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION selection_freeze_on_finalize() RETURNS trigger AS $$
DECLARE
  epoch_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO epoch_status FROM epochs WHERE id = OLD.epoch_id;
  ELSE
    SELECT status INTO epoch_status FROM epochs WHERE id = NEW.epoch_id;
  END IF;

  IF epoch_status = 'finalized' THEN
    RAISE EXCEPTION 'Cannot % epoch_selection: epoch % is finalized', TG_OP, COALESCE(NEW.epoch_id::text, OLD.epoch_id::text);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER selection_freeze_on_finalize
  BEFORE INSERT OR UPDATE OR DELETE ON "epoch_selection"
  FOR EACH ROW EXECUTE FUNCTION selection_freeze_on_finalize();--> statement-breakpoint

CREATE OR REPLACE FUNCTION evaluation_locked_reject_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'Cannot % locked evaluation row on epoch_evaluations (id=%)', TG_OP, OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER epoch_evaluations_locked_immutable
  BEFORE UPDATE OR DELETE ON "epoch_evaluations"
  FOR EACH ROW EXECUTE FUNCTION evaluation_locked_reject_mutation();
