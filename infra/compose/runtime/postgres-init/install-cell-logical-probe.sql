-- Explicit owned-cell logical helper; NOT an application migration or automatic provisioning step.
-- psql parameters: expected_system_identifier, database_name, probe_role, app_role, service_role.
-- Installer qualification must authenticate these exact parameters against the immutable manual packet.
\set ON_ERROR_STOP on
BEGIN;
SELECT current_user = 'postgres' AND session_user = 'postgres'
  AND current_database() = :'database_name'
  AND :'database_name' ~ '^cogni_[a-z0-9_]+$'
  AND :'probe_role' = 'probe_' || substr(:'database_name',7)
  AND :'app_role' = 'app_' || substr(:'database_name',7)
  AND :'service_role' = 'service_' || substr(:'database_name',7)
  AND (SELECT system_identifier::text FROM pg_control_system()) = :'expected_system_identifier' AS qualified \gset
\if :qualified
\else
  SELECT 1/0;
\endif
SELECT format($ddl$
CREATE OR REPLACE FUNCTION public.database_recovery_probe() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
DECLARE role_count bigint; can_login boolean; no_login boolean; isolated boolean; probe_oid oid;
BEGIN
  IF session_user <> %1$L OR current_database() <> %2$L
    OR (SELECT system_identifier::text FROM pg_control_system()) <> %5$L THEN
    RAISE EXCEPTION 'logical probe identity mismatch' USING ERRCODE='42501';
  END IF;
  SELECT oid INTO probe_oid FROM pg_roles WHERE rolname=%1$L AND rolcanlogin AND NOT rolsuper
    AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit BETWEEN 1 AND 2;
  isolated := probe_oid IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=probe_oid)
    AND NOT has_schema_privilege(%1$L,'public','CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
      AND c.relkind IN('r','p','v','m','f') AND has_table_privilege(%1$L,c.oid,'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
      AND c.relkind='S' AND has_sequence_privilege(%1$L,c.oid,'USAGE,UPDATE'))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN('pg_catalog','information_schema')
      AND p.oid<>'public.database_recovery_probe()'::regprocedure AND has_function_privilege(%1$L,p.oid,'EXECUTE'));
  IF NOT isolated THEN RAISE EXCEPTION 'logical probe effective privilege is not isolated' USING ERRCODE='42501'; END IF;
  SELECT count(*),bool_and(rolcanlogin),bool_and(NOT rolcanlogin) INTO role_count,can_login,no_login
    FROM pg_roles WHERE rolname IN(%3$L,%4$L);
  IF role_count<>2 THEN RAISE EXCEPTION 'logical probe runtime pair missing'; END IF;
  RETURN jsonb_build_object('database',current_database(),'role',session_user,
    'systemTenantExists',EXISTS(SELECT 1 FROM public.billing_accounts WHERE id='00000000-0000-4000-b000-000000000000' AND is_system_tenant),
    'serverAddress',inet_server_addr()::text,'serverPort',inet_server_port(),
    'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
    'appRolesCanLogin',can_login,'runtimeRolesPresent',true,'runtimeRolesNoLogin',no_login,
    'activeRuntimeSessions',(SELECT count(*) FROM pg_stat_activity WHERE usename IN(%3$L,%4$L,'replay_'||substr(%2$L,7))),
    'observedAt',clock_timestamp(),'probeRoleIsolated',isolated,
    'logicalProbeFunction',(SELECT jsonb_build_object('signature','public.database_recovery_probe()',
      'definitionSha256',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),
      'owner',pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,
      'publicCanExecute',EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'),
      'probeCanExecute',has_function_privilege(%1$L,p.oid,'EXECUTE'),
      'searchPath',(SELECT substr(c,13) FROM unnest(p.proconfig)c WHERE c LIKE 'search_path=%%'))
      FROM pg_proc p WHERE p.oid='public.database_recovery_probe()'::regprocedure));
END
$function$;
$ddl$, :'probe_role', :'database_name', :'app_role', :'service_role', :'expected_system_identifier') \gexec
ALTER FUNCTION public.database_recovery_probe() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.database_recovery_probe() FROM PUBLIC;
SELECT format('GRANT EXECUTE ON FUNCTION public.database_recovery_probe() TO %I', :'probe_role') \gexec
COMMIT;
