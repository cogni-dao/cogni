-- candidate-a briefly ran the unmerged #2197 controller-era table. Its two rows describe
-- already-closed leases from the retired wallet and have no authoritative actuator receipt.
-- Converge that known drift by deleting only the obsolete shape; never touch the new
-- receipt-keyed shape and never modify akash_tx_allocations.
DO $$
BEGIN
	IF to_regclass('public.compute_cost_intervals') IS NOT NULL
		AND NOT EXISTS (
			SELECT 1
			FROM information_schema.columns
			WHERE table_schema = 'public'
				AND table_name = 'compute_cost_intervals'
				AND column_name = 'allocation_receipt_id'
		)
	THEN
		DROP TABLE public.compute_cost_intervals;
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "compute_cost_intervals" (
	"allocation_receipt_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'allocated' NOT NULL,
	"compute_provider" text NOT NULL,
	"resource_id" text NOT NULL,
	"compute_provider_account_id" text,
	"compute_supplier_account_id" text,
	"rate_amount" text,
	"rate_denom" text,
	"rate_unit" text,
	"provider_opened_at_position" text,
	"provider_closed_at_position" text,
	"escrow_state" text,
	"provider_settled_at_position" text,
	"escrow_funds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cumulative_transferred" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_observed_at" timestamp with time zone,
	"last_observed_at" timestamp with time zone,
	"closed_recorded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_cost_intervals_state_check" CHECK ("compute_cost_intervals"."state" IN ('allocated','active','closed')),
	CONSTRAINT "compute_cost_intervals_evidence_check" CHECK ((
        "compute_cost_intervals"."state" = 'allocated'
        AND "compute_cost_intervals"."closed_recorded_at" IS NULL
        AND "compute_cost_intervals"."compute_provider_account_id" IS NULL
        AND "compute_cost_intervals"."compute_supplier_account_id" IS NULL
        AND "compute_cost_intervals"."rate_amount" IS NULL
        AND "compute_cost_intervals"."rate_denom" IS NULL
        AND "compute_cost_intervals"."rate_unit" IS NULL
        AND "compute_cost_intervals"."provider_opened_at_position" IS NULL
        AND "compute_cost_intervals"."provider_closed_at_position" IS NULL
        AND "compute_cost_intervals"."escrow_state" IS NULL
        AND "compute_cost_intervals"."provider_settled_at_position" IS NULL
        AND "compute_cost_intervals"."escrow_funds" = '[]'::jsonb
        AND "compute_cost_intervals"."cumulative_transferred" = '[]'::jsonb
        AND "compute_cost_intervals"."first_observed_at" IS NULL
        AND "compute_cost_intervals"."last_observed_at" IS NULL
      ) OR (
        "compute_cost_intervals"."state" = 'active'
        AND "compute_cost_intervals"."provider_closed_at_position" IS NULL
        AND "compute_cost_intervals"."closed_recorded_at" IS NULL
        AND "compute_cost_intervals"."compute_provider_account_id" IS NOT NULL
        AND "compute_cost_intervals"."compute_supplier_account_id" IS NOT NULL
        AND "compute_cost_intervals"."rate_amount" IS NOT NULL
        AND "compute_cost_intervals"."rate_denom" IS NOT NULL
        AND "compute_cost_intervals"."rate_unit" IS NOT NULL
        AND "compute_cost_intervals"."escrow_state" IS NOT NULL
        AND "compute_cost_intervals"."first_observed_at" IS NOT NULL
        AND "compute_cost_intervals"."last_observed_at" IS NOT NULL
      ) OR (
        "compute_cost_intervals"."state" = 'closed'
        AND "compute_cost_intervals"."closed_recorded_at" IS NOT NULL
        AND (
          (
            "compute_cost_intervals"."compute_provider_account_id" IS NULL
            AND "compute_cost_intervals"."compute_supplier_account_id" IS NULL
            AND "compute_cost_intervals"."rate_amount" IS NULL
            AND "compute_cost_intervals"."rate_denom" IS NULL
            AND "compute_cost_intervals"."rate_unit" IS NULL
            AND "compute_cost_intervals"."provider_opened_at_position" IS NULL
            AND "compute_cost_intervals"."provider_closed_at_position" IS NULL
            AND "compute_cost_intervals"."escrow_state" IS NULL
            AND "compute_cost_intervals"."provider_settled_at_position" IS NULL
            AND "compute_cost_intervals"."escrow_funds" = '[]'::jsonb
            AND "compute_cost_intervals"."cumulative_transferred" = '[]'::jsonb
            AND "compute_cost_intervals"."first_observed_at" IS NULL
            AND "compute_cost_intervals"."last_observed_at" IS NULL
          ) OR (
            "compute_cost_intervals"."compute_provider_account_id" IS NOT NULL
            AND "compute_cost_intervals"."compute_supplier_account_id" IS NOT NULL
            AND "compute_cost_intervals"."rate_amount" IS NOT NULL
            AND "compute_cost_intervals"."rate_denom" IS NOT NULL
            AND "compute_cost_intervals"."rate_unit" IS NOT NULL
            AND "compute_cost_intervals"."escrow_state" IS NOT NULL
            AND "compute_cost_intervals"."first_observed_at" IS NOT NULL
            AND "compute_cost_intervals"."last_observed_at" IS NOT NULL
          )
        )
      )),
	CONSTRAINT "compute_cost_intervals_rate_amount_check" CHECK ("compute_cost_intervals"."rate_amount" IS NULL OR "compute_cost_intervals"."rate_amount" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'),
	CONSTRAINT "compute_cost_intervals_provider_positions_check" CHECK (("compute_cost_intervals"."provider_opened_at_position" IS NULL OR "compute_cost_intervals"."provider_opened_at_position" ~ '^(0|[1-9][0-9]*)$')
        AND ("compute_cost_intervals"."provider_closed_at_position" IS NULL OR "compute_cost_intervals"."provider_closed_at_position" ~ '^(0|[1-9][0-9]*)$')
        AND ("compute_cost_intervals"."provider_settled_at_position" IS NULL OR "compute_cost_intervals"."provider_settled_at_position" ~ '^(0|[1-9][0-9]*)$')
        AND ("compute_cost_intervals"."provider_opened_at_position" IS NULL OR "compute_cost_intervals"."provider_closed_at_position" IS NULL OR "compute_cost_intervals"."provider_closed_at_position"::numeric >= "compute_cost_intervals"."provider_opened_at_position"::numeric))
);
--> statement-breakpoint
ALTER TABLE "compute_cost_intervals" ADD CONSTRAINT "compute_cost_intervals_allocation_receipt_id_akash_tx_allocations_id_fk" FOREIGN KEY ("allocation_receipt_id") REFERENCES "public"."akash_tx_allocations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "compute_cost_intervals_resource_idx" ON "compute_cost_intervals" USING btree ("compute_provider","resource_id");
