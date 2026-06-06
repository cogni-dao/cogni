-- Migration: Enable Row-Level Security on all user-scoped tables
-- Reference: docs/DATABASE_RLS_SPEC.md
-- Hand-written (not Drizzle-generated) — RLS policies are outside Drizzle's DDL scope.
--
-- Invariant: current_setting('app.current_user_id', true) returns NULL when unset.
-- Since no row has owner_user_id = NULL, unset context returns zero rows (silent deny).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. USERS — self-only isolation
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "self_isolation" ON "users"
  USING ("id" = current_setting('app.current_user_id', true))
  WITH CHECK ("id" = current_setting('app.current_user_id', true));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. BILLING_ACCOUNTS — direct FK (owner_user_id → users.id)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "billing_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "billing_accounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_accounts"
  USING ("owner_user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("owner_user_id" = current_setting('app.current_user_id', true));

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. EXECUTION_GRANTS — direct FK (user_id → users.id)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "execution_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "execution_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "execution_grants"
  USING ("user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true));

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. SCHEDULES — direct FK (owner_user_id → users.id)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "schedules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "schedules"
  USING ("owner_user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("owner_user_id" = current_setting('app.current_user_id', true));

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. VIRTUAL_KEYS — transitive FK (billing_account_id → billing_accounts)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "virtual_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "virtual_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "virtual_keys"
  USING ("billing_account_id" IN (
    SELECT "id" FROM "billing_accounts"
    WHERE "owner_user_id" = current_setting('app.current_user_id', true)
  ))
  WITH CHECK ("billing_account_id" IN (
    SELECT "id" FROM "billing_accounts"
    WHERE "owner_user_id" = current_setting('app.current_user_id', true)
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. CREDIT_LEDGER — transitive FK (billing_account_id → billing_accounts)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "credit_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credit_ledger" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "credit_ledger"
  USING ("billing_account_id" IN (
    SELECT "id" FROM "billing_accounts"
    WHERE "owner_user_id" = current_setting('app.current_user_id', true)
  ))
  WITH CHECK ("billing_account_id" IN (
    SELECT "id" FROM "billing_accounts"
    WHERE "owner_user_id" = current_setting('app.current_user_id', true)
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. CHARGE_RECEIPTS — transitive FK (billing_account_id → billing_accounts)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "charge_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "charge_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "charge_receipts"
  USING ("billing_account_id" IN (
    SELECT "id" FROM "billing_accounts"
    WHERE "owner_user_id" = current_setting('app.current_user_id', true)
  ))
  WITH CHECK ("billing_account_id" IN (
    SELECT "id" FROM "billing_accounts"
    WHERE "owner_user_id" = current_setting('app.current_user_id', true)
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. PAYMENT_ATTEMPTS — transitive FK (billing_account_id → billing_accounts)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "payment_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_attempts"
  USING ("billing_account_id" IN (
    SELECT "id" FROM "billing_accounts"
    WHERE "owner_user_id" = current_setting('app.current_user_id', true)
  ))
  WITH CHECK ("billing_account_id" IN (
    SELECT "id" FROM "billing_accounts"
    WHERE "owner_user_id" = current_setting('app.current_user_id', true)
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. PAYMENT_EVENTS — deep transitive (attempt_id → payment_attempts → billing_accounts)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "payment_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payment_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_events"
  USING ("attempt_id" IN (
    SELECT "id" FROM "payment_attempts"
    WHERE "billing_account_id" IN (
      SELECT "id" FROM "billing_accounts"
      WHERE "owner_user_id" = current_setting('app.current_user_id', true)
    )
  ))
  WITH CHECK ("attempt_id" IN (
    SELECT "id" FROM "payment_attempts"
    WHERE "billing_account_id" IN (
      SELECT "id" FROM "billing_accounts"
      WHERE "owner_user_id" = current_setting('app.current_user_id', true)
    )
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. SCHEDULE_RUNS — deep transitive (schedule_id → schedules → users)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "schedule_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedule_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "schedule_runs"
  USING ("schedule_id" IN (
    SELECT "id" FROM "schedules"
    WHERE "owner_user_id" = current_setting('app.current_user_id', true)
  ))
  WITH CHECK ("schedule_id" IN (
    SELECT "id" FROM "schedules"
    WHERE "owner_user_id" = current_setting('app.current_user_id', true)
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- EXEMPT: ai_invocation_summaries (no user FK, pure telemetry)
-- EXEMPT: execution_requests (no user FK, idempotency layer)
-- ═══════════════════════════════════════════════════════════════════════════
