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
stop_postgres() {
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

wait "$postgres_pid"
