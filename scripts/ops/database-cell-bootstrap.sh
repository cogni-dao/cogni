#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Purpose: Start a scoped persistent PostgreSQL cell with verified TLS and fences.
# Scope: Private Akash actuator bootstrap; exact reviewed native provisioning SQL.
# Invariants: No plaintext TCP; new runtime roles never LOGIN; restart preserves admission.
set -euo pipefail
umask 077

: "${DATABASE_CELL_TLS_CERTIFICATE:?private cell TLS certificate required}"
: "${DATABASE_CELL_TLS_PRIVATE_KEY:?private cell TLS key required}"
: "${POSTGRES_ROOT_PASSWORD:?private cell root password required}"
: "${COGNI_NODE_DBS:?explicit cell database scopes required}"
: "${DATABASE_CELL_SOURCE_SHA:?reviewed cell bootstrap source required}"
: "${DATABASE_CELL_NODE_ID:?canonical cell node UUID required}"
: "${DATABASE_CELL_NODE_SLUG:?canonical cell node slug required}"
[[ "$DATABASE_CELL_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$DATABASE_CELL_NODE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 2
[[ "$DATABASE_CELL_NODE_SLUG" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || exit 2
[[ "$COGNI_NODE_DBS" =~ ^cogni_[a-z0-9_]+(,cogni_[a-z0-9_]+)*$ ]] || exit 2
export POSTGRES_USER="${POSTGRES_ROOT_USER:-postgres}"
export POSTGRES_PASSWORD="$POSTGRES_ROOT_PASSWORD"
[[ "$POSTGRES_USER" =~ ^[a-z][a-z0-9_]*$ ]] || exit 2

install -d -m 0755 /run/database-cell
printf '%s\n' "$DATABASE_CELL_TLS_CERTIFICATE" > /run/database-cell/server.crt
printf '%s\n' "$DATABASE_CELL_TLS_PRIVATE_KEY" > /run/database-cell/server.key
chmod 0600 /run/database-cell/server.key
chown -R postgres:postgres /run/database-cell

marker="${PGDATA:-/var/lib/postgresql/data}/cogni-cell-initial-fence-v1"
hba=/run/database-cell/pg_hba.conf
write_hba() {
  {
    printf '%s\n' 'local all all trust' 'hostnossl all all all reject'
    if [[ "$1" == bootstrap ]]; then
      printf '%s\n' 'hostssl all all 127.0.0.1/32 scram-sha-256'
      printf '%s\n' 'hostssl all all all reject'
    else
      printf '%s\n' 'hostssl all all all scram-sha-256'
    fi
  } > "$hba"
  chmod 0600 "$hba"
  chown postgres:postgres "$hba"
}
[[ -f "$marker" ]] && write_hba qualified || write_hba bootstrap
export PGSSLMODE=verify-ca PGSSLROOTCERT=/run/database-cell/server.crt

# The existing provider initializer remains PID-managed here. An initialization
# failure stops this process; it never leaves an unqualified database serving.
docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file=/run/database-cell/server.crt \
  -c ssl_key_file=/run/database-cell/server.key \
  -c hba_file="$hba" \
  -c max_connections=64 \
  -c shared_buffers="${DATABASE_CELL_SHARED_BUFFERS:-2GB}" \
  -c "cogni.cell_source_sha=$DATABASE_CELL_SOURCE_SHA" &
postgres_pid=$!
health_pid=""
stop_postgres() {
  if [[ -n "$health_pid" ]]; then
    kill -TERM "$health_pid" 2>/dev/null || true
    wait "$health_pid" 2>/dev/null || true
  fi
  kill -TERM "$postgres_pid" 2>/dev/null || true
  wait "$postgres_pid" 2>/dev/null || true
}
trap stop_postgres EXIT INT TERM

ready=0
for attempt in {1..60}; do
  kill -0 "$postgres_pid" 2>/dev/null || exit 1
  if pg_isready -h 127.0.0.1 -p 5432 -U "${POSTGRES_ROOT_USER:-postgres}" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || exit 1

# A first lease starts fenced. Recurring reconciliation preserves role LOGIN
# state, including a later properly authorized admission. The marker lives on
# the persistent data volume, so process replacement cannot recreate admission.
IFS=',' read -r -a databases <<< "$COGNI_NODE_DBS"
for database in "${databases[@]}"; do
    suffix="${database#cogni_}"
    PGPASSWORD="$POSTGRES_ROOT_PASSWORD" psql -h 127.0.0.1 -p 5432 \
      -U "${POSTGRES_ROOT_USER:-postgres}" -d postgres -Xqv ON_ERROR_STOP=1 \
      -v app_role="app_${suffix}" -v service_role="service_${suffix}" <<'SQL'
SELECT format('CREATE ROLE %I NOLOGIN', :'app_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec
SELECT format('CREATE ROLE %I NOLOGIN', :'service_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'service_role') \gexec
SQL
  if [[ ! -f "$marker" ]]; then
    PGPASSWORD="$POSTGRES_ROOT_PASSWORD" psql -h 127.0.0.1 -p 5432 \
      -U "$POSTGRES_USER" -d postgres -Xqv ON_ERROR_STOP=1 \
      -v app_role="app_${suffix}" -v service_role="service_${suffix}" <<'SQL'
ALTER ROLE :"app_role" NOLOGIN;
ALTER ROLE :"service_role" NOLOGIN;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE usename IN (:'app_role', :'service_role') AND pid <> pg_backend_pid();
SQL
  fi
done
for index in "${!databases[@]}"; do
  # Indexed private-kit fields permit distinct passwords and budgets per logical
  # lane on one physical allocation. The singleton fixture keeps ordinary env.
  if [[ "${DATABASE_CELL_INDEXED_LANES:-0}" == 1 ]]; then
    for key in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD APP_DB_MIGRATION_PASSWORD \
      DATABASE_RECOVERY_PROBE_PASSWORD DATABASE_CELL_BACKUP_ROLE DATABASE_CELL_BACKUP_PASSWORD DB_BUDGET_PROFILE \
      DB_APP_CONNECTION_LIMIT DB_APP_STATEMENT_TIMEOUT_MS \
      DB_SERVICE_CONNECTION_LIMIT DB_SERVICE_STATEMENT_TIMEOUT_MS \
      DB_LOCK_TIMEOUT_MS DB_IDLE_IN_TRANSACTION_TIMEOUT_MS \
      DB_TEMP_FILE_LIMIT_MIB DB_WORK_MEM_MIB; do
      indexed="CELL_LANE_${index}_${key}"
      export "$key=${!indexed:?missing private logical lane field}"
    done
  fi
  COGNI_NODE_DBS="${databases[$index]}" DB_HOST=127.0.0.1 bash /app/provision.sh
  suffix="${databases[$index]#cogni_}"
  [[ "${DATABASE_CELL_BACKUP_ROLE:?scoped backup role required}" == "backup_${suffix}" ]] || exit 2
  PGPASSWORD="$POSTGRES_ROOT_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" \
    -d "${databases[$index]}" -Xqv ON_ERROR_STOP=1 \
    -v backup_role="$DATABASE_CELL_BACKUP_ROLE" \
    -v app_role="app_${suffix}" -v service_role="service_${suffix}" -v migration_role="migration_${suffix}" \
    -v backup_password="${DATABASE_CELL_BACKUP_PASSWORD:?private backup password required}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'backup_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'backup_role') \gexec
ALTER ROLE :"backup_role" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS CONNECTION LIMIT 1;
ALTER ROLE :"backup_role" PASSWORD :'backup_password';
ALTER ROLE :"backup_role" SET default_transaction_read_only = on;
ALTER ROLE :"backup_role" SET statement_timeout = '780s';
ALTER ROLE :"backup_role" SET idle_in_transaction_session_timeout = '30s';
SELECT format('REVOKE %I FROM %I', granted.rolname, :'backup_role')
FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid = membership.roleid
WHERE membership.member = :'backup_role'::regrole \gexec
-- Restored objects are created under their canonical node owner. Defaults cover
-- those new objects; this same qualified restart also reconciles existing ACLs.
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT ON TABLES TO %I', rolname, :'backup_role')
FROM pg_roles WHERE rolname IN (:'app_role', :'service_role', :'migration_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT ON SEQUENCES TO %I', rolname, :'backup_role')
FROM pg_roles WHERE rolname IN (:'app_role', :'service_role', :'migration_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE ON SCHEMAS TO %I', rolname, :'backup_role')
FROM pg_roles WHERE rolname IN (:'app_role', :'service_role', :'migration_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA %I TO %I', nspname, :'backup_role')
FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','cogni_control') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', nspname, :'backup_role')
FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','cogni_control') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' \gexec
SELECT format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', nspname, :'backup_role')
FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','cogni_control') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' \gexec
-- PUBLIC drift must fail qualification, rather than changing application ACLs.
SELECT CASE WHEN EXISTS (
 SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
 AND has_schema_privilege(:'backup_role', oid, 'CREATE')
) OR EXISTS (
 SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
 AND c.relkind IN ('r','p','v','m','f')
 AND has_table_privilege(:'backup_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
) OR EXISTS (
 SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
 AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(:'backup_role',c.oid,'USAGE,UPDATE') ELSE false END
) OR EXISTS (
 SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
 AND p.prosecdef AND p.oid IS DISTINCT FROM to_regprocedure('public.database_backup_identity()')
 AND has_function_privilege(:'backup_role',p.oid,'EXECUTE')
) THEN 'backup_role_privilege_invalid' ELSE '1' END::integer;
SQL
done

if [[ ! -f "$marker" ]]; then
  cell_system="$(PGPASSWORD="$POSTGRES_ROOT_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" \
    -d postgres -XAtv ON_ERROR_STOP=1 -c 'SELECT system_identifier::text FROM pg_control_system()')"
  [[ "$cell_system" =~ ^[0-9]+$ ]] || exit 1
  for index in "${!databases[@]}"; do
    if [[ "${DATABASE_CELL_INDEXED_LANES:-0}" == 1 ]]; then
      environment_key="CELL_LANE_${index}_ENVIRONMENT"
      target_key="CELL_LANE_${index}_TARGET_BUILD_SHA"
      initial_environment="${!environment_key:?logical environment required}"
      initial_target_sha="${!target_key:?logical deployed target SHA required}"
    else
      initial_environment="${DATABASE_CELL_INITIAL_ENVIRONMENT:?initial environment required}"
      initial_target_sha="${DATABASE_CELL_TARGET_BUILD_SHA:?initial target SHA required}"
    fi
    [[ "$initial_environment" =~ ^(candidate-a|preview|production)$ && "$initial_target_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
    incident="reliability.v1:${initial_environment}:${DATABASE_CELL_NODE_ID}:prestage-${cell_system}"
    PGPASSWORD="${DATABASE_RELIABILITY_PASSWORD:?private cell control credential required}" \
      psql -h 127.0.0.1 -U database_reliability_actuator -d postgres -XqAtv ON_ERROR_STOP=1 \
      -v node_id="$DATABASE_CELL_NODE_ID" -v slug="$DATABASE_CELL_NODE_SLUG" \
      -v environment="$initial_environment" -v incident="$incident" \
      -v target_sha="$initial_target_sha" -v system_id="$cell_system" -v database="${databases[$index]}" <<'SQL'
SELECT public.contain_database_incident(:'node_id'::uuid, :'slug', :'environment', :'incident',
  'system:database-cell-bootstrap', 'prestage_initial_fence', :'target_sha', :'system_id', :'database');
SQL
  done
fi

# Extend only the provider cell's exact provisioner probe. Its base still owns
# session identity, effective privilege isolation, role state and native system
# identity. The private helper is callable only by the root-owned wrapper.
wrapper_body="$(cat <<'PLPGSQL'
DECLARE
  proof jsonb;
  health jsonb;
  observed timestamptz;
  metric text;
BEGIN
  proof := cogni_control.database_recovery_probe_base();
  IF (pg_stat_file('/run/database-cell/health.json')).size > 4096 THEN
    RAISE EXCEPTION 'cell health snapshot oversized' USING ERRCODE = '55000';
  END IF;
  health := pg_read_file('/run/database-cell/health.json', 0, 4096)::jsonb;
  IF jsonb_typeof(health) IS DISTINCT FROM 'object'
    OR health->>'scope' IS DISTINCT FROM 'dedicated-cell'
    OR health->>'version' IS DISTINCT FROM '1'
    OR health->>'sourceSha' IS DISTINCT FROM '__CELL_SOURCE_SHA__' THEN
    RAISE EXCEPTION 'cell health snapshot identity invalid' USING ERRCODE = '55000';
  END IF;
  observed := (health->>'observedAt')::timestamptz;
  IF observed IS NULL OR observed > clock_timestamp()
    OR observed < clock_timestamp() - interval '5 seconds' THEN
    RAISE EXCEPTION 'cell health snapshot stale' USING ERRCODE = '55000';
  END IF;
  FOREACH metric IN ARRAY ARRAY['ioPressurePct','connectionPct','memoryHeadroomPct','diskHeadroomPct'] LOOP
    IF jsonb_typeof(health->metric) IS DISTINCT FROM 'number'
      OR (health->>metric)::numeric NOT BETWEEN 0 AND 100 THEN
      RAISE EXCEPTION 'cell health snapshot incomplete' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  RETURN proof || jsonb_build_object('cellSubstrate',
    health || jsonb_build_object('systemIdentifier', proof->>'systemIdentifier'));
END
PLPGSQL
)"
wrapper_body="${wrapper_body//__CELL_SOURCE_SHA__/$DATABASE_CELL_SOURCE_SHA}"
for database in "${databases[@]}"; do
  suffix="${database#cogni_}"
  PGPASSWORD="$POSTGRES_ROOT_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" \
    -d "$database" -Xqv ON_ERROR_STOP=1 -v probe_role="probe_${suffix}" -v wrapper_body="$wrapper_body" <<'SQL'
CREATE SCHEMA IF NOT EXISTS cogni_control;
REVOKE ALL ON SCHEMA cogni_control FROM PUBLIC;
SELECT regexp_replace(pg_get_functiondef('public.database_recovery_probe()'::regprocedure),
  '^CREATE OR REPLACE FUNCTION public[.]database_recovery_probe[(][)]',
  'CREATE OR REPLACE FUNCTION cogni_control.database_recovery_probe_base()') \gexec
REVOKE ALL ON FUNCTION cogni_control.database_recovery_probe_base() FROM PUBLIC;
REVOKE ALL ON FUNCTION cogni_control.database_recovery_probe_base() FROM :"probe_role";
CREATE OR REPLACE FUNCTION public.database_recovery_probe() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS :'wrapper_body';
REVOKE ALL ON FUNCTION public.database_recovery_probe() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.database_recovery_probe() TO :"probe_role";
SQL
done
# The archive can contain the source probe definition and objects created after
# initial bootstrap. A fixed root-only command repairs those exact cell helpers
# and backup ACLs after restore; an idempotent SDL UPDATE is not that command.
qualifier_body="$(cat <<'PLPGSQL'
DECLARE
  backup_role name := '__BACKUP_ROLE__';
  owner_role name;
  namespace record;
BEGIN
  IF session_user <> '__ROOT_ROLE__' THEN
    RAISE EXCEPTION 'cell qualification requires private cell root' USING ERRCODE='42501';
  END IF;
  __PROBE_REPAIR__
  FOREACH owner_role IN ARRAY ARRAY['__APP_ROLE__','__SERVICE_ROLE__','__MIGRATION_ROLE__'] LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT ON TABLES TO %I',owner_role,backup_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT ON SEQUENCES TO %I',owner_role,backup_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE ON SCHEMAS TO %I',owner_role,backup_role);
  END LOOP;
  FOR namespace IN SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','cogni_control') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',namespace.nspname,backup_role);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I',namespace.nspname,backup_role);
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I',namespace.nspname,backup_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' AND has_schema_privilege(backup_role,oid,'CREATE'))
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(backup_role,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(backup_role,c.oid,'USAGE,UPDATE') ELSE false END)
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND p.prosecdef AND p.oid <> 'public.database_backup_identity()'::regprocedure AND has_function_privilege(backup_role,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'backup role effective privilege drift' USING ERRCODE='42501';
  END IF;
  RETURN cogni_control.database_backup_identity_root();
END
PLPGSQL
)"
backup_identity_body="$(cat <<'PLPGSQL'
DECLARE
  scoped_role name := '__BACKUP_ROLE__';
  isolated boolean;
  readable boolean;
BEGIN
  IF session_user <> scoped_role THEN
    RAISE EXCEPTION 'backup identity requires scoped reader' USING ERRCODE='42501';
  END IF;
  SELECT rolcanlogin AND rolbypassrls AND NOT rolsuper AND NOT rolcreatedb
    AND NOT rolcreaterole AND NOT rolreplication AND NOT rolinherit AND rolconnlimit=1
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=role.oid)
    INTO isolated FROM pg_roles role WHERE rolname=scoped_role;
  isolated := isolated AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' AND has_schema_privilege(scoped_role,oid,'CREATE'))
    AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(scoped_role,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(scoped_role,c.oid,'USAGE,UPDATE') ELSE false END)
    AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND p.prosecdef AND p.oid <> 'public.database_backup_identity()'::regprocedure AND has_function_privilege(scoped_role,p.oid,'EXECUTE'));
  SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
    AND ((c.relkind IN ('r','p','v','m','f') AND NOT has_table_privilege(scoped_role,c.oid,'SELECT'))
      OR CASE WHEN c.relkind='S' THEN NOT has_sequence_privilege(scoped_role,c.oid,'SELECT') ELSE false END
      OR NOT has_schema_privilege(scoped_role,n.oid,'USAGE'))) INTO readable;
  RETURN cogni_control.database_backup_identity_root() || jsonb_build_object('role',session_user,
    'backupRoleIsolated',coalesce(isolated,false),'allTablesReadable',coalesce(readable,false));
END
PLPGSQL
)"
for database in "${databases[@]}"; do
  suffix="${database#cogni_}"
  body="${qualifier_body//__BACKUP_ROLE__/backup_${suffix}}"
  body="${body//__ROOT_ROLE__/$POSTGRES_USER}"
  body="${body//__APP_ROLE__/app_${suffix}}"
  body="${body//__SERVICE_ROLE__/service_${suffix}}"
  body="${body//__MIGRATION_ROLE__/migration_${suffix}}"
  identity_body="${backup_identity_body//__BACKUP_ROLE__/backup_${suffix}}"
  PGPASSWORD="$POSTGRES_ROOT_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" \
    -d "$database" -Xqv ON_ERROR_STOP=1 -v backup_role="backup_${suffix}" -v probe_role="probe_${suffix}" -v qualifier_body="$body" -v identity_body="$identity_body" <<'SQL'
CREATE OR REPLACE FUNCTION cogni_control.database_backup_identity_root() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS
'SELECT jsonb_build_object(''databaseName'',current_database(),''systemIdentifier'',system_identifier::text) FROM pg_control_system()';
REVOKE ALL ON FUNCTION cogni_control.database_backup_identity_root() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.database_backup_identity() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS :'identity_body';
REVOKE ALL ON FUNCTION public.database_backup_identity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.database_backup_identity() TO :"backup_role";
SELECT replace(:'qualifier_body','__PROBE_REPAIR__',
  format('EXECUTE %L; EXECUTE %L; EXECUTE %L; REVOKE ALL ON FUNCTION cogni_control.database_recovery_probe_base() FROM PUBLIC; REVOKE ALL ON FUNCTION cogni_control.database_recovery_probe_base() FROM %I; REVOKE ALL ON FUNCTION public.database_recovery_probe() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.database_recovery_probe() TO %I; REVOKE ALL ON FUNCTION public.database_backup_identity() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.database_backup_identity() TO %I;',
  pg_get_functiondef('cogni_control.database_recovery_probe_base()'::regprocedure), pg_get_functiondef('public.database_recovery_probe()'::regprocedure), pg_get_functiondef('public.database_backup_identity()'::regprocedure), :'probe_role', :'probe_role', :'backup_role')) AS qualified_body \gset
CREATE OR REPLACE FUNCTION cogni_control.database_cell_qualify() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS :'qualified_body';
REVOKE ALL ON FUNCTION cogni_control.database_cell_qualify() FROM PUBLIC;
SELECT cogni_control.database_cell_qualify();
SQL
done
if [[ ! -f "$marker" ]]; then
  touch "$marker"
fi
write_hba qualified
PGPASSWORD="$POSTGRES_ROOT_PASSWORD" psql -h 127.0.0.1 -p 5432 \
  -U "$POSTGRES_USER" -d postgres -Xqv ON_ERROR_STOP=1 \
  -c 'SELECT pg_reload_conf();'

# The sampler belongs to this cell process. It never queries application rows
# and never substitutes host-wide/shared recordings for a bounded cell resource.
collect_health() {
  local observed memory_max memory_current inactive_file io_full disk_stat connections raw_memory_pct=null
  local memory_pct=null io_pct=null disk_pct=null connection_pct=null temporary
  observed="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  memory_max="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"
  memory_current="$(cat /sys/fs/cgroup/memory.current 2>/dev/null || true)"
  inactive_file="$(awk '$1 == "inactive_file" {print $2}' /sys/fs/cgroup/memory.stat 2>/dev/null || true)"
  if [[ "$memory_max" =~ ^[1-9][0-9]*$ && "$memory_current" =~ ^[0-9]+$ && "$inactive_file" =~ ^[0-9]+$ ]] &&
      [[ "$memory_current" -le "$memory_max" && "$inactive_file" -le "$memory_current" ]]; then
    memory_pct="$(awk -v maximum="$memory_max" -v current="$memory_current" -v inactive="$inactive_file" 'BEGIN { printf "%.6f", 100*(maximum-current+inactive)/maximum }')"
    raw_memory_pct="$(awk -v maximum="$memory_max" -v current="$memory_current" 'BEGIN { printf "%.6f", 100*(maximum-current)/maximum }')"
  fi
  # cAdvisor's own-cgroup working set discounts only inactive file cache. Keep
  # the raw observation privately for capacity proof without changing the ABI.
  temporary="$(mktemp /run/database-cell/memory-diagnostics.XXXXXX)"
  printf '{"observedAt":"%s","rawHeadroomPct":%s,"workingSetHeadroomPct":%s}\n' \
    "$observed" "$raw_memory_pct" "$memory_pct" > "$temporary"
  chown postgres:postgres "$temporary"
  chmod 0600 "$temporary"
  mv "$temporary" /run/database-cell/memory-diagnostics.json
  io_full="$(awk '$1 == "full" { for (i=2;i<=NF;i++) if ($i ~ /^avg60=/) {sub(/^avg60=/,"",$i); print $i} }' /sys/fs/cgroup/io.pressure 2>/dev/null || true)"
  if [[ "$io_full" =~ ^[0-9]+([.][0-9]+)?$ ]] &&
      awk -v value="$io_full" 'BEGIN {exit !(value>=0 && value<=100)}'; then
    io_pct="$io_full"
  fi
  disk_stat="$(df -PkT "${PGDATA:-/var/lib/postgresql/data}" 2>/dev/null | awk 'NR==2 && $2 != "overlay" && $2 != "tmpfs" && $3 > 0 && $5 >= 0 && $5 <= $3 {printf "%.6f",100*$5/$3}' || true)"
  [[ "$disk_stat" =~ ^[0-9]+([.][0-9]+)?$ ]] && disk_pct="$disk_stat"
  connections="$(PGPASSWORD="$POSTGRES_ROOT_PASSWORD" PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=1500' \
    timeout 2 psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -XAtv ON_ERROR_STOP=1 \
      -c "SELECT 100.0 * count(*) FILTER (WHERE backend_type = 'client backend') / current_setting('max_connections')::numeric FROM pg_stat_activity" 2>/dev/null || true)"
  if [[ "$connections" =~ ^[0-9]+([.][0-9]+)?$ ]] &&
      awk -v value="$connections" 'BEGIN {exit !(value>=0 && value<=100)}'; then
    connection_pct="$connections"
  fi
  temporary="$(mktemp /run/database-cell/health.XXXXXX)"
  printf '{"version":1,"scope":"dedicated-cell","sourceSha":"%s","observedAt":"%s","ioPressurePct":%s,"connectionPct":%s,"memoryHeadroomPct":%s,"diskHeadroomPct":%s}\n' \
    "$DATABASE_CELL_SOURCE_SHA" "$observed" "$io_pct" "$connection_pct" "$memory_pct" "$disk_pct" > "$temporary"
  chown postgres:postgres "$temporary"
  chmod 0600 "$temporary"
  mv "$temporary" /run/database-cell/health.json
}
collect_health
(
  while kill -0 "$postgres_pid" 2>/dev/null; do
    collect_health
    sleep 1
  done
) &
health_pid=$!

wait "$postgres_pid"
