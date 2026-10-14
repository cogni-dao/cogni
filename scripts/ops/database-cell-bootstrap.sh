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
[[ "$DATABASE_CELL_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
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
      DATABASE_RECOVERY_PROBE_PASSWORD DB_BUDGET_PROFILE \
      DB_APP_CONNECTION_LIMIT DB_APP_STATEMENT_TIMEOUT_MS \
      DB_SERVICE_CONNECTION_LIMIT DB_SERVICE_STATEMENT_TIMEOUT_MS \
      DB_LOCK_TIMEOUT_MS DB_IDLE_IN_TRANSACTION_TIMEOUT_MS \
      DB_TEMP_FILE_LIMIT_MIB DB_WORK_MEM_MIB; do
      indexed="CELL_LANE_${index}_${key}"
      export "$key=${!indexed:?missing private logical lane field}"
    done
  fi
  COGNI_NODE_DBS="${databases[$index]}" DB_HOST=127.0.0.1 bash /app/provision.sh
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
  local observed memory_max memory_current io_full disk_stat connections
  local memory_pct=null io_pct=null disk_pct=null connection_pct=null temporary
  observed="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  memory_max="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"
  memory_current="$(cat /sys/fs/cgroup/memory.current 2>/dev/null || true)"
  if [[ "$memory_max" =~ ^[1-9][0-9]*$ && "$memory_current" =~ ^[0-9]+$ ]] &&
      [[ "$memory_current" -le "$memory_max" ]]; then
    memory_pct="$(awk -v maximum="$memory_max" -v current="$memory_current" 'BEGIN { printf "%.6f", 100*(maximum-current)/maximum }')"
  fi
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
