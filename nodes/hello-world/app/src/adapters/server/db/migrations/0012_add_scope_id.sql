-- Migration: Add scope_id to ledger tables and rename source_cursors.scope → source_ref
-- scope_id is a stable opaque UUID that scopes all ledger data within a node.
-- source_ref replaces the old "scope" column — identifies the partition within a source
-- (e.g., "org/repo" for GitHub). "scope" is now reserved for governance/payout scoping.

-- 1. Add scope_id to epochs (default for backfill, then drop default)
ALTER TABLE "epochs" ADD COLUMN "scope_id" uuid NOT NULL DEFAULT 'a28a8b1e-1f9d-5cd5-9329-569e4819feda';
--> statement-breakpoint
ALTER TABLE "epochs" ALTER COLUMN "scope_id" DROP DEFAULT;
--> statement-breakpoint

-- 2. Drop and recreate unique indexes on epochs to include scope_id
DROP INDEX IF EXISTS "epochs_window_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "epochs_one_open_per_node";
--> statement-breakpoint
CREATE UNIQUE INDEX "epochs_window_unique" ON "epochs" USING btree ("node_id","scope_id","period_start","period_end");
--> statement-breakpoint
CREATE UNIQUE INDEX "epochs_one_open_per_node" ON "epochs" USING btree ("node_id","scope_id","status") WHERE "epochs"."status" = 'open';
--> statement-breakpoint

-- 3. Add scope_id to activity_events
ALTER TABLE "activity_events" ADD COLUMN "scope_id" uuid NOT NULL DEFAULT 'a28a8b1e-1f9d-5cd5-9329-569e4819feda';
--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "scope_id" DROP DEFAULT;
--> statement-breakpoint

-- 4. Drop and recreate activity_events index to include scope_id
DROP INDEX IF EXISTS "activity_events_node_time_idx";
--> statement-breakpoint
CREATE INDEX "activity_events_node_time_idx" ON "activity_events" USING btree ("node_id","scope_id","event_time");
--> statement-breakpoint

-- 5. Update source_cursors: rename scope → source_ref, add scope_id, update PK
-- Drop the existing PK first
ALTER TABLE "source_cursors" DROP CONSTRAINT "source_cursors_node_id_source_stream_scope_pk";
--> statement-breakpoint
-- Rename scope → source_ref (reserve "scope" for governance/payout domain)
ALTER TABLE "source_cursors" RENAME COLUMN "scope" TO "source_ref";
--> statement-breakpoint
-- Add scope_id column
ALTER TABLE "source_cursors" ADD COLUMN "scope_id" uuid NOT NULL DEFAULT 'a28a8b1e-1f9d-5cd5-9329-569e4819feda';
--> statement-breakpoint
ALTER TABLE "source_cursors" ALTER COLUMN "scope_id" DROP DEFAULT;
--> statement-breakpoint
-- Recreate PK with scope_id and source_ref
ALTER TABLE "source_cursors" ADD CONSTRAINT "source_cursors_node_id_scope_id_source_stream_source_ref_pk" PRIMARY KEY("node_id","scope_id","source","stream","source_ref");
