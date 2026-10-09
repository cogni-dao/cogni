CREATE TABLE "actor_distribution_liabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_ref" text NOT NULL,
	"node_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"source_epoch_id" bigint NOT NULL,
	"earned_by_actor_id" text NOT NULL,
	"beneficiary_actor_id" text NOT NULL,
	"contribution_cutoff" timestamp with time zone NOT NULL,
	"token_amount" numeric NOT NULL,
	"source_evidence_hash" text NOT NULL,
	"signer_actor_id" text NOT NULL,
	"resolver_failure_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_distribution_liabilities_amount_positive" CHECK ("actor_distribution_liabilities"."token_amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "actor_distribution_liabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_distribution_liabilities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actor_distribution_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_ref" text NOT NULL,
	"liability_id" uuid,
	"node_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"source_epoch_id" bigint NOT NULL,
	"fold_epoch_id" bigint NOT NULL,
	"earned_by_actor_id" text NOT NULL,
	"beneficiary_actor_id" text NOT NULL,
	"token_amount" numeric NOT NULL,
	"claimant_wallet" text NOT NULL,
	"claimant_wallet_lower" text NOT NULL,
	"resolver_evidence_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_distribution_settlements_amount_positive" CHECK ("actor_distribution_settlements"."token_amount" > 0),
	CONSTRAINT "actor_distribution_settlements_wallet_lower_check" CHECK ("actor_distribution_settlements"."claimant_wallet_lower" = lower("actor_distribution_settlements"."claimant_wallet"))
);
--> statement-breakpoint
ALTER TABLE "actor_distribution_settlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_distribution_settlements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_distribution_liabilities" ADD CONSTRAINT "actor_distribution_liabilities_allocation_ref_actor_contribution_allocations_id_fk" FOREIGN KEY ("allocation_ref") REFERENCES "public"."actor_contribution_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_distribution_liabilities" ADD CONSTRAINT "actor_distribution_liabilities_source_epoch_id_epochs_id_fk" FOREIGN KEY ("source_epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_distribution_liabilities" ADD CONSTRAINT "actor_distribution_liabilities_earned_by_actor_id_actors_id_fk" FOREIGN KEY ("earned_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_distribution_liabilities" ADD CONSTRAINT "actor_distribution_liabilities_beneficiary_actor_id_actors_id_fk" FOREIGN KEY ("beneficiary_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_distribution_liabilities" ADD CONSTRAINT "actor_distribution_liabilities_signer_actor_id_actors_id_fk" FOREIGN KEY ("signer_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_distribution_settlements" ADD CONSTRAINT "actor_distribution_settlements_allocation_ref_actor_contribution_allocations_id_fk" FOREIGN KEY ("allocation_ref") REFERENCES "public"."actor_contribution_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_distribution_settlements" ADD CONSTRAINT "actor_distribution_settlements_liability_id_actor_distribution_liabilities_id_fk" FOREIGN KEY ("liability_id") REFERENCES "public"."actor_distribution_liabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_distribution_settlements" ADD CONSTRAINT "actor_distribution_settlements_source_epoch_id_epochs_id_fk" FOREIGN KEY ("source_epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_distribution_settlements" ADD CONSTRAINT "actor_distribution_settlements_fold_epoch_id_epochs_id_fk" FOREIGN KEY ("fold_epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_distribution_settlements" ADD CONSTRAINT "actor_distribution_settlements_earned_by_actor_id_actors_id_fk" FOREIGN KEY ("earned_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_distribution_settlements" ADD CONSTRAINT "actor_distribution_settlements_beneficiary_actor_id_actors_id_fk" FOREIGN KEY ("beneficiary_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actor_distribution_liabilities_allocation_unique" ON "actor_distribution_liabilities" USING btree ("allocation_ref");--> statement-breakpoint
CREATE INDEX "actor_distribution_liabilities_beneficiary_idx" ON "actor_distribution_liabilities" USING btree ("beneficiary_actor_id","source_epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_distribution_settlements_allocation_unique" ON "actor_distribution_settlements" USING btree ("allocation_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_distribution_settlements_liability_unique" ON "actor_distribution_settlements" USING btree ("liability_id") WHERE "actor_distribution_settlements"."liability_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "actor_distribution_settlements_fold_idx" ON "actor_distribution_settlements" USING btree ("fold_epoch_id");--> statement-breakpoint
CREATE INDEX "actor_distribution_settlements_wallet_idx" ON "actor_distribution_settlements" USING btree ("claimant_wallet_lower");--> statement-breakpoint
CREATE TRIGGER actor_distribution_liabilities_append_only
  BEFORE UPDATE OR DELETE ON "actor_distribution_liabilities"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();--> statement-breakpoint
CREATE TRIGGER actor_distribution_settlements_append_only
  BEFORE UPDATE OR DELETE ON "actor_distribution_settlements"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
