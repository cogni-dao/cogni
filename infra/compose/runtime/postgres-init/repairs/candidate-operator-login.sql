-- Explicit, CEO-approved candidate-only repair. Never called by provisioning.
-- Run 0003_disable_database_locking.sql first in the same transaction.
-- Required psql var: reviewed_source_sha (immutable reviewed repair commit).
SELECT pg_advisory_xact_lock(hashtextextended('cogni_control/schema/v1',0));
SELECT node_id FROM cogni_control.database_recoveries
WHERE node_id='4ff8eac1-4eba-4ed0-931b-b1fe4f64713d' AND environment='candidate-a' AND is_current FOR UPDATE;
SELECT session_user='postgres' AND current_database()='postgres'
  AND (SELECT system_identifier::text FROM pg_control_system())='7671003649834102822'
  AND :'reviewed_source_sha' ~ '^[0-9a-f]{40}$'
  AND EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
    WHERE d.datname='cogni_operator' AND r.rolname='app_operator')
  AND (SELECT count(*)=2 AND bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole)
    FROM pg_roles WHERE rolname IN ('app_operator','service_operator'))
  AND EXISTS (SELECT 1 FROM cogni_control.database_recoveries
    WHERE node_id='4ff8eac1-4eba-4ed0-931b-b1fe4f64713d' AND environment='candidate-a'
      AND incident_id='reliability.v1:candidate-a:4ff8eac1-4eba-4ed0-931b-b1fe4f64713d:29867882'
      AND database_system_identifier='7671003649834102822' AND database_name='cogni_operator'
      AND app_role='app_operator' AND service_role='service_operator' AND state='contained' AND is_current)
  AS repair_qualified \gset
\if :repair_qualified
\else
  SELECT 1/0;
\endif
SELECT jsonb_build_object('event','candidate_runtime_login_restored','workItem','task.5246',
  'actorId','agent:2c4b7be4-173f-49bc-97e6-043736c0dbd1','approvedBy','CEO',
  'sourceSha',:'reviewed_source_sha','observedAt',clock_timestamp(),
  'incidentBefore',to_jsonb(i))::text AS repair_audit
FROM cogni_control.database_recoveries i
WHERE node_id='4ff8eac1-4eba-4ed0-931b-b1fe4f64713d' AND environment='candidate-a' AND is_current \gset
SELECT format('COMMENT ON ROLE %I IS %L',rolname,
  concat_ws(E'\n',shobj_description(oid,'pg_authid'),:'repair_audit'))
FROM pg_roles WHERE rolname IN ('app_operator','service_operator') \gexec
-- Preserve the original incident's state, attribution, reason and timestamps.
UPDATE cogni_control.database_recoveries SET is_current=false
WHERE node_id='4ff8eac1-4eba-4ed0-931b-b1fe4f64713d' AND environment='candidate-a' AND is_current;
ALTER ROLE app_operator LOGIN;
ALTER ROLE service_operator LOGIN;
SELECT set_config('cogni.repair_audit',:'repair_audit',true);
DO $audit$ BEGIN RAISE LOG 'candidate runtime role repair: %',current_setting('cogni.repair_audit'); END $audit$;
SELECT :'repair_audit'::jsonb AS audit_receipt;
