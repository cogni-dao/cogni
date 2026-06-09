#!/bin/bash
set -euo pipefail

# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: infra/compose/postgres-init/provision.sh
# Purpose: Idempotent database and role provisioning for runtime stack.
# Scope: Executed by the db-provision service container; creates app role,
#   per-node databases (DB_PER_NODE), litellm database, and optional openfga database.
# Invariants:
#   DB_PER_NODE: Each node gets its own database on the shared Postgres server.
#   DB_IS_BOUNDARY: Database itself is the node boundary — no tenancy columns.
#   Computes per-node roles app_<node>/service_<node> from each cogni_<node> DB
#   name; requires only their passwords (APP_DB_PASSWORD/APP_DB_SERVICE_PASSWORD,
#   OpenBao-sourced). Validates identifier syntax.
# Side-effects: IO (psql commands); creates roles and databases in target Postgres instance.

# Configuration from Env
PG_HOST="${DB_HOST:-postgres}"
PG_PORT="${DB_PORT:-5432}"
PG_USER="${POSTGRES_ROOT_USER:-postgres}"
PG_PASS="${POSTGRES_ROOT_PASSWORD:-postgres}"

# Per-node databases (comma-separated). Required — no defaults.
APP_DBS="${COGNI_NODE_DBS:-}"
if [ -z "$APP_DBS" ]; then
  echo "❌ ERROR: COGNI_NODE_DBS is required (comma-separated list of database names)"
  exit 1
fi

# LiteLLM database (shared, root-owned — single instance serves all nodes)
LITELLM_DB="${LITELLM_DB_NAME:-}"
if [ -z "$LITELLM_DB" ]; then
  echo "❌ ERROR: LITELLM_DB_NAME is required"
  exit 1
fi

# OpenFGA database (shared, root-owned — single RBAC store server)
OPENFGA_DB="${OPENFGA_DB_NAME:-}"

# Per-node app credentials. The role NAMES are COMPUTED from the node
# (app_<node> / service_<node>); only the PASSWORDS are per-node OpenBao secrets,
# passed by the caller (reconcile-substrate reads cogni/<env>/<node> via the
# <env>-db-reader token). Roles are reconciled to these values every run —
# single source is OpenBao (Invariant 15); see provision_app_role below.
APP_PASS="${APP_DB_PASSWORD:-}"
APP_SERVICE_PASS="${APP_DB_SERVICE_PASSWORD:-}"
# Shared read-only role (env-level, NOT per-node): the Grafana datasource consumer.
# Superuser-derived password; created once outside the per-node loop.
APP_READONLY_USER="${APP_DB_READONLY_USER:-app_readonly}"
APP_READONLY_PASS="${APP_DB_READONLY_PASSWORD:-}"

if [ -z "$APP_PASS" ]; then
  echo "❌ ERROR: APP_DB_PASSWORD is required (per-node app role password from OpenBao)"
  exit 1
fi
if [ -z "$APP_SERVICE_PASS" ]; then
  echo "❌ ERROR: APP_DB_SERVICE_PASSWORD is required (per-node service role password from OpenBao)"
  exit 1
fi
# DRIFT GUARD (bug.5031): this readonly-password derivation —
# sha256('postgres-readonly:' + POSTGRES_ROOT_PASSWORD)[:32] — is duplicated in
# scripts/setup/provision-grafana-postgres-datasources.sh (the Grafana datasource
# consumer). The two MUST stay byte-identical; if you change one, change both.
if [ -z "$APP_READONLY_PASS" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    APP_READONLY_PASS=$(printf 'postgres-readonly:%s' "$PG_PASS" | sha256sum | cut -c1-32)
  elif command -v shasum >/dev/null 2>&1; then
    APP_READONLY_PASS=$(printf 'postgres-readonly:%s' "$PG_PASS" | shasum -a 256 | cut -c1-32)
  else
    echo "❌ ERROR: APP_DB_READONLY_PASSWORD is required when no SHA-256 utility is available"
    exit 1
  fi
fi

# Validate identifiers (strict allowlist: alphanumeric + underscore only).
# Per-node app_<node> / service_<node> names are computed + validated from the
# (already validated) node DB name inside provision_node_db.
if ! [[ "$APP_READONLY_USER" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "❌ ERROR: APP_DB_READONLY_USER contains invalid characters (allowed: a-zA-Z0-9_)"
  exit 1
fi
if ! [[ "$LITELLM_DB" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "❌ ERROR: LITELLM_DB_NAME contains invalid characters (allowed: a-zA-Z0-9_)"
  exit 1
fi
if [ -n "$OPENFGA_DB" ] && ! [[ "$OPENFGA_DB" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "❌ ERROR: OPENFGA_DB_NAME contains invalid characters (allowed: a-zA-Z0-9_)"
  exit 1
fi

# Helper: Run SQL as Superuser
function run_sql_as_root() {
  local db="$1"
  local sql="$2"
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$db" -v ON_ERROR_STOP=1 -c "$sql"
}

# Wait for Postgres with timeout (fail fast, not forever)
PG_TIMEOUT="${PG_TIMEOUT:-120}"
ELAPSED=0

echo "⏳ Waiting for Postgres at $PG_HOST:$PG_PORT (user: $PG_USER, timeout: ${PG_TIMEOUT}s)..."
until PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -c '\q' >/dev/null 2>&1; do
  if [ "$ELAPSED" -ge "$PG_TIMEOUT" ]; then
    echo ""
    echo "❌ ERROR: Timed out waiting for Postgres after ${PG_TIMEOUT}s"
    echo ""
    echo "=== Diagnostics ==="
    echo "Host: $PG_HOST"
    echo "Port: $PG_PORT"
    echo "User: $PG_USER"
    echo "Pass: [${#PG_PASS} chars]"
    echo ""
    echo "=== Network check ==="
    nc -zv "$PG_HOST" "$PG_PORT" 2>&1 || echo "(nc not available or connection refused)"
    echo ""
    echo "=== Auth check (last error) ==="
    PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -c '\q' 2>&1 || true
    exit 1
  fi
  echo "   ... waiting (${ELAPSED}s/${PG_TIMEOUT}s)"
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
echo "✅ Postgres is up."

echo "🔧 Starting Provisioning (Roles and Databases)..."

# ── Roles ──────────────────────────────────────────────────────────────────
# Per-node app_<node> / service_<node> roles are created in the node loop below
# from this node's OpenBao passwords. The read-only role is shared (env-level) and
# created once here.

# provision_app_role <role> <password> [opts]
#   Create the role if absent, then RECONCILE its password to <password> every run.
#   <password> MUST be the OpenBao-read value (the same value ESO syncs to the pod):
#   ALTERing to it can never diverge, and it is what makes rotation work. The
#   bug.5002 anti-fix is reconciling to a rendered .env value — NEVER do that; the
#   caller passes the OpenBao read here.
provision_app_role() {
  local role="$1" pass="$2" opts="${3:-}"
  if ! [[ "$role" =~ ^[a-zA-Z0-9_]+$ ]]; then
    echo "❌ ERROR: computed role name '$role' is invalid (allowed: a-zA-Z0-9_)"; exit 1
  fi
  local exists
  exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_roles WHERE rolname = '$role'" | grep -c 1 || true)
  if [ "$exists" -eq 0 ]; then
    echo "   -> Creating role '$role'${opts:+ ($opts)}..."
    PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -v ON_ERROR_STOP=1 \
      -v pw="$pass" <<SQL
CREATE ROLE "$role" WITH LOGIN PASSWORD :'pw' $opts;
SQL
  else
    echo "   -> Reconciling password for role '$role' to its OpenBao value..."
    PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -v ON_ERROR_STOP=1 \
      -v pw="$pass" <<SQL
ALTER ROLE "$role" WITH LOGIN PASSWORD :'pw';
SQL
  fi
}

# Shared read-only role (env-level; superuser-derived password; BYPASSRLS support
# reads for the Grafana datasource). Created once, outside the per-node loop.
echo "🔧 Reconciling shared read-only role '$APP_READONLY_USER'..."
provision_app_role "$APP_READONLY_USER" "$APP_READONLY_PASS" "BYPASSRLS"
PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -v ON_ERROR_STOP=1 <<SQL
ALTER ROLE "$APP_READONLY_USER" SET default_transaction_read_only = on;
ALTER ROLE "$APP_READONLY_USER" SET statement_timeout = '30s';
SQL

# NOTE: this provisioner is steady-state only — it creates fresh DBs owned by
# app_<node> from CREATE. It deliberately does NOT migrate ownership of an
# already-app_user-owned DB: that is one-shot cutover work, not recurring-flight
# code. candidate-a (throwaway) takes a REPROVISION; a data-preserving env takes a
# one-shot, audited REASSIGN OWNED migration run once and removed. See
# docs/guides/vm-secrets-repair.md.

# ── Per-Node Database Provisioning (DB_PER_NODE) ──────────────────────────
# Each node gets its own database AND its own roles. The database IS the node
# boundary; the per-node app_<node> role is the per-node credential boundary.

function provision_node_db() {
  local db_name="$1"

  # Validate identifier
  if ! [[ "$db_name" =~ ^[a-zA-Z0-9_]+$ ]]; then
    echo "❌ ERROR: Database name '$db_name' contains invalid characters (allowed: a-zA-Z0-9_)"
    exit 1
  fi

  # Per-node role names are computed from the node (db cogni_<node> → app_<node>).
  local node="${db_name#cogni_}"
  local app_role="app_${node}"
  local svc_role="service_${node}"

  echo "🔧 Provisioning node '$node' (db '$db_name', roles '$app_role'/'$svc_role')..."

  # Per-node roles — passwords reconciled to this node's OpenBao values.
  # app_role is RLS-SUBJECT (no BYPASSRLS): FORCE ROW LEVEL SECURITY on user
  # tables keeps the owning role tenant-isolated. svc_role is BYPASSRLS (workers).
  provision_app_role "$app_role" "$APP_PASS"
  provision_app_role "$svc_role" "$APP_SERVICE_PASS" "BYPASSRLS"

  # Create database (idempotent), owned by the per-node app role.
  local db_exists
  db_exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_database WHERE datname = '$db_name'" | grep -c 1 || true)
  if [ "$db_exists" -eq 0 ]; then
    echo "   -> Creating database '$db_name' with owner '$app_role'..."
    run_sql_as_root "postgres" "CREATE DATABASE \"$db_name\" OWNER \"$app_role\";"
  else
    echo "   -> Database '$db_name' already exists. Ensuring ownership '$app_role'..."
    run_sql_as_root "postgres" "ALTER DATABASE \"$db_name\" OWNER TO \"$app_role\";"
    run_sql_as_root "postgres" "GRANT CONNECT, CREATE, TEMP ON DATABASE \"$db_name\" TO \"$app_role\";"
  fi

  # App role hardening (owner; tenant-isolated under FORCE RLS from migrations).
  echo "   -> Applying grants on '$db_name'..."
  run_sql_as_root "$db_name" "ALTER SCHEMA public OWNER TO \"$app_role\";"
  run_sql_as_root "$db_name" "GRANT USAGE, CREATE ON SCHEMA public TO \"$app_role\";"
  run_sql_as_root "$db_name" "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"$app_role\";"
  run_sql_as_root "$db_name" "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"$app_role\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$app_role\" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \"$app_role\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$app_role\" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO \"$app_role\";"

  # Service role grants — includes CREATE for migrations (drizzle-kit needs to create schemas + tables)
  run_sql_as_root "$db_name" "GRANT CONNECT, CREATE ON DATABASE \"$db_name\" TO \"$svc_role\";"
  run_sql_as_root "$db_name" "GRANT USAGE, CREATE ON SCHEMA public TO \"$svc_role\";"
  run_sql_as_root "$db_name" "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"$svc_role\";"
  run_sql_as_root "$db_name" "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"$svc_role\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$app_role\" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \"$svc_role\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$app_role\" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO \"$svc_role\";"

  # Shared read-only role grants — Grafana/agent support reads across tenants, writes denied by SQL privileges.
  run_sql_as_root "$db_name" "GRANT CONNECT ON DATABASE \"$db_name\" TO \"$APP_READONLY_USER\";"
  run_sql_as_root "$db_name" "GRANT USAGE ON SCHEMA public TO \"$APP_READONLY_USER\";"
  run_sql_as_root "$db_name" "GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"$APP_READONLY_USER\";"
  run_sql_as_root "$db_name" "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"$APP_READONLY_USER\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$app_role\" IN SCHEMA public GRANT SELECT ON TABLES TO \"$APP_READONLY_USER\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$app_role\" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO \"$APP_READONLY_USER\";"

  echo "   ✅ Node '$node' provisioned (db '$db_name')."
}

# Per-node roles need per-node passwords; one APP_DB_PASSWORD serves exactly one
# node. The caller (reconcile-substrate, <env>-db-reader) invokes db-provision
# once per node. Guard against a multi-node invocation that would silently give
# every node the same password.
IFS=',' read -ra NODE_DBS <<< "$APP_DBS"
_trimmed=()
for db in "${NODE_DBS[@]}"; do
  db=$(echo "$db" | xargs)
  [ -n "$db" ] && _trimmed+=("$db")
done
NODE_DBS=("${_trimmed[@]}")
if [ "${#NODE_DBS[@]}" -ne 1 ]; then
  echo "❌ ERROR: per-node provisioning expects exactly one node DB in COGNI_NODE_DBS (got ${#NODE_DBS[@]}: '${APP_DBS}'). The caller invokes db-provision once per node."
  exit 1
fi
provision_node_db "${NODE_DBS[0]}"

# ── LiteLLM Database (shared, root-owned) ─────────────────────────────────
echo "🔧 Checking litellm database '$LITELLM_DB'..."
litellm_db_exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_database WHERE datname = '$LITELLM_DB'" | grep -c 1 || true)
if [ "$litellm_db_exists" -eq 0 ]; then
  echo "   -> Creating database '$LITELLM_DB'..."
  run_sql_as_root "postgres" "CREATE DATABASE \"$LITELLM_DB\";"
else
  echo "   -> Database '$LITELLM_DB' already exists."
fi

# ── OpenFGA Database (shared, root-owned) ─────────────────────────────────
if [ -n "$OPENFGA_DB" ]; then
  echo "🔧 Checking openfga database '$OPENFGA_DB'..."
  openfga_db_exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_database WHERE datname = '$OPENFGA_DB'" | grep -c 1 || true)
  if [ "$openfga_db_exists" -eq 0 ]; then
    echo "   -> Creating database '$OPENFGA_DB'..."
    run_sql_as_root "postgres" "CREATE DATABASE \"$OPENFGA_DB\";"
  else
    echo "   -> Database '$OPENFGA_DB' already exists."
  fi
else
  echo "   -> OPENFGA_DB_NAME not set; skipping openfga database provisioning."
fi

if [ -n "$OPENFGA_DB" ]; then
  echo "✅ Provisioning Complete (${#NODE_DBS[@]} node database(s) + litellm + openfga)."
else
  echo "✅ Provisioning Complete (${#NODE_DBS[@]} node database(s) + litellm)."
fi
