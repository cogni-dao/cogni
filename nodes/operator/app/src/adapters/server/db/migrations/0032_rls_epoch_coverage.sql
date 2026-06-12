-- Migration: Close the RLS coverage gap on the epoch ledger tables.
-- Hand-written (not Drizzle-generated) — RLS is outside Drizzle's DDL scope.
--
-- Root cause: 0010_shallow_paibok.sql created activity_curation + epoch_allocations
-- (direct user_id -> users.id FK) with NO row-level security, rationalized as
-- "the worker uses the service-role connection". 0017_breezy_tempest.sql renamed
-- them to epoch_selection / epoch_user_projections, carrying the gap forward.
-- All real access is via the BYPASSRLS service role (DrizzleAttributionAdapter,
-- container.ts), so the leak was never exercised — but any app_user query would
-- read across tenants.
--
-- Fix: ENABLE + FORCE with NO policy = deny-all for app_user (fail-closed). These
-- tables are computed and read exclusively by the service-role attribution worker;
-- there is no app-role read path today. If one is ever added, add an owner-scoped
-- policy at that time (see docs/spec/database-rls.md, RLS_COVERAGE invariant).

ALTER TABLE "epoch_selection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "epoch_selection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "epoch_user_projections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "epoch_user_projections" FORCE ROW LEVEL SECURITY;
