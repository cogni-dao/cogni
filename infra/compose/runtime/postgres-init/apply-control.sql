-- Bounded, forward-only v1 -> v2 administrative schema delivery.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('cogni_control/schema/v1', 0));
SELECT to_regnamespace('cogni_control') IS NOT NULL AS control_exists \gset
\if :control_exists
  SELECT coalesce(obj_description(to_regnamespace('cogni_control'), 'pg_namespace') = :'expected_control_schema_sha', false) AS control_current,
    coalesce(obj_description(to_regnamespace('cogni_control'), 'pg_namespace') = :'previous_control_schema_sha', false) AS control_v1 \gset
  \if :control_current
  \elif :control_v1
    \ir control-migrations/0001_database_recovery_watchdog.sql
    COMMENT ON SCHEMA cogni_control IS :'expected_control_schema_sha';
  \else
    SELECT 1 / 0;
  \endif
\else
  \ir control-migrations/0000_database_recovery_control.sql
  \ir control-migrations/0001_database_recovery_watchdog.sql
  COMMENT ON SCHEMA cogni_control IS :'expected_control_schema_sha';
\endif
COMMIT;
