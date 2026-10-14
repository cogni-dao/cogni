-- One bounded administrative schema, delivered as immutable reviewed v1 bytes.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('cogni_control/schema/v1', 0));
SELECT to_regnamespace('cogni_control') IS NOT NULL AS control_exists \gset
\if :control_exists
  SELECT 1 / coalesce((obj_description(to_regnamespace('cogni_control'), 'pg_namespace') = :'expected_control_schema_sha')::int, 0);
\else
  \ir control-migrations/0000_database_recovery_control.sql
  COMMENT ON SCHEMA cogni_control IS :'expected_control_schema_sha';
\endif
COMMIT;
