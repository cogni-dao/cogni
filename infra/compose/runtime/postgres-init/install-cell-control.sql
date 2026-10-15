-- Explicit first installation on a qualified owned cell; NEVER included by shared provision.sh.
-- Caller must byte-verify the reviewed commit + SHA256(0000 || 0001 || 0002) BEFORE invoking psql.
-- Required psql vars: expected_endpoint_host, expected_endpoint_port, expected_system_identifier,
-- reviewed_control_source_sha, migration_manifest_sha256. Public system TLS requires sslmode=verify-full.
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('cogni_control/dedicated/v1',0));
SELECT session_user='postgres' AND current_user='postgres' AND current_database()='postgres'
  AND :'HOST'=:'expected_endpoint_host' AND :'PORT'=:'expected_endpoint_port'
  AND (SELECT system_identifier::text FROM pg_control_system())=:'expected_system_identifier'
  AND :'expected_system_identifier'<>'7671049237154275366'
  AND :'reviewed_control_source_sha' ~ '^[0-9a-f]{40}$'
  AND :'migration_manifest_sha256' ~ '^[0-9a-f]{64}$'
  AND (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) IS TRUE
  AND (SELECT count(*)=2 AND bool_and(NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    FROM pg_roles WHERE rolname IN('database_reliability_actuator','database_reliability_readmitter'))
  AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN(SELECT oid FROM pg_roles WHERE rolname IN('database_reliability_actuator','database_reliability_readmitter')))
  AS qualified \gset
\if :qualified
\else
  SELECT 1/0;
\endif
SELECT to_regnamespace('cogni_control') IS NOT NULL AS control_exists \gset
\if :control_exists
  -- An ambiguous previous response is a read-only retry only for this exact reviewed manifest.
  SELECT obj_description(to_regnamespace('cogni_control'),'pg_namespace') = :'migration_manifest_sha256' AS already_installed \gset
  \if :already_installed
  \else
    SELECT 1/0;
  \endif
\else
  --0000's historical bare-function revocations expect these signatures. Temporary INVOKER stubs
  --raise unconditionally and are removed inside this transaction; they are never published.
  SELECT to_regprocedure('public.contain_database_role(text)') IS NULL
    AND to_regprocedure('public.readmit_database_role(text)') IS NULL AS bare_functions_absent \gset
  \if :bare_functions_absent
  \else
    SELECT 1/0;
  \endif
  CREATE FUNCTION public.contain_database_role(text) RETURNS void LANGUAGE plpgsql AS $disabled$BEGIN RAISE EXCEPTION 'unpublished compatibility stub'; END$disabled$;
  CREATE FUNCTION public.readmit_database_role(text) RETURNS void LANGUAGE plpgsql AS $disabled$BEGIN RAISE EXCEPTION 'unpublished compatibility stub'; END$disabled$;
  REVOKE ALL ON FUNCTION public.contain_database_role(text),public.readmit_database_role(text) FROM PUBLIC;
  \ir control-migrations/0000_database_recovery_control.sql
  \ir control-migrations/0001_database_recovery_watchdog.sql
  \ir control-migrations/0002_dedicated_cell_admission.sql
  DROP FUNCTION public.contain_database_role(text);
  DROP FUNCTION public.readmit_database_role(text);
  REVOKE ALL ON ALL TABLES IN SCHEMA cogni_control FROM database_reliability_actuator,database_reliability_readmitter;
  COMMENT ON SCHEMA cogni_control IS :'migration_manifest_sha256';
\endif
COMMIT;
-- No role LOGIN changes, baseline import, probe grant or readmission grant occur here.
-- Install logical helper separately. Import only an actual immutable final-admission receipt.
-- Qualify independent native watchdog BEFORE granting begin_database_recovery to readmitter.
-- Fixed15/probe qualification and private custody projection remain separate explicit gates.
