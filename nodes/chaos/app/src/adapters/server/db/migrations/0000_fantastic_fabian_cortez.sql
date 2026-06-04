CREATE TABLE "ai_invocation_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invocation_id" text NOT NULL,
	"request_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"langfuse_trace_id" text,
	"litellm_call_id" text,
	"prompt_hash" text NOT NULL,
	"router_policy_version" text NOT NULL,
	"graph_run_id" text,
	"graph_name" text,
	"graph_version" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"tokens_total" integer,
	"provider_cost_usd" numeric,
	"latency_ms" integer NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_invocation_summaries_invocation_id_unique" UNIQUE("invocation_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"email_verified" timestamp with time zone,
	"image" text,
	"wallet_address" text,
	CONSTRAINT "users_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "billing_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"balance_credits" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_owner_user_id_unique" UNIQUE("owner_user_id")
);
--> statement-breakpoint
CREATE TABLE "charge_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" text NOT NULL,
	"virtual_key_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"ingress_request_id" text,
	"litellm_call_id" text,
	"charged_credits" bigint NOT NULL,
	"response_cost_usd" numeric,
	"provenance" text NOT NULL,
	"charge_reason" text NOT NULL,
	"source_system" text NOT NULL,
	"source_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" text NOT NULL,
	"virtual_key_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"metadata" jsonb DEFAULT 'null'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" text NOT NULL,
	"from_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text,
	"token" text NOT NULL,
	"to_address" text NOT NULL,
	"amount_raw" bigint NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"expires_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"last_verify_attempt_at" timestamp with time zone,
	"verify_attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"error_code" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "virtual_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" text NOT NULL,
	"label" text DEFAULT 'Default',
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_receipts" ADD CONSTRAINT "charge_receipts_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_receipts" ADD CONSTRAINT "charge_receipts_virtual_key_id_virtual_keys_id_fk" FOREIGN KEY ("virtual_key_id") REFERENCES "public"."virtual_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_virtual_key_id_virtual_keys_id_fk" FOREIGN KEY ("virtual_key_id") REFERENCES "public"."virtual_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_invocation_summaries_request_id_idx" ON "ai_invocation_summaries" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "ai_invocation_summaries_trace_id_idx" ON "ai_invocation_summaries" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "ai_invocation_summaries_litellm_call_id_idx" ON "ai_invocation_summaries" USING btree ("litellm_call_id");--> statement-breakpoint
CREATE INDEX "ai_invocation_summaries_prompt_hash_idx" ON "ai_invocation_summaries" USING btree ("prompt_hash");--> statement-breakpoint
CREATE INDEX "ai_invocation_summaries_created_at_idx" ON "ai_invocation_summaries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_invocation_summaries_status_idx" ON "ai_invocation_summaries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "charge_receipts_billing_account_idx" ON "charge_receipts" USING btree ("billing_account_id");--> statement-breakpoint
CREATE INDEX "charge_receipts_virtual_key_idx" ON "charge_receipts" USING btree ("virtual_key_id");--> statement-breakpoint
CREATE INDEX "charge_receipts_aggregation_idx" ON "charge_receipts" USING btree ("billing_account_id","created_at");--> statement-breakpoint
CREATE INDEX "charge_receipts_pagination_idx" ON "charge_receipts" USING btree ("billing_account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "charge_receipts_ingress_request_idx" ON "charge_receipts" USING btree ("ingress_request_id");--> statement-breakpoint
CREATE INDEX "charge_receipts_run_attempt_idx" ON "charge_receipts" USING btree ("run_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "charge_receipts_source_idempotency_unique" ON "charge_receipts" USING btree ("source_system","source_reference");--> statement-breakpoint
CREATE INDEX "credit_ledger_reference_reason_idx" ON "credit_ledger" USING btree ("reference","reason");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_payment_ref_unique" ON "credit_ledger" USING btree ("reference") WHERE "credit_ledger"."reason" = 'widget_payment';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_charge_receipt_ref_unique" ON "credit_ledger" USING btree ("reference") WHERE "credit_ledger"."reason" = 'charge_receipt';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_chain_tx_unique" ON "payment_attempts" USING btree ("chain_id","tx_hash") WHERE "payment_attempts"."tx_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_attempts_billing_account_idx" ON "payment_attempts" USING btree ("billing_account_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payment_events_attempt_idx" ON "payment_events" USING btree ("attempt_id","created_at");