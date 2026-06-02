CREATE TABLE "identity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_events_event_type_check" CHECK ("identity_events"."event_type" IN ('bind', 'revoke', 'merge'))
);
--> statement-breakpoint
CREATE TABLE "user_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_bindings_provider_check" CHECK ("user_bindings"."provider" IN ('wallet', 'discord', 'github'))
);
--> statement-breakpoint
CREATE TABLE "activity_curation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"event_id" text NOT NULL,
	"user_id" text,
	"included" boolean DEFAULT true NOT NULL,
	"weight_override_milli" bigint,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"node_id" uuid NOT NULL,
	"id" text NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"platform_user_id" text NOT NULL,
	"platform_login" text,
	"artifact_url" text,
	"metadata" jsonb,
	"payload_hash" text NOT NULL,
	"producer" text NOT NULL,
	"producer_version" text NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_events_node_id_id_pk" PRIMARY KEY("node_id","id")
);
--> statement-breakpoint
CREATE TABLE "epoch_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	"proposed_units" bigint NOT NULL,
	"final_units" bigint,
	"override_reason" text,
	"activity_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epoch_pool_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"component_id" text NOT NULL,
	"algorithm_version" text NOT NULL,
	"inputs_json" jsonb NOT NULL,
	"amount_credits" bigint NOT NULL,
	"evidence_ref" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epochs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"weight_config" jsonb NOT NULL,
	"pool_total_credits" bigint,
	"approver_set_hash" text,
	"allocation_algo_ref" text,
	"weight_config_hash" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "epochs_status_check" CHECK ("epochs"."status" IN ('open', 'review', 'finalized'))
);
--> statement-breakpoint
CREATE TABLE "payout_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"allocation_set_hash" text NOT NULL,
	"pool_total_credits" bigint NOT NULL,
	"payouts_json" jsonb NOT NULL,
	"supersedes_statement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_cursors" (
	"node_id" uuid NOT NULL,
	"source" text NOT NULL,
	"stream" text NOT NULL,
	"scope" text NOT NULL,
	"cursor_value" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_cursors_node_id_source_stream_scope_pk" PRIMARY KEY("node_id","source","stream","scope")
);
--> statement-breakpoint
CREATE TABLE "statement_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"signer_wallet" text NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity_events" ADD CONSTRAINT "identity_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bindings" ADD CONSTRAINT "user_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_curation" ADD CONSTRAINT "activity_curation_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_curation" ADD CONSTRAINT "activity_curation_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_allocations" ADD CONSTRAINT "epoch_allocations_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_allocations" ADD CONSTRAINT "epoch_allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_pool_components" ADD CONSTRAINT "epoch_pool_components_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_statements" ADD CONSTRAINT "payout_statements_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_statements" ADD CONSTRAINT "payout_statements_supersedes_statement_id_payout_statements_id_fk" FOREIGN KEY ("supersedes_statement_id") REFERENCES "public"."payout_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_signatures" ADD CONSTRAINT "statement_signatures_statement_id_payout_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."payout_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_events_user_id_idx" ON "identity_events" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_bindings_provider_external_id_unique" ON "user_bindings" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "user_bindings_user_id_idx" ON "user_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_curation_epoch_event_unique" ON "activity_curation" USING btree ("epoch_id","event_id");--> statement-breakpoint
CREATE INDEX "activity_curation_epoch_idx" ON "activity_curation" USING btree ("epoch_id");--> statement-breakpoint
CREATE INDEX "activity_events_node_time_idx" ON "activity_events" USING btree ("node_id","event_time");--> statement-breakpoint
CREATE INDEX "activity_events_source_type_idx" ON "activity_events" USING btree ("source","event_type");--> statement-breakpoint
CREATE INDEX "activity_events_platform_user_idx" ON "activity_events" USING btree ("platform_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_allocations_epoch_user_unique" ON "epoch_allocations" USING btree ("epoch_id","user_id");--> statement-breakpoint
CREATE INDEX "epoch_allocations_epoch_idx" ON "epoch_allocations" USING btree ("epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_pool_components_epoch_component_unique" ON "epoch_pool_components" USING btree ("epoch_id","component_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epochs_window_unique" ON "epochs" USING btree ("node_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "epochs_one_open_per_node" ON "epochs" USING btree ("node_id","status") WHERE "epochs"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_statements_node_epoch_unique" ON "payout_statements" USING btree ("node_id","epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_signatures_statement_signer_unique" ON "statement_signatures" USING btree ("statement_id","signer_wallet");