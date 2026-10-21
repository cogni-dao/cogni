CREATE TABLE "akash_preview_admissions" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"wallet_scope" text NOT NULL,
	"node_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"request_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"source_sha" text NOT NULL,
	"artifact_ref" text NOT NULL,
	"bundle_ref" text NOT NULL,
	"state_slot" integer NOT NULL,
	"reset_generation" uuid,
	"resolved_sdl_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"closure_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "akash_preview_admissions_slot_check" CHECK ("akash_preview_admissions"."state_slot" in (0, 1)),
	CONSTRAINT "akash_preview_admissions_wallet_check" CHECK ("akash_preview_admissions"."wallet_scope" ~ '^akash-console:akash1[0-9a-z]{38}$'),
	CONSTRAINT "akash_preview_admissions_sha_check" CHECK ("akash_preview_admissions"."source_sha" ~ '^[0-9a-f]{40}$' and "akash_preview_admissions"."payload_hash" ~ '^[0-9a-f]{64}$' and ("akash_preview_admissions"."resolved_sdl_hash" is null or "akash_preview_admissions"."resolved_sdl_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "akash_preview_admissions_artifact_check" CHECK ("akash_preview_admissions"."artifact_ref" ~ '@sha256:[0-9a-f]{64}$' and "akash_preview_admissions"."bundle_ref" ~ '@sha256:[0-9a-f]{64}$'),
	CONSTRAINT "akash_preview_admissions_finite_lifetime" CHECK ("akash_preview_admissions"."expires_at" > "akash_preview_admissions"."created_at" and "akash_preview_admissions"."expires_at" <= "akash_preview_admissions"."created_at" + interval '2 hours')
);
--> statement-breakpoint
ALTER TABLE "akash_tx_allocations" ADD COLUMN "preview_deployment_id" uuid;--> statement-breakpoint
ALTER TABLE "akash_tx_allocations" ADD COLUMN "preview_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "akash_tx_allocations" ADD COLUMN "preview_dispatch_finished_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "akash_preview_admissions_request_idx" ON "akash_preview_admissions" USING btree ("wallet_scope","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "akash_preview_admissions_live_slot_idx" ON "akash_preview_admissions" USING btree ("wallet_scope","state_slot") WHERE "akash_preview_admissions"."closure_observed_at" is null;--> statement-breakpoint
ALTER TABLE "akash_tx_allocations" ADD CONSTRAINT "akash_tx_allocations_preview_deployment_id_akash_preview_admissions_deployment_id_fk" FOREIGN KEY ("preview_deployment_id") REFERENCES "public"."akash_preview_admissions"("deployment_id") ON DELETE no action ON UPDATE no action;