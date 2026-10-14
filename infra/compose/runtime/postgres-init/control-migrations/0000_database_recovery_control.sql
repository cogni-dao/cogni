CREATE SCHEMA "cogni_control";
--> statement-breakpoint
CREATE TABLE "cogni_control"."database_recoveries" (
	"node_id" uuid NOT NULL,
	"node_slug" text NOT NULL,
	"environment" text NOT NULL,
	"incident_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"target_build_sha" text NOT NULL,
	"database_system_identifier" text NOT NULL,
	"database_name" text NOT NULL,
	"app_role" text NOT NULL,
	"service_role" text NOT NULL,
	"state" text DEFAULT 'contained' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"reason" text NOT NULL,
	"contained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	CONSTRAINT "database_recoveries_node_id_environment_incident_id_pk" PRIMARY KEY("node_id","environment","incident_id"),
	CONSTRAINT "database_recoveries_environment" CHECK ("cogni_control"."database_recoveries"."environment" IN ('candidate-a', 'preview', 'production')),
	CONSTRAINT "database_recoveries_state" CHECK ("cogni_control"."database_recoveries"."state" IN ('contained', 'recovering', 'readmitted', 'recontained')),
	CONSTRAINT "database_recoveries_build_sha" CHECK ("cogni_control"."database_recoveries"."target_build_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "database_recoveries_fixed_deadline" CHECK (("cogni_control"."database_recoveries"."started_at" IS NULL AND "cogni_control"."database_recoveries"."deadline_at" IS NULL) OR "cogni_control"."database_recoveries"."deadline_at" = "cogni_control"."database_recoveries"."started_at" + interval '10 minutes'),
	CONSTRAINT "database_recoveries_recovering_intent" CHECK ("cogni_control"."database_recoveries"."state" <> 'recovering' OR ("cogni_control"."database_recoveries"."started_at" IS NOT NULL AND "cogni_control"."database_recoveries"."deadline_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "database_recoveries_current_node_env" ON "cogni_control"."database_recoveries" USING btree ("node_id","environment") WHERE "cogni_control"."database_recoveries"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "database_recoveries_current_role_pair" ON "cogni_control"."database_recoveries" USING btree ("app_role","service_role") WHERE "cogni_control"."database_recoveries"."is_current";--> statement-breakpoint
CREATE INDEX "database_recoveries_pending_deadline" ON "cogni_control"."database_recoveries" USING btree ("deadline_at") WHERE "cogni_control"."database_recoveries"."is_current" AND "cogni_control"."database_recoveries"."state" = 'recovering';
--> statement-breakpoint
-- Guarded administrative functions supplement the generated control schema.
REVOKE ALL ON SCHEMA cogni_control FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA cogni_control FROM PUBLIC;

CREATE FUNCTION cogni_control.require_actor(actor text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF (actor = 'actuator' AND session_user <> 'database_reliability_actuator')
    OR (actor = 'readmitter' AND session_user <> 'database_reliability_readmitter')
    OR actor NOT IN ('actuator', 'readmitter') THEN
    RAISE EXCEPTION 'recovery action requires its exact control identity' USING ERRCODE = '42501';
  END IF;
END
$function$;

CREATE FUNCTION cogni_control.assert_system(expected text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF expected IS DISTINCT FROM (SELECT system_identifier::text FROM pg_control_system()) THEN
    RAISE EXCEPTION 'recovery physical database identity mismatch' USING ERRCODE = '42501';
  END IF;
END
$function$;

CREATE FUNCTION cogni_control.lock_current(target_node uuid, target_env text)
RETURNS cogni_control.database_recoveries LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE incident cogni_control.database_recoveries;
BEGIN
  IF target_node IS NULL OR target_env NOT IN ('candidate-a', 'preview', 'production') THEN
    RAISE EXCEPTION 'recovery target identity invalid' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target_node::text || '/' || target_env, 0));
  SELECT * INTO incident FROM cogni_control.database_recoveries
    WHERE node_id = target_node AND environment = target_env AND is_current FOR UPDATE;
  RETURN incident;
END
$function$;

CREATE FUNCTION cogni_control.receipt(incident cogni_control.database_recoveries)
RETURNS jsonb LANGUAGE sql SET search_path = pg_catalog AS $function$
  SELECT jsonb_build_object(
    'nodeId', incident.node_id, 'nodeSlug', incident.node_slug, 'environment', incident.environment,
    'incidentId', incident.incident_id, 'actorId', incident.actor_id,
    'targetBuildSha', incident.target_build_sha, 'databaseSystemIdentifier', incident.database_system_identifier,
    'databaseName', incident.database_name, 'appRole', incident.app_role, 'serviceRole', incident.service_role,
    'state', incident.state, 'reason', incident.reason, 'containedAt', incident.contained_at,
    'startedAt', incident.started_at, 'deadlineAt', incident.deadline_at, 'verifiedAt', incident.verified_at);
$function$;

CREATE FUNCTION cogni_control.apply_roles(incident cogni_control.database_recoveries, admit boolean)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE role_suffix text;
BEGIN
  PERFORM cogni_control.assert_system(incident.database_system_identifier);
  role_suffix := substr(incident.database_name, length('cogni_') + 1);
  IF incident.app_role <> 'app_' || role_suffix OR incident.service_role <> 'service_' || role_suffix
    OR NOT EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
      WHERE d.datname = incident.database_name AND r.rolname = incident.app_role)
    OR (SELECT count(*) FROM pg_roles WHERE rolname IN (incident.app_role, incident.service_role)) <> 2 THEN
    RAISE EXCEPTION 'recovery stored role/database boundary mismatch' USING ERRCODE = '42501';
  END IF;
  EXECUTE format('ALTER ROLE %I %s', incident.app_role, CASE WHEN admit THEN 'LOGIN' ELSE 'NOLOGIN' END);
  EXECUTE format('ALTER ROLE %I %s', incident.service_role, CASE WHEN admit THEN 'LOGIN' ELSE 'NOLOGIN' END);
  IF NOT admit THEN
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE usename IN (incident.app_role, incident.service_role) AND pid <> pg_backend_pid();
  END IF;
END
$function$;

CREATE FUNCTION public.contain_database_incident(
  target_node uuid, target_slug text, target_env text, target_incident text,
  target_actor text, target_reason text, target_sha text, target_system text, target_database text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE incident cogni_control.database_recoveries; role_suffix text; base_database text;
BEGIN
  PERFORM cogni_control.require_actor('actuator');
  PERFORM cogni_control.assert_system(target_system);
  IF target_slug !~ '^[a-z][a-z0-9-]{0,62}$' OR target_incident IS NULL OR length(target_incident) NOT BETWEEN 1 AND 256
    OR target_actor IS NULL OR length(target_actor) NOT BETWEEN 1 AND 256
    OR target_reason IS NULL OR length(target_reason) NOT BETWEEN 1 AND 256
    OR target_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'containment incident identity invalid' USING ERRCODE = '42501';
  END IF;
  base_database := 'cogni_' || replace(target_slug, '-', '_');
  IF target_database IS DISTINCT FROM base_database
    AND target_database IS DISTINCT FROM base_database || '_' || replace(target_env, '-', '_') THEN
    RAISE EXCEPTION 'containment database is outside the source/target node namespace' USING ERRCODE = '42501';
  END IF;
  incident := cogni_control.lock_current(target_node, target_env);
  IF incident.incident_id = target_incident THEN
    IF incident.node_slug <> target_slug OR incident.target_build_sha <> target_sha
      OR incident.database_name <> target_database OR incident.database_system_identifier <> target_system THEN
      RAISE EXCEPTION 'containment incident was rebound' USING ERRCODE = '42501';
    END IF;
    IF incident.state = 'contained' THEN PERFORM cogni_control.apply_roles(incident, false); END IF;
    RETURN cogni_control.receipt(incident) || jsonb_build_object('transitionApplied', false);
  END IF;
  IF incident.state IN ('contained', 'recovering') THEN
    RAISE EXCEPTION 'another current incident requires resolution' USING ERRCODE = '42501';
  END IF;
  UPDATE cogni_control.database_recoveries SET is_current = false
    WHERE node_id = target_node AND environment = target_env AND is_current;
  role_suffix := substr(target_database, length('cogni_') + 1);
  INSERT INTO cogni_control.database_recoveries
    (node_id, node_slug, environment, incident_id, actor_id, reason, target_build_sha,
      database_system_identifier, database_name, app_role, service_role)
    VALUES (target_node, target_slug, target_env, target_incident, target_actor, target_reason, target_sha,
      target_system, target_database, 'app_' || role_suffix, 'service_' || role_suffix)
    RETURNING * INTO incident;
  PERFORM cogni_control.apply_roles(incident, false);
  RETURN cogni_control.receipt(incident) || jsonb_build_object('transitionApplied', true);
END
$function$;

CREATE FUNCTION public.begin_database_recovery(
  target_node uuid, target_slug text, target_env text, target_incident text,
  human_actor text, target_sha text, target_system text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE incident cogni_control.database_recoveries; started timestamptz;
BEGIN
  PERFORM cogni_control.require_actor('readmitter');
  PERFORM cogni_control.assert_system(target_system);
  IF human_actor IS NULL OR length(human_actor) NOT BETWEEN 1 AND 256 OR human_actor LIKE 'system:%' THEN
    RAISE EXCEPTION 'recovery requires an attributed human actor' USING ERRCODE = '42501';
  END IF;
  incident := cogni_control.lock_current(target_node, target_env);
  IF incident.incident_id IS DISTINCT FROM target_incident OR incident.node_slug IS DISTINCT FROM target_slug
    OR incident.target_build_sha IS DISTINCT FROM target_sha
    OR incident.database_system_identifier IS DISTINCT FROM target_system THEN
    RAISE EXCEPTION 'recovery does not match the current contained incident' USING ERRCODE = '42501';
  END IF;
  IF incident.state IN ('recovering', 'readmitted') THEN
    IF incident.actor_id <> human_actor OR (incident.state = 'recovering' AND clock_timestamp() >= incident.deadline_at) THEN
      RAISE EXCEPTION 'recovery retry changed actor or exceeded its original deadline' USING ERRCODE = '42501';
    END IF;
    RETURN cogni_control.receipt(incident);
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
  RETURN cogni_control.receipt(incident);
END
$function$;

CREATE FUNCTION public.complete_database_recovery(
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
  IF incident.state = 'readmitted' THEN RETURN cogni_control.receipt(incident); END IF;
  IF incident.state <> 'recovering' OR clock_timestamp() >= incident.deadline_at
    OR (SELECT count(*) = 2 AND bool_and(rolcanlogin) FROM pg_roles
      WHERE rolname IN (incident.app_role, incident.service_role)) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'recovery completion is not current, open, or inside its deadline' USING ERRCODE = '42501';
  END IF;
  UPDATE cogni_control.database_recoveries SET state = 'readmitted', verified_at = clock_timestamp()
    WHERE node_id = target_node AND environment = target_env AND incident_id = target_incident
    RETURNING * INTO incident;
  RETURN cogni_control.receipt(incident);
END
$function$;

CREATE FUNCTION public.recontain_database_recovery(
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
  IF incident.state = 'recontained' THEN RETURN cogni_control.receipt(incident); END IF;
  IF incident.state NOT IN ('contained', 'recovering') THEN
    RAISE EXCEPTION 'recontainment requires an unresolved current incident' USING ERRCODE = '42501';
  END IF;
  UPDATE cogni_control.database_recoveries SET state = 'recontained', reason = failure_reason
    WHERE node_id = target_node AND environment = target_env AND incident_id = target_incident
    RETURNING * INTO incident;
  PERFORM cogni_control.apply_roles(incident, false);
  RETURN cogni_control.receipt(incident);
END
$function$;

CREATE FUNCTION public.list_database_recoveries() RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
BEGIN
  IF session_user NOT IN ('database_reliability_actuator', 'database_reliability_readmitter') THEN
    RAISE EXCEPTION 'recovery enumeration requires a private control identity' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT cogni_control.receipt(incident) FROM cogni_control.database_recoveries incident
    WHERE incident.is_current ORDER BY incident.node_id, incident.environment;
END
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cogni_control FROM PUBLIC;
REVOKE ALL ON FUNCTION public.contain_database_incident(uuid,text,text,text,text,text,text,text,text),
  public.begin_database_recovery(uuid,text,text,text,text,text,text),
  public.complete_database_recovery(uuid,text,text,text,text),
  public.recontain_database_recovery(uuid,text,text,text), public.list_database_recoveries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.contain_database_incident(uuid,text,text,text,text,text,text,text,text),
  public.complete_database_recovery(uuid,text,text,text,text), public.recontain_database_recovery(uuid,text,text,text),
  public.list_database_recoveries() TO database_reliability_actuator;
-- First containment slice: admission remains natively disabled until independent deadline enforcement is proven.
REVOKE ALL ON FUNCTION public.begin_database_recovery(uuid,text,text,text,text,text,text) FROM database_reliability_readmitter;
GRANT EXECUTE ON FUNCTION public.list_database_recoveries() TO database_reliability_readmitter;
-- Bare role admission bypasses current incident/deadline ownership.
REVOKE ALL ON FUNCTION public.readmit_database_role(text) FROM database_reliability_readmitter;
REVOKE ALL ON FUNCTION public.contain_database_role(text) FROM database_reliability_actuator;
