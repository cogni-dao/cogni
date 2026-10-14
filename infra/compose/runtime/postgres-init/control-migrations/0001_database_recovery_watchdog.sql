CREATE TABLE "cogni_control"."database_recovery_watchdog_ticks" (
	"environment" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"enforced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "database_recovery_watchdog_environment" CHECK ("cogni_control"."database_recovery_watchdog_ticks"."environment" IN ('candidate-a', 'preview', 'production')),
	CONSTRAINT "database_recovery_watchdog_protocol" CHECK ("cogni_control"."database_recovery_watchdog_ticks"."protocol_version" = 1)
);

CREATE OR REPLACE FUNCTION public.begin_database_recovery(
  target_node uuid, target_slug text, target_env text, target_incident text,
  human_actor text, target_sha text, target_system text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE incident cogni_control.database_recoveries; started timestamptz;
BEGIN
  PERFORM cogni_control.require_actor('readmitter');
  PERFORM cogni_control.assert_system(target_system);
  IF human_actor IS NULL OR human_actor !~ '^human:[a-zA-Z0-9._@:-]{1,120}$' THEN
    RAISE EXCEPTION 'recovery requires an attributed human actor' USING ERRCODE = '42501';
  END IF;
  incident := cogni_control.lock_current(target_node, target_env);
  IF incident.incident_id IS DISTINCT FROM target_incident OR incident.node_slug IS DISTINCT FROM target_slug
    OR incident.target_build_sha IS DISTINCT FROM target_sha
    OR incident.database_system_identifier IS DISTINCT FROM target_system THEN
    RAISE EXCEPTION 'recovery does not match the current contained incident' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cogni_control.database_recovery_watchdog_ticks
    WHERE environment = target_env AND protocol_version = 1
      AND enforced_at >= clock_timestamp() - interval '15 seconds'
      AND enforced_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'independent recovery watchdog receipt is missing or stale' USING ERRCODE = '42501';
  END IF;
  IF incident.state IN ('recovering', 'readmitted') THEN
    IF incident.actor_id <> human_actor OR (incident.state = 'recovering' AND clock_timestamp() >= incident.deadline_at) THEN
      RAISE EXCEPTION 'recovery retry changed actor or exceeded its original deadline' USING ERRCODE = '42501';
    END IF;
    RETURN cogni_control.receipt(incident) || jsonb_build_object('transitionApplied', false);
  END IF;
  IF incident.state <> 'contained' OR EXISTS (SELECT 1 FROM pg_roles
    WHERE rolname IN (incident.app_role, incident.service_role) AND rolcanlogin)
    OR EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename IN (incident.app_role, incident.service_role)) THEN
    RAISE EXCEPTION 'recovery requires exact contained roles and zero runtime sessions' USING ERRCODE = '42501';
  END IF;
  started := clock_timestamp();
  -- The intent and LOGIN share this transaction; no observable LOGIN exists
  -- without its durable nonrenewable intent, including a crash after commit.
  UPDATE cogni_control.database_recoveries
    SET state = 'recovering', actor_id = human_actor, started_at = started,
      deadline_at = started + interval '10 minutes', verified_at = NULL
    WHERE node_id = target_node AND environment = target_env AND incident_id = target_incident
    RETURNING * INTO incident;
  PERFORM cogni_control.apply_roles(incident, true);
  RETURN cogni_control.receipt(incident) || jsonb_build_object('transitionApplied', true);
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_database_recovery(
  target_node uuid, target_env text, target_incident text, target_sha text, target_system text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE incident cogni_control.database_recoveries;
BEGIN
  PERFORM cogni_control.require_actor('actuator');
  PERFORM cogni_control.assert_system(target_system);
  incident := cogni_control.lock_current(target_node, target_env);
  IF incident.incident_id IS DISTINCT FROM target_incident OR incident.target_build_sha IS DISTINCT FROM target_sha
    OR incident.database_system_identifier IS DISTINCT FROM target_system THEN
    RAISE EXCEPTION 'completion does not match the current recovery incident' USING ERRCODE = '42501';
  END IF;
  IF incident.state = 'readmitted' THEN RETURN cogni_control.receipt(incident) || jsonb_build_object('transitionApplied', false); END IF;
  IF incident.state <> 'recovering' OR clock_timestamp() >= incident.deadline_at
    OR clock_timestamp() < incident.started_at + interval '5 minutes'
    OR (SELECT count(*) = 2 AND bool_and(rolcanlogin) FROM pg_roles
      WHERE rolname IN (incident.app_role, incident.service_role)) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'recovery completion is not current, open, or inside its deadline' USING ERRCODE = '42501';
  END IF;
  UPDATE cogni_control.database_recoveries SET state = 'readmitted', verified_at = clock_timestamp()
    WHERE node_id = target_node AND environment = target_env AND incident_id = target_incident
    RETURNING * INTO incident;
  RETURN cogni_control.receipt(incident) || jsonb_build_object('transitionApplied', true);
END
$function$;

CREATE OR REPLACE FUNCTION public.recontain_database_recovery(
  target_node uuid, target_env text, target_incident text, failure_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE incident cogni_control.database_recoveries;
BEGIN
  PERFORM cogni_control.require_actor('actuator');
  IF failure_reason IS NULL OR length(failure_reason) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'recontainment requires a bounded reason' USING ERRCODE = '42501';
  END IF;
  incident := cogni_control.lock_current(target_node, target_env);
  IF incident.incident_id IS DISTINCT FROM target_incident THEN
    RAISE EXCEPTION 'recontainment does not match the current incident' USING ERRCODE = '42501';
  END IF;
  IF incident.state = 'recontained' THEN
    PERFORM cogni_control.apply_roles(incident, false);
    RETURN cogni_control.receipt(incident) || jsonb_build_object('transitionApplied', false);
  END IF;
  IF incident.state NOT IN ('contained', 'recovering') THEN
    RAISE EXCEPTION 'recontainment requires an unresolved current incident' USING ERRCODE = '42501';
  END IF;
  UPDATE cogni_control.database_recoveries SET state = 'recontained', reason = failure_reason
    WHERE node_id = target_node AND environment = target_env AND incident_id = target_incident
    RETURNING * INTO incident;
  PERFORM cogni_control.apply_roles(incident, false);
  RETURN cogni_control.receipt(incident) || jsonb_build_object('transitionApplied', true);
END
$function$;


-- Native enforcement runs before publishing liveness; no plain heartbeat authority exists.
REVOKE ALL ON TABLE cogni_control.database_recovery_watchdog_ticks FROM PUBLIC;
CREATE FUNCTION public.database_recovery_watchdog_tick(target_environment text, owner_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE candidate record; incident cogni_control.database_recoveries;
DECLARE enforced timestamptz; transition jsonb; transitions jsonb := '[]'::jsonb;
BEGIN
  PERFORM cogni_control.require_actor('actuator');
  IF target_environment IS NULL OR target_environment NOT IN ('candidate-a','preview','production')
    OR owner_id IS NULL OR length(owner_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'watchdog environment/owner identity invalid' USING ERRCODE = '42501';
  END IF;
  FOR candidate IN SELECT node_id, environment, incident_id FROM cogni_control.database_recoveries
    WHERE is_current AND environment = target_environment AND state = 'recovering'
    ORDER BY node_id LOOP
    -- Use the SAME advisory-then-row lock order as admission/completion; no inverse row lock.
    incident := cogni_control.lock_current(candidate.node_id, candidate.environment);
    IF incident.incident_id = candidate.incident_id AND incident.state = 'recovering'
      AND incident.deadline_at <= clock_timestamp() + interval '60 seconds' THEN
      transition := public.recontain_database_recovery(candidate.node_id, candidate.environment,
        candidate.incident_id, 'recovery_deadline_guard');
      IF (transition->>'transitionApplied')::boolean THEN
        transitions := transitions || jsonb_build_array(transition);
      END IF;
    END IF;
  END LOOP;
  enforced := clock_timestamp();
  INSERT INTO cogni_control.database_recovery_watchdog_ticks(environment, owner_id, protocol_version, enforced_at)
    VALUES(target_environment, owner_id, 1, enforced)
    ON CONFLICT(environment) DO UPDATE SET owner_id = EXCLUDED.owner_id,
      protocol_version = EXCLUDED.protocol_version, enforced_at = EXCLUDED.enforced_at;
  RETURN jsonb_build_object('observedAt', enforced, 'heartbeatExpiresAt', enforced + interval '15 seconds',
    'transitions', transitions);
END
$function$;
REVOKE ALL ON FUNCTION public.database_recovery_watchdog_tick(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.database_recovery_watchdog_tick(text,text) TO database_reliability_actuator;
-- Normal provisioning grants admission only after this intrinsic watchdog guard is installed.
-- The function itself denies missing/stale independent enforcement before any LOGIN.
