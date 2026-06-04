-- Migration: FORCE RLS + policies for identity/profile tables
-- Hand-written (not Drizzle-generated) — FORCE RLS and policies are outside Drizzle's DDL scope.
-- Pattern: same as 0004_enable_rls.sql — direct FK (user_id → users.id)
--
-- Why hand-written: Drizzle supports .enableRLS() and pgPolicy() but has no API for
-- FORCE ROW LEVEL SECURITY. Since app_user owns these tables, FORCE is required to
-- prevent the owner from bypassing RLS. See task.0055 for the proper fix (separate
-- migrator role so app_user is no longer owner).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. USER_PROFILES — direct FK (user_id → users.id, PK)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "user_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_profiles"
  USING ("user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. USER_BINDINGS — direct FK (user_id → users.id)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "user_bindings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_bindings"
  USING ("user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true));

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. IDENTITY_EVENTS — direct FK (user_id → users.id)
-- ═══════════════════════════════════════════════════════════════════════════
--> statement-breakpoint
ALTER TABLE "identity_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "identity_events"
  USING ("user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
