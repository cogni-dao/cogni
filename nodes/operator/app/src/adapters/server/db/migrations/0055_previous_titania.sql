CREATE TABLE "actor_contribution_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"receipt_id" text NOT NULL,
	"contract_version" text NOT NULL,
	"earned_by_actor_id" text NOT NULL,
	"beneficiary_actor_id" text NOT NULL,
	"beneficiary_policy_id" text NOT NULL,
	"beneficiary_policy_version" text NOT NULL,
	"contribution_cutoff" timestamp with time zone NOT NULL,
	"source_evidence" jsonb NOT NULL,
	"source_evidence_hash" text NOT NULL,
	"signer_actor_id" text NOT NULL,
	"signer_wallet" text NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_contribution_allocations_contract_check" CHECK ("actor_contribution_allocations"."contract_version" = 'actor.contribution.allocation.v1')
);
--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
CREATE TABLE "actor_beneficiary_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"earned_by_actor_id" text NOT NULL,
	"beneficiary_actor_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"authorized_by_actor_id" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_beneficiary_policies_window_check" CHECK ("actor_beneficiary_policies"."effective_to" IS NULL OR "actor_beneficiary_policies"."effective_to" > "actor_beneficiary_policies"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actor_beneficiary_policy_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"role" text NOT NULL,
	"accepted_by_actor_id" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_beneficiary_policy_acceptances_role_check" CHECK ("actor_beneficiary_policy_acceptances"."role" IN ('earner', 'steward', 'governance'))
);
--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actor_beneficiary_policy_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"earned_by_actor_id" text NOT NULL,
	"beneficiary_actor_id" text NOT NULL,
	"steward_actor_id" text NOT NULL,
	"proposed_by_actor_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"activated_policy_id" text,
	"revoked_by_actor_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_beneficiary_policy_proposals_status_check" CHECK ("actor_beneficiary_policy_proposals"."status" IN ('pending', 'activated', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actor_binding_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"previous_actor_id" text,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"provider_login" text,
	"event_type" text NOT NULL,
	"authorized_by_actor_id" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_binding_events_type_check" CHECK ("actor_binding_events"."event_type" IN ('bound', 'transferred_out', 'transferred_in', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "actor_binding_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "actor_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"provider_login" text,
	"evidence_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "actor_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ADD CONSTRAINT "actor_contribution_allocations_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ADD CONSTRAINT "actor_contribution_allocations_earned_by_actor_id_actors_id_fk" FOREIGN KEY ("earned_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ADD CONSTRAINT "actor_contribution_allocations_beneficiary_actor_id_actors_id_fk" FOREIGN KEY ("beneficiary_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ADD CONSTRAINT "actor_contribution_allocations_beneficiary_policy_id_actor_beneficiary_policies_id_fk" FOREIGN KEY ("beneficiary_policy_id") REFERENCES "public"."actor_beneficiary_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_contribution_allocations" ADD CONSTRAINT "actor_contribution_allocations_signer_actor_id_actors_id_fk" FOREIGN KEY ("signer_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "actor_beneficiary_policies" ADD CONSTRAINT "actor_beneficiary_policies_earned_by_actor_id_actors_id_fk" FOREIGN KEY ("earned_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policies" ADD CONSTRAINT "actor_beneficiary_policies_beneficiary_actor_id_actors_id_fk" FOREIGN KEY ("beneficiary_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policies" ADD CONSTRAINT "actor_beneficiary_policies_authorized_by_actor_id_actors_id_fk" FOREIGN KEY ("authorized_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_acceptances" ADD CONSTRAINT "actor_beneficiary_policy_acceptances_proposal_id_actor_beneficiary_policy_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."actor_beneficiary_policy_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_acceptances" ADD CONSTRAINT "actor_beneficiary_policy_acceptances_accepted_by_actor_id_actors_id_fk" FOREIGN KEY ("accepted_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_proposals" ADD CONSTRAINT "actor_beneficiary_policy_proposals_earned_by_actor_id_actors_id_fk" FOREIGN KEY ("earned_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_proposals" ADD CONSTRAINT "actor_beneficiary_policy_proposals_beneficiary_actor_id_actors_id_fk" FOREIGN KEY ("beneficiary_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_proposals" ADD CONSTRAINT "actor_beneficiary_policy_proposals_steward_actor_id_actors_id_fk" FOREIGN KEY ("steward_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_proposals" ADD CONSTRAINT "actor_beneficiary_policy_proposals_proposed_by_actor_id_actors_id_fk" FOREIGN KEY ("proposed_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_proposals" ADD CONSTRAINT "actor_beneficiary_policy_proposals_activated_policy_id_actor_beneficiary_policies_id_fk" FOREIGN KEY ("activated_policy_id") REFERENCES "public"."actor_beneficiary_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_beneficiary_policy_proposals" ADD CONSTRAINT "actor_beneficiary_policy_proposals_revoked_by_actor_id_actors_id_fk" FOREIGN KEY ("revoked_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_binding_events" ADD CONSTRAINT "actor_binding_events_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_binding_events" ADD CONSTRAINT "actor_binding_events_previous_actor_id_actors_id_fk" FOREIGN KEY ("previous_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_binding_events" ADD CONSTRAINT "actor_binding_events_authorized_by_actor_id_actors_id_fk" FOREIGN KEY ("authorized_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_bindings" ADD CONSTRAINT "actor_bindings_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_bindings" ADD CONSTRAINT "actor_bindings_evidence_event_id_actor_binding_events_id_fk" FOREIGN KEY ("evidence_event_id") REFERENCES "public"."actor_binding_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actor_contribution_allocations_receipt_version_unique" ON "actor_contribution_allocations" USING btree ("node_id","epoch_id","receipt_id","contract_version");--> statement-breakpoint
CREATE INDEX "actor_contribution_allocations_beneficiary_idx" ON "actor_contribution_allocations" USING btree ("beneficiary_actor_id","epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_distribution_liabilities_allocation_unique" ON "actor_distribution_liabilities" USING btree ("allocation_ref");--> statement-breakpoint
CREATE INDEX "actor_distribution_liabilities_beneficiary_idx" ON "actor_distribution_liabilities" USING btree ("beneficiary_actor_id","source_epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_distribution_settlements_allocation_unique" ON "actor_distribution_settlements" USING btree ("allocation_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_distribution_settlements_liability_unique" ON "actor_distribution_settlements" USING btree ("liability_id") WHERE "actor_distribution_settlements"."liability_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "actor_distribution_settlements_fold_idx" ON "actor_distribution_settlements" USING btree ("fold_epoch_id");--> statement-breakpoint
CREATE INDEX "actor_distribution_settlements_wallet_idx" ON "actor_distribution_settlements" USING btree ("claimant_wallet_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_beneficiary_policies_version_unique" ON "actor_beneficiary_policies" USING btree ("earned_by_actor_id","policy_version");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_beneficiary_policies_effective_from_unique" ON "actor_beneficiary_policies" USING btree ("earned_by_actor_id","effective_from");--> statement-breakpoint
CREATE INDEX "actor_beneficiary_policies_effective_idx" ON "actor_beneficiary_policies" USING btree ("earned_by_actor_id","effective_from","effective_to");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_beneficiary_policy_acceptances_role_unique" ON "actor_beneficiary_policy_acceptances" USING btree ("proposal_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_beneficiary_policy_proposals_version_unique" ON "actor_beneficiary_policy_proposals" USING btree ("earned_by_actor_id","policy_version");--> statement-breakpoint
CREATE INDEX "actor_beneficiary_policy_proposals_earner_idx" ON "actor_beneficiary_policy_proposals" USING btree ("earned_by_actor_id","status");--> statement-breakpoint
CREATE INDEX "actor_binding_events_source_idx" ON "actor_binding_events" USING btree ("provider","external_id","effective_at");--> statement-breakpoint
CREATE INDEX "actor_binding_events_actor_id_idx" ON "actor_binding_events" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_bindings_active_source_unique" ON "actor_bindings" USING btree ("provider","external_id") WHERE "actor_bindings"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "actor_bindings_actor_id_idx" ON "actor_bindings" USING btree ("actor_id");