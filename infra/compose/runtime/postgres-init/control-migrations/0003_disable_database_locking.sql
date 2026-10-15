-- Reliability observes and alerts; it never changes runtime role admission.
-- Keep this idempotent boundary after historical function/grant reconciliation.
DO $disable$
DECLARE target record; principal text;
BEGIN
  FOR target IN
    SELECT p.oid::regprocedure AS signature,
      format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_arguments(p.oid)) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE (n.nspname='cogni_control' AND p.proname='apply_roles')
        OR (n.nspname='public' AND p.proname IN (
          'contain_database_role','readmit_database_role',
          'contain_node_database','re_admit_node_database',
          'contain_database_incident','begin_database_recovery',
          'complete_database_recovery','recontain_database_recovery',
          'database_recovery_watchdog_tick'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', target.signature);
    FOREACH principal IN ARRAY ARRAY['database_reliability_actuator','database_reliability_readmitter']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=principal) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',target.signature,principal);
      END IF;
    END LOOP;
    -- Defang SECURITY DEFINER calls even if an older provisioner regrants EXECUTE.
    -- Replacing only the body preserves signatures and historical incident storage.
    EXECUTE format('CREATE OR REPLACE FUNCTION %s RETURNS %s LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS %L',
      target.definition,pg_get_function_result(target.signature),
      'BEGIN RAISE EXCEPTION ''database locking and automatic readmission are disabled'' USING ERRCODE = ''42501''; END');
  END LOOP;
END
$disable$;
