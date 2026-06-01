-- Widen graph_runs RLS to support non-schedule runs (webhook, user_immediate).
-- The original policy (from schedule_runs) only checks schedule_id FK.
-- graph_runs is a unified ledger — runs may have no schedule (webhook triggers, API calls).
-- Add requested_by as an alternative ownership path: you see runs you requested
-- OR runs from your schedules. Same security model, wider coverage.
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "graph_runs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "graph_runs"
  USING (
    "requested_by" = current_setting('app.current_user_id', true)
    OR "schedule_id" IN (
      SELECT "id" FROM "schedules"
      WHERE "owner_user_id" = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    "requested_by" = current_setting('app.current_user_id', true)
    OR "schedule_id" IN (
      SELECT "id" FROM "schedules"
      WHERE "owner_user_id" = current_setting('app.current_user_id', true)
    )
  );
