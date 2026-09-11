CREATE TABLE "compute_cost_intervals" (
	"attempt_key" text PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"workload_uid" text NOT NULL,
	"workload_generation" integer NOT NULL,
	"source_sha" text NOT NULL,
	"resource_shape" jsonb NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"compute_provider" text,
	"resource_id" text,
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
	"prepared_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_cost_intervals_state_check" CHECK ("compute_cost_intervals"."state" IN ('prepared','allocated','active','closed')),
	CONSTRAINT "compute_cost_intervals_generation_check" CHECK ("compute_cost_intervals"."workload_generation" > 0),
	CONSTRAINT "compute_cost_intervals_binding_check" CHECK ((
        "compute_cost_intervals"."state" = 'prepared'
        AND "compute_cost_intervals"."compute_provider" IS NULL
        AND "compute_cost_intervals"."resource_id" IS NULL
        AND "compute_cost_intervals"."compute_provider_account_id" IS NULL
        AND "compute_cost_intervals"."compute_supplier_account_id" IS NULL
        AND "compute_cost_intervals"."rate_amount" IS NULL
        AND "compute_cost_intervals"."rate_denom" IS NULL
        AND "compute_cost_intervals"."rate_unit" IS NULL
        AND "compute_cost_intervals"."provider_opened_at_position" IS NULL
        AND "compute_cost_intervals"."provider_closed_at_position" IS NULL
        AND "compute_cost_intervals"."escrow_state" IS NULL
        AND "compute_cost_intervals"."provider_settled_at_position" IS NULL
        AND "compute_cost_intervals"."first_observed_at" IS NULL
        AND "compute_cost_intervals"."last_observed_at" IS NULL
        AND "compute_cost_intervals"."closed_recorded_at" IS NULL
      ) OR (
        "compute_cost_intervals"."state" = 'allocated'
        AND "compute_cost_intervals"."compute_provider" IS NOT NULL
        AND "compute_cost_intervals"."resource_id" IS NOT NULL
        AND "compute_cost_intervals"."compute_provider_account_id" IS NULL
        AND "compute_cost_intervals"."compute_supplier_account_id" IS NULL
        AND "compute_cost_intervals"."rate_amount" IS NULL
        AND "compute_cost_intervals"."rate_denom" IS NULL
        AND "compute_cost_intervals"."rate_unit" IS NULL
        AND "compute_cost_intervals"."provider_opened_at_position" IS NULL
        AND "compute_cost_intervals"."provider_closed_at_position" IS NULL
        AND "compute_cost_intervals"."escrow_state" IS NULL
        AND "compute_cost_intervals"."provider_settled_at_position" IS NULL
        AND "compute_cost_intervals"."first_observed_at" IS NULL
        AND "compute_cost_intervals"."last_observed_at" IS NULL
        AND "compute_cost_intervals"."closed_recorded_at" IS NULL
      ) OR (
        "compute_cost_intervals"."state" IN ('active','closed')
        AND "compute_cost_intervals"."compute_provider" IS NOT NULL
        AND "compute_cost_intervals"."resource_id" IS NOT NULL
        AND "compute_cost_intervals"."compute_provider_account_id" IS NOT NULL
        AND "compute_cost_intervals"."compute_supplier_account_id" IS NOT NULL
        AND "compute_cost_intervals"."rate_amount" IS NOT NULL
        AND "compute_cost_intervals"."rate_denom" IS NOT NULL
        AND "compute_cost_intervals"."rate_unit" IS NOT NULL
        AND "compute_cost_intervals"."first_observed_at" IS NOT NULL
        AND "compute_cost_intervals"."last_observed_at" IS NOT NULL
        AND (
          ("compute_cost_intervals"."state" = 'active' AND "compute_cost_intervals"."provider_closed_at_position" IS NULL AND "compute_cost_intervals"."closed_recorded_at" IS NULL)
          OR ("compute_cost_intervals"."state" = 'closed' AND "compute_cost_intervals"."closed_recorded_at" IS NOT NULL)
        )
      ) OR (
        "compute_cost_intervals"."state" = 'closed'
        AND "compute_cost_intervals"."compute_provider" IS NOT NULL
        AND "compute_cost_intervals"."resource_id" IS NOT NULL
        AND "compute_cost_intervals"."compute_provider_account_id" IS NULL
        AND "compute_cost_intervals"."compute_supplier_account_id" IS NULL
        AND "compute_cost_intervals"."rate_amount" IS NULL
        AND "compute_cost_intervals"."rate_denom" IS NULL
        AND "compute_cost_intervals"."rate_unit" IS NULL
        AND "compute_cost_intervals"."provider_opened_at_position" IS NULL
        AND "compute_cost_intervals"."provider_closed_at_position" IS NULL
        AND "compute_cost_intervals"."escrow_state" IS NULL
        AND "compute_cost_intervals"."provider_settled_at_position" IS NULL
        AND "compute_cost_intervals"."first_observed_at" IS NULL
        AND "compute_cost_intervals"."last_observed_at" IS NULL
        AND "compute_cost_intervals"."closed_recorded_at" IS NOT NULL
      )),
	CONSTRAINT "compute_cost_intervals_rate_amount_check" CHECK ("compute_cost_intervals"."rate_amount" IS NULL OR "compute_cost_intervals"."rate_amount" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'),
	CONSTRAINT "compute_cost_intervals_provider_positions_check" CHECK (("compute_cost_intervals"."provider_opened_at_position" IS NULL OR "compute_cost_intervals"."provider_opened_at_position" ~ '^(0|[1-9][0-9]*)$')
        AND ("compute_cost_intervals"."provider_closed_at_position" IS NULL OR "compute_cost_intervals"."provider_closed_at_position" ~ '^(0|[1-9][0-9]*)$')
        AND ("compute_cost_intervals"."provider_settled_at_position" IS NULL OR "compute_cost_intervals"."provider_settled_at_position" ~ '^(0|[1-9][0-9]*)$')
        AND ("compute_cost_intervals"."provider_settled_at_position" IS NULL OR "compute_cost_intervals"."escrow_state" IS NOT NULL)
        AND ("compute_cost_intervals"."provider_opened_at_position" IS NULL OR "compute_cost_intervals"."provider_closed_at_position" IS NULL OR "compute_cost_intervals"."provider_closed_at_position"::numeric >= "compute_cost_intervals"."provider_opened_at_position"::numeric))
);
--> statement-breakpoint
ALTER TABLE "compute_cost_intervals" ADD CONSTRAINT "compute_cost_intervals_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compute_cost_intervals_resource_key" ON "compute_cost_intervals" USING btree ("compute_provider","resource_id");--> statement-breakpoint
CREATE INDEX "compute_cost_intervals_node_state_idx" ON "compute_cost_intervals" USING btree ("node_id","state");--> statement-breakpoint
CREATE INDEX "compute_cost_intervals_workload_idx" ON "compute_cost_intervals" USING btree ("workload_uid","workload_generation");