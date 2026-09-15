-- PR #2197 was never merged, but its rejected controller-era migration reached
-- candidate-a. Only that exact obsolete shape may be removed. Any other table is
-- deliberately left untouched so the following CREATE fails safely for review.
DO $$
DECLARE
	actual_columns text[];
	expected_columns text[];
	actual_constraints text[];
	expected_constraints text[];
	actual_indexes text[];
	expected_indexes text[];
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
		SELECT array_agg(column_name ORDER BY column_name)
		INTO actual_columns
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'compute_cost_intervals';

		SELECT array_agg(column_name ORDER BY column_name)
		INTO expected_columns
		FROM unnest(ARRAY[
			'attempt_key', 'node_id', 'environment', 'workload_uid',
			'workload_generation', 'source_sha', 'resource_shape', 'state',
			'compute_provider', 'resource_id', 'compute_provider_account_id',
			'compute_supplier_account_id', 'rate_amount', 'rate_denom', 'rate_unit',
			'provider_opened_at_position', 'provider_closed_at_position', 'escrow_state',
			'provider_settled_at_position', 'escrow_funds', 'cumulative_transferred',
			'first_observed_at', 'last_observed_at', 'closed_recorded_at', 'prepared_at',
			'created_at', 'updated_at'
		]::text[]) AS legacy_columns(column_name);

		SELECT array_agg(conname ORDER BY conname)
		INTO actual_constraints
		FROM pg_constraint
		WHERE conrelid = 'public.compute_cost_intervals'::regclass;

		SELECT array_agg(constraint_name ORDER BY constraint_name)
		INTO expected_constraints
		FROM unnest(ARRAY[
			'compute_cost_intervals_binding_check',
			'compute_cost_intervals_generation_check',
			'compute_cost_intervals_pkey',
			'compute_cost_intervals_provider_positions_check',
			'compute_cost_intervals_rate_amount_check',
			'compute_cost_intervals_state_check'
		]::text[]) AS legacy_constraints(constraint_name);

		SELECT array_agg(indexname ORDER BY indexname)
		INTO actual_indexes
		FROM pg_indexes
		WHERE schemaname = 'public'
			AND tablename = 'compute_cost_intervals';

		SELECT array_agg(index_name ORDER BY index_name)
		INTO expected_indexes
		FROM unnest(ARRAY[
			'compute_cost_intervals_node_state_idx',
			'compute_cost_intervals_pkey',
			'compute_cost_intervals_resource_key',
			'compute_cost_intervals_workload_idx'
		]::text[]) AS legacy_indexes(index_name);

		IF actual_columns IS DISTINCT FROM expected_columns
			OR actual_constraints IS DISTINCT FROM expected_constraints
			OR actual_indexes IS DISTINCT FROM expected_indexes
		THEN
			RAISE EXCEPTION 'refusing to replace unrecognized public.compute_cost_intervals schema';
		END IF;

		DROP TABLE public.compute_cost_intervals;
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "compute_cost_intervals" (
	"allocation_receipt_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'allocated' NOT NULL,
	"compute_provider" text NOT NULL,
	"resource_id" text NOT NULL,
	"provider_consumer_account_id" text NOT NULL,
	"provider_supplier_account_id" text,
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
        AND "compute_cost_intervals"."provider_supplier_account_id" IS NULL
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
        AND "compute_cost_intervals"."provider_supplier_account_id" IS NOT NULL
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
            "compute_cost_intervals"."provider_supplier_account_id" IS NULL
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
            "compute_cost_intervals"."provider_supplier_account_id" IS NOT NULL
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
CREATE UNIQUE INDEX "compute_cost_intervals_resource_idx" ON "compute_cost_intervals" USING btree ("compute_provider","provider_consumer_account_id","resource_id");
