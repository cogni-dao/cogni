CREATE TABLE "cogni_control"."database_cell_admissions" (
	"node_id" uuid NOT NULL,
	"node_slug" text NOT NULL,
	"environment" text NOT NULL,
	"allocation_receipt_id" uuid NOT NULL,
	"dseq" text NOT NULL,
	"provider_account" text NOT NULL,
	"database_system_identifier" text NOT NULL,
	"database_name" text NOT NULL,
	"app_role" text NOT NULL,
	"service_role" text NOT NULL,
	"probe_role" text NOT NULL,
	"target_build_sha" text NOT NULL,
	"manual_packet_sha256" text NOT NULL,
	"readmission_receipt_sha256" text NOT NULL,
	"execution_actor" jsonb NOT NULL,
	"approval_authority" jsonb NOT NULL,
	"preserved_role_bounds" jsonb NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_control_source_sha" text NOT NULL,
	"migration_manifest_sha256" text NOT NULL,
	"installed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "database_cell_admissions_node_id_environment_pk" PRIMARY KEY("node_id","environment"),
	CONSTRAINT "database_cell_admissions_environment" CHECK ("cogni_control"."database_cell_admissions"."environment" IN ('candidate-a', 'preview', 'production')),
	CONSTRAINT "database_cell_admissions_native_system" CHECK ("cogni_control"."database_cell_admissions"."database_system_identifier" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "database_cell_admissions_app_sha" CHECK ("cogni_control"."database_cell_admissions"."target_build_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "database_cell_admissions_control_sha" CHECK ("cogni_control"."database_cell_admissions"."reviewed_control_source_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "database_cell_admissions_packet_sha" CHECK ("cogni_control"."database_cell_admissions"."manual_packet_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "database_cell_admissions_receipt_sha" CHECK ("cogni_control"."database_cell_admissions"."readmission_receipt_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "database_cell_admissions_migration_sha" CHECK ("cogni_control"."database_cell_admissions"."migration_manifest_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "database_cell_admissions_real_admission_time" CHECK ("cogni_control"."database_cell_admissions"."admitted_at" <= "cogni_control"."database_cell_admissions"."imported_at" AND "cogni_control"."database_cell_admissions"."installed_at" <= "cogni_control"."database_cell_admissions"."imported_at")
);
--> statement-breakpoint
CREATE TABLE "cogni_control"."database_cell_readmission_audits" (
	"node_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"incident_id" text NOT NULL,
	"manual_packet_sha256" text NOT NULL,
	"readmission_receipt_sha256" text NOT NULL,
	"expected_previous_receipt_sha256" text NOT NULL,
	"contained_at" timestamp with time zone NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"execution_actor" jsonb NOT NULL,
	"approval_authority" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_cell_readmission_audits_node_id_environment_incident_id_pk" PRIMARY KEY("node_id","environment","incident_id"),
	CONSTRAINT "database_cell_readmission_audits_environment" CHECK ("cogni_control"."database_cell_readmission_audits"."environment" IN ('candidate-a','preview','production')),
	CONSTRAINT "database_cell_readmission_audits_sha" CHECK ("cogni_control"."database_cell_readmission_audits"."manual_packet_sha256" ~ '^[0-9a-f]{64}$' AND "cogni_control"."database_cell_readmission_audits"."readmission_receipt_sha256" ~ '^[0-9a-f]{64}$' AND "cogni_control"."database_cell_readmission_audits"."expected_previous_receipt_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "database_cell_readmission_audits_time" CHECK ("cogni_control"."database_cell_readmission_audits"."contained_at" <= "cogni_control"."database_cell_readmission_audits"."admitted_at" AND "cogni_control"."database_cell_readmission_audits"."admitted_at" <= "cogni_control"."database_cell_readmission_audits"."imported_at")
);
--> statement-breakpoint
CREATE TABLE "cogni_control"."database_cell_replay_roles" (
	"node_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"database_name" text NOT NULL,
	"role_name" text NOT NULL,
	"connection_limit" integer NOT NULL,
	"workload_manifest_sha256" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "database_cell_replay_roles_node_id_environment_pk" PRIMARY KEY("node_id","environment"),
	CONSTRAINT "database_cell_replay_roles_environment" CHECK ("cogni_control"."database_cell_replay_roles"."environment" IN ('candidate-a', 'preview', 'production')),
	CONSTRAINT "database_cell_replay_roles_bounded_connections" CHECK ("cogni_control"."database_cell_replay_roles"."connection_limit" = 8),
	CONSTRAINT "database_cell_replay_roles_workload_sha" CHECK ("cogni_control"."database_cell_replay_roles"."workload_manifest_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "database_cell_admissions_owned_database" ON "cogni_control"."database_cell_admissions" USING btree ("database_name");--> statement-breakpoint
CREATE UNIQUE INDEX "database_cell_admissions_owned_roles" ON "cogni_control"."database_cell_admissions" USING btree ("app_role","service_role");--> statement-breakpoint
CREATE UNIQUE INDEX "database_cell_readmission_audits_receipt" ON "cogni_control"."database_cell_readmission_audits" USING btree ("readmission_receipt_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "database_cell_replay_roles_owned_database" ON "cogni_control"."database_cell_replay_roles" USING btree ("database_name");--> statement-breakpoint
CREATE UNIQUE INDEX "database_cell_replay_roles_owned_role" ON "cogni_control"."database_cell_replay_roles" USING btree ("role_name");
--> statement-breakpoint
-- This migration is ADMINISTRATIVE postgres only, on a separately qualified owned cell.
REVOKE ALL ON ALL TABLES IN SCHEMA cogni_control FROM PUBLIC;
CREATE FUNCTION public.import_database_cell_admission(packet jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $function$
DECLARE a cogni_control.database_cell_admissions; old cogni_control.database_cell_admissions; role_count integer;
DECLARE incident cogni_control.database_recoveries; audit cogni_control.database_cell_readmission_audits; previous_receipt text;
BEGIN
  IF session_user <> 'postgres' OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'admission import requires owned-cell administrative postgres custody' USING ERRCODE='42501';
  END IF;
  a := jsonb_populate_record(NULL::cogni_control.database_cell_admissions, packet);
  PERFORM cogni_control.assert_system(a.database_system_identifier);
  PERFORM pg_advisory_xact_lock(hashtextextended(a.node_id::text || '/' || a.environment,0));
  IF a.node_slug !~ '^[a-z][a-z0-9-]{0,62}$'
    OR a.database_name <> 'cogni_' || replace(a.node_slug,'-','_')
    OR a.app_role <> 'app_' || substr(a.database_name,7)
    OR a.service_role <> 'service_' || substr(a.database_name,7)
    OR a.probe_role <> 'probe_' || substr(a.database_name,7)
    OR coalesce(a.execution_actor->>'kind','') NOT IN ('agent','human')
    OR a.execution_actor->>'id' IS NULL
    OR a.approval_authority->>'kind' IS DISTINCT FROM 'conversation-user'
    OR a.approval_authority->>'source' IS DISTINCT FROM 'direct-user-instruction'
    OR a.approval_authority->>'decisionRef' IS NULL
    OR coalesce(a.approval_authority->>'delegationDigest','') !~ '^[0-9a-f]{64}$'
    OR a.admitted_at IS NULL OR a.admitted_at > clock_timestamp()
    OR a.installed_at IS NULL OR a.installed_at > clock_timestamp()
    OR jsonb_array_length(a.preserved_role_bounds) <> 2 THEN
    RAISE EXCEPTION 'admission packet identity, authority or actual admission is incomplete' USING ERRCODE='42501';
  END IF;
  SELECT count(*) INTO role_count FROM pg_roles r WHERE r.rolname IN (a.app_role,a.service_role)
    AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb
    AND NOT coalesce('default_transaction_read_only=on'=ANY(r.rolconfig),false);
  IF role_count <> 2 OR current_setting('default_transaction_read_only')::boolean OR EXISTS(SELECT 1 FROM pg_db_role_setting
      WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname=a.database_name) AND (setrole=0 OR setrole IN (SELECT oid FROM pg_roles WHERE rolname IN(a.app_role,a.service_role))))
    OR NOT EXISTS(SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=a.database_name AND r.rolname=a.app_role)
    OR (NOT (packet ? 'external_incident_id') AND EXISTS(SELECT 1 FROM cogni_control.database_recoveries WHERE node_id=a.node_id AND environment=a.environment AND is_current AND state <> 'readmitted')) THEN
    RAISE EXCEPTION 'import is observation only and requires genuinely admitted bounded runtime roles' USING ERRCODE='42501';
  END IF;
  -- Validate every bound against native role settings, with global fallback measured in this session.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(a.preserved_role_bounds) b
    LEFT JOIN pg_roles r ON r.rolname=b->>'name'
    WHERE r.rolname IS NULL OR r.rolname NOT IN(a.app_role,a.service_role)
      OR (b->>'connectionLimit')::integer IS DISTINCT FROM r.rolconnlimit
      OR (b->>'statementTimeoutMs')::numeric IS DISTINCT FROM (
        SELECT CASE WHEN v ~ '^[0-9]+$' THEN v::numeric ELSE extract(epoch FROM v::interval)*1000 END
        FROM (SELECT coalesce((SELECT substr(c,length('statement_timeout=')+1) FROM unnest(r.rolconfig)c WHERE c LIKE 'statement_timeout=%'),current_setting('statement_timeout'))v)x)
      OR (b->>'lockTimeoutMs')::numeric IS DISTINCT FROM (
        SELECT CASE WHEN v ~ '^[0-9]+$' THEN v::numeric ELSE extract(epoch FROM v::interval)*1000 END
        FROM (SELECT coalesce((SELECT substr(c,length('lock_timeout=')+1) FROM unnest(r.rolconfig)c WHERE c LIKE 'lock_timeout=%'),current_setting('lock_timeout'))v)x)
      OR (b->>'idleInTransactionTimeoutMs')::numeric IS DISTINCT FROM (
        SELECT CASE WHEN v ~ '^[0-9]+$' THEN v::numeric ELSE extract(epoch FROM v::interval)*1000 END
        FROM (SELECT coalesce((SELECT substr(c,length('idle_in_transaction_session_timeout=')+1) FROM unnest(r.rolconfig)c WHERE c LIKE 'idle_in_transaction_session_timeout=%'),current_setting('idle_in_transaction_session_timeout'))v)x)
      OR (b->>'tempFileLimitMiB')::numeric IS DISTINCT FROM (
        SELECT CASE WHEN v ~ '^-?[0-9]+$' THEN v::numeric/1024 ELSE pg_size_bytes(v)::numeric/1048576 END
        FROM (SELECT coalesce((SELECT substr(c,length('temp_file_limit=')+1) FROM unnest(r.rolconfig)c WHERE c LIKE 'temp_file_limit=%'),current_setting('temp_file_limit'))v)x)
      OR (b->>'workMemMiB')::numeric IS DISTINCT FROM (
        SELECT CASE WHEN v ~ '^[0-9]+$' THEN v::numeric/1024 ELSE pg_size_bytes(v)::numeric/1048576 END
        FROM (SELECT coalesce((SELECT substr(c,length('work_mem=')+1) FROM unnest(r.rolconfig)c WHERE c LIKE 'work_mem=%'),current_setting('work_mem'))v)x)
  ) OR (SELECT count(DISTINCT b->>'name') FROM jsonb_array_elements(a.preserved_role_bounds)b)<>2 THEN
    RAISE EXCEPTION 'imported bounds differ from actual native preserved role bounds' USING ERRCODE='42501';
  END IF;
  SELECT * INTO old FROM cogni_control.database_cell_admissions WHERE node_id=a.node_id AND environment=a.environment;
  IF packet ? 'external_incident_id' THEN
    IF old.node_id IS NULL OR old.database_system_identifier<>a.database_system_identifier
      OR old.database_name<>a.database_name OR old.allocation_receipt_id<>a.allocation_receipt_id
      OR old.dseq<>a.dseq OR old.provider_account<>a.provider_account OR old.target_build_sha<>a.target_build_sha
      OR old.app_role<>a.app_role OR old.service_role<>a.service_role OR old.probe_role<>a.probe_role
      OR old.preserved_role_bounds IS DISTINCT FROM a.preserved_role_bounds THEN
      RAISE EXCEPTION 'external readmission cannot rebind immutable admission identity' USING ERRCODE='42501';
    END IF;
    incident:=cogni_control.lock_current(a.node_id,a.environment);
    IF incident.incident_id IS DISTINCT FROM packet->>'external_incident_id'
      OR incident.target_build_sha IS DISTINCT FROM a.target_build_sha
      OR incident.database_system_identifier IS DISTINCT FROM a.database_system_identifier
      OR incident.database_name IS DISTINCT FROM a.database_name THEN
      RAISE EXCEPTION 'external readmission requires a genuine matching current incident' USING ERRCODE='42501';
    END IF;
    SELECT * INTO audit FROM cogni_control.database_cell_readmission_audits
      WHERE node_id=a.node_id AND environment=a.environment AND incident_id=incident.incident_id;
    IF FOUND THEN
      IF audit.manual_packet_sha256<>a.manual_packet_sha256 OR audit.readmission_receipt_sha256<>a.readmission_receipt_sha256
        OR audit.admitted_at<>a.admitted_at OR audit.execution_actor IS DISTINCT FROM a.execution_actor
        OR audit.approval_authority IS DISTINCT FROM a.approval_authority
        OR incident.state<>'readmitted' OR incident.verified_at<>audit.admitted_at THEN
        RAISE EXCEPTION 'external readmission retry changed immutable receipt' USING ERRCODE='42501';
      END IF;
      RETURN to_jsonb(audit);
    END IF;
    SELECT readmission_receipt_sha256 INTO previous_receipt FROM cogni_control.database_cell_readmission_audits
      WHERE node_id=a.node_id AND environment=a.environment ORDER BY imported_at DESC LIMIT 1;
    previous_receipt:=coalesce(previous_receipt,old.readmission_receipt_sha256);
    IF packet->>'expected_incident_state' IS DISTINCT FROM incident.state
      OR incident.state NOT IN('contained','recovering','recontained')
      OR (packet->>'expected_contained_at')::timestamptz IS DISTINCT FROM incident.contained_at
      OR packet->>'expected_previous_receipt_sha256' IS DISTINCT FROM previous_receipt
      OR a.admitted_at<incident.contained_at OR a.admitted_at>clock_timestamp()
      OR a.readmission_receipt_sha256=previous_receipt THEN
      RAISE EXCEPTION 'external readmission incident or receipt CAS failed' USING ERRCODE='42501';
    END IF;
    INSERT INTO cogni_control.database_cell_readmission_audits(node_id,environment,incident_id,manual_packet_sha256,
      readmission_receipt_sha256,expected_previous_receipt_sha256,contained_at,admitted_at,execution_actor,approval_authority)
      VALUES(a.node_id,a.environment,incident.incident_id,a.manual_packet_sha256,a.readmission_receipt_sha256,
        previous_receipt,incident.contained_at,a.admitted_at,a.execution_actor,a.approval_authority) RETURNING * INTO audit;
    -- Roles are already writable from separately audited manual admission. Import changes no role and preserves contained_at.
    UPDATE cogni_control.database_recoveries SET state='readmitted',verified_at=a.admitted_at,
      actor_id=(a.execution_actor->>'kind')||':'||(a.execution_actor->>'id')
      WHERE node_id=a.node_id AND environment=a.environment AND incident_id=incident.incident_id AND is_current;
    RETURN to_jsonb(audit);
  END IF;
  IF old.node_id IS NOT NULL THEN
    IF (to_jsonb(old)-'imported_at') IS DISTINCT FROM (to_jsonb(a)-'imported_at') THEN
      RAISE EXCEPTION 'admission import is immutable and cannot replace a previous receipt' USING ERRCODE='42501';
    END IF;
    RETURN to_jsonb(old);
  END IF;
  a.imported_at:=clock_timestamp();
  INSERT INTO cogni_control.database_cell_admissions SELECT (a).*;
  RETURN to_jsonb(a);
END
$function$;

CREATE FUNCTION public.register_database_cell_replay(target_node uuid,target_env text,child_database text,child_role text,child_limit integer,manifest_sha text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $function$
DECLARE a cogni_control.database_cell_admissions; r pg_roles;
BEGIN
  IF session_user <> 'postgres' OR current_database()<>'postgres' THEN RAISE EXCEPTION 'replay registration requires root-owned cell custody' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT a FROM cogni_control.database_cell_admissions WHERE node_id=target_node AND environment=target_env;
  PERFORM cogni_control.assert_system(a.database_system_identifier);
  PERFORM pg_advisory_xact_lock(hashtextextended(target_node::text||'/'||target_env,0));
  SELECT * INTO STRICT r FROM pg_roles WHERE rolname=child_role;
  IF child_database<>a.database_name OR child_role<>'replay_'||substr(a.database_name,7)
    OR child_limit<>8 OR r.rolconnlimit<>8 OR r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls
    OR NOT coalesce('default_transaction_read_only=on'=ANY(r.rolconfig),false)
    OR manifest_sha !~ '^[0-9a-f]{64}$'
    OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=child_database)
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) THEN
    RAISE EXCEPTION 'replay child identity, bounds or workload qualification invalid' USING ERRCODE='42501';
  END IF;
  INSERT INTO cogni_control.database_cell_replay_roles(node_id,environment,database_name,role_name,connection_limit,workload_manifest_sha256)
    VALUES(target_node,target_env,child_database,child_role,child_limit,manifest_sha);
  RETURN jsonb_build_object('registered',true,'workloadManifestSha256',manifest_sha);
END
$function$;

CREATE FUNCTION public.database_cell_pressure(target_node uuid,target_env text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
DECLARE a cogni_control.database_cell_admissions; role_pressure jsonb; observed timestamptz;
BEGIN
  PERFORM cogni_control.require_actor('actuator');
  SELECT * INTO STRICT a FROM cogni_control.database_cell_admissions WHERE node_id=target_node AND environment=target_env;
  PERFORM cogni_control.assert_system(a.database_system_identifier);
  WITH owned AS (
    SELECT a.app_role name,'app' kind,a.database_name database_name UNION ALL
    SELECT a.service_role,'service',a.database_name UNION ALL
    SELECT role_name,'replay',database_name FROM cogni_control.database_cell_replay_roles WHERE node_id=target_node AND environment=target_env
  ), pressure AS (
    SELECT o.name,o.kind,r.rolconnlimit, count(s.pid) connections,
      count(s.pid) FILTER(WHERE s.state='active') active,
      count(s.pid) FILTER(WHERE s.state='active' AND s.wait_event_type IS NOT NULL) waiting,
      count(s.pid) FILTER(WHERE s.state='idle') idle,
      count(s.pid) FILTER(WHERE s.state IN('idle in transaction','idle in transaction (aborted)')) idle_tx
    FROM owned o JOIN pg_roles r ON r.rolname=o.name
    LEFT JOIN pg_stat_activity s ON s.usename=o.name AND s.datname=o.database_name
    GROUP BY o.name,o.kind,r.rolconnlimit
  ) SELECT jsonb_agg(jsonb_build_object('name',name,'kind',kind,'connectionLimit',rolconnlimit,'connections',connections,
      'active',active,'waiting',waiting,'idle',idle,'idleInTransaction',idle_tx) ORDER BY name) INTO role_pressure FROM pressure;
  observed:=clock_timestamp();
  RETURN jsonb_build_object('nodeId',a.node_id,'nodeSlug',a.node_slug,'environment',a.environment,'allocationReceiptId',a.allocation_receipt_id,
    'dseq',a.dseq,'providerAccount',a.provider_account,'databaseName',a.database_name,'systemIdentifier',a.database_system_identifier,
    'targetBuildSha',a.target_build_sha,'observedAt',observed,'totalBackends',(SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend'),
    'roles',role_pressure,'queryRef','native:database_cell_pressure:'||observed::text);
END
$function$;

CREATE OR REPLACE FUNCTION cogni_control.apply_roles(incident cogni_control.database_recoveries,admit boolean)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $function$
DECLARE suffix text; child record;
BEGIN
  PERFORM cogni_control.assert_system(incident.database_system_identifier);
  suffix:=substr(incident.database_name,7);
  IF incident.app_role<>'app_'||suffix OR incident.service_role<>'service_'||suffix
    OR NOT EXISTS(SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=incident.database_name AND r.rolname=incident.app_role)
    OR (SELECT count(*) FROM pg_roles WHERE rolname IN(incident.app_role,incident.service_role))<>2 THEN
    RAISE EXCEPTION 'recovery stored role/database boundary mismatch' USING ERRCODE='42501';
  END IF;
  EXECUTE format('ALTER ROLE %I %s',incident.app_role,CASE WHEN admit THEN 'LOGIN' ELSE 'NOLOGIN' END);
  EXECUTE format('ALTER ROLE %I %s',incident.service_role,CASE WHEN admit THEN 'LOGIN' ELSE 'NOLOGIN' END);
  IF NOT admit THEN
    FOR child IN SELECT * FROM cogni_control.database_cell_replay_roles WHERE node_id=incident.node_id AND environment=incident.environment LOOP
      IF child.database_name<>incident.database_name OR child.role_name<>'replay_'||suffix THEN
        RAISE EXCEPTION 'registered replay role escaped node namespace' USING ERRCODE='42501';
      END IF;
      EXECUTE format('ALTER ROLE %I NOLOGIN',child.role_name);
    END LOOP;
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND (
      usename IN(incident.app_role,incident.service_role) OR usename IN(
        SELECT role_name FROM cogni_control.database_cell_replay_roles WHERE node_id=incident.node_id AND environment=incident.environment));
  END IF;
END
$function$;

CREATE FUNCTION public.database_cell_control_qualification(target_node uuid,target_env text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
DECLARE a cogni_control.database_cell_admissions; functions jsonb;
BEGIN
  SELECT * INTO STRICT a FROM cogni_control.database_cell_admissions WHERE node_id=target_node AND environment=target_env;
  IF current_database()<>'postgres' OR session_user<>a.probe_role THEN RAISE EXCEPTION 'qualification requires exact readonly probe identity' USING ERRCODE='42501'; END IF;
  PERFORM cogni_control.assert_system(a.database_system_identifier);
  SELECT jsonb_agg(jsonb_build_object('signature',signature,'definitionSha256',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),
      'owner',pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,
      'publicCanExecute',EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'),
      'probeCanExecute',has_function_privilege(a.probe_role,p.oid,'EXECUTE'),
      'actuatorCanExecute',has_function_privilege('database_reliability_actuator',p.oid,'EXECUTE'),
      'readmitterCanExecute',has_function_privilege('database_reliability_readmitter',p.oid,'EXECUTE'),
      'searchPath',(SELECT substr(c,13) FROM unnest(p.proconfig)c WHERE c LIKE 'search_path=%')) ORDER BY signature)
    INTO functions FROM unnest(ARRAY['cogni_control.require_actor(text)','cogni_control.assert_system(text)','cogni_control.lock_current(uuid,text)','cogni_control.receipt(cogni_control.database_recoveries)','cogni_control.apply_roles(cogni_control.database_recoveries,boolean)','public.contain_database_incident(uuid,text,text,text,text,text,text,text,text)','public.begin_database_recovery(uuid,text,text,text,text,text,text)','public.complete_database_recovery(uuid,text,text,text,text)','public.recontain_database_recovery(uuid,text,text,text)','public.list_database_recoveries()','public.database_recovery_watchdog_tick(text,text)','public.database_cell_pressure(uuid,text)','public.database_cell_control_qualification(uuid,text)','public.import_database_cell_admission(jsonb)','public.register_database_cell_replay(uuid,text,text,text,integer,text)'])signature LEFT JOIN pg_proc p ON p.oid=to_regprocedure(signature);
  RETURN jsonb_build_object('version',1,'nodeId',a.node_id,'nodeSlug',a.node_slug,'environment',a.environment,
    'controlDatabaseName',current_database(),'databaseName',a.database_name,'systemIdentifier',a.database_system_identifier,
    'allocationReceiptId',a.allocation_receipt_id,'dseq',a.dseq,'providerAccount',a.provider_account,
    'reviewedSourceSha',a.reviewed_control_source_sha,'migrationManifestSha256',a.migration_manifest_sha256,
    'installedAt',a.installed_at,'observedAt',clock_timestamp(),'requiredFunctions',functions,
    'admission',jsonb_build_object('manualPacketSha256',a.manual_packet_sha256,'readmissionReceiptSha256',a.readmission_receipt_sha256,
      'admittedAt',a.admitted_at,'importedAt',a.imported_at,'executionActor',a.execution_actor,'approvalAuthority',a.approval_authority));
END
$function$;
ALTER FUNCTION cogni_control.require_actor(text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION cogni_control.require_actor(text) FROM PUBLIC;
ALTER FUNCTION cogni_control.assert_system(text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION cogni_control.assert_system(text) FROM PUBLIC;
ALTER FUNCTION cogni_control.lock_current(uuid,text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION cogni_control.lock_current(uuid,text) FROM PUBLIC;
ALTER FUNCTION cogni_control.receipt(cogni_control.database_recoveries) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION cogni_control.receipt(cogni_control.database_recoveries) FROM PUBLIC;
ALTER FUNCTION cogni_control.apply_roles(cogni_control.database_recoveries,boolean) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION cogni_control.apply_roles(cogni_control.database_recoveries,boolean) FROM PUBLIC;
ALTER FUNCTION public.contain_database_incident(uuid,text,text,text,text,text,text,text,text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.contain_database_incident(uuid,text,text,text,text,text,text,text,text) FROM PUBLIC;
ALTER FUNCTION public.begin_database_recovery(uuid,text,text,text,text,text,text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.begin_database_recovery(uuid,text,text,text,text,text,text) FROM PUBLIC;
ALTER FUNCTION public.complete_database_recovery(uuid,text,text,text,text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.complete_database_recovery(uuid,text,text,text,text) FROM PUBLIC;
ALTER FUNCTION public.recontain_database_recovery(uuid,text,text,text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.recontain_database_recovery(uuid,text,text,text) FROM PUBLIC;
ALTER FUNCTION public.list_database_recoveries() SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.list_database_recoveries() FROM PUBLIC;
ALTER FUNCTION public.database_recovery_watchdog_tick(text,text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.database_recovery_watchdog_tick(text,text) FROM PUBLIC;
ALTER FUNCTION public.database_cell_pressure(uuid,text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.database_cell_pressure(uuid,text) FROM PUBLIC;
ALTER FUNCTION public.database_cell_control_qualification(uuid,text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.database_cell_control_qualification(uuid,text) FROM PUBLIC;
ALTER FUNCTION public.import_database_cell_admission(jsonb) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.import_database_cell_admission(jsonb) FROM PUBLIC;
ALTER FUNCTION public.register_database_cell_replay(uuid,text,text,text,integer,text) SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.register_database_cell_replay(uuid,text,text,text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.database_cell_pressure(uuid,text),public.database_cell_control_qualification(uuid,text),
 public.import_database_cell_admission(jsonb),public.register_database_cell_replay(uuid,text,text,text,integer,text)
 FROM database_reliability_actuator,database_reliability_readmitter;
GRANT EXECUTE ON FUNCTION public.database_cell_pressure(uuid,text) TO database_reliability_actuator;
-- Exact probe CONNECT + EXECUTE grant is per-node, after the root-owned admission import.
-- begin_database_recovery stays revoked until independent native watchdog qualification.

CREATE OR REPLACE FUNCTION public.contain_database_incident(
  target_node uuid, target_slug text, target_env text, target_incident text,
  target_actor text, target_reason text, target_sha text, target_system text, target_database text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE incident cogni_control.database_recoveries; role_suffix text; base_database text;
BEGIN
  PERFORM cogni_control.require_actor('actuator');
  PERFORM cogni_control.assert_system(target_system);
  IF NOT EXISTS(SELECT 1 FROM cogni_control.database_cell_admissions WHERE node_id=target_node AND node_slug=target_slug
    AND environment=target_env AND target_build_sha=target_sha AND database_system_identifier=target_system AND database_name=target_database) THEN
    RAISE EXCEPTION 'dedicated containment escaped imported owned-cell identity' USING ERRCODE='42501';
  END IF;
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
