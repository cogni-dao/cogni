#!/bin/bash
set -euo pipefail

# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: infra/compose/postgres-init/provision.sh
# Purpose: Idempotent database and role provisioning for runtime stack.
# Scope: Executed by the db-provision service container; creates app role,
#   per-node databases (DB_PER_NODE), and litellm database.
# Invariants:
#   DB_PER_NODE: Each node gets its own database on the shared Postgres server.
#   DB_IS_BOUNDARY: Database itself is the node boundary — no tenancy columns.
#   Requires APP_DB_USER and APP_DB_PASSWORD; validates identifier syntax.
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

# App User Credentials (required, no defaults)
APP_USER="${APP_DB_USER:-}"
APP_PASS="${APP_DB_PASSWORD:-}"
# Service role: explicit name + separate password (never present in web runtime env)
APP_SERVICE_USER="${APP_DB_SERVICE_USER:-}"
APP_SERVICE_PASS="${APP_DB_SERVICE_PASSWORD:-}"
# Read-only role for Grafana/agent debugging. Defaults keep existing envs working;
# operators may override both values when rotating the Postgres root secret.
APP_READONLY_USER="${APP_DB_READONLY_USER:-app_readonly}"
APP_READONLY_PASS="${APP_DB_READONLY_PASSWORD:-}"

if [ -z "$APP_USER" ] || [ -z "$APP_PASS" ]; then
  echo "❌ ERROR: APP_DB_USER and APP_DB_PASSWORD are required"
  exit 1
fi
if [ -z "$APP_SERVICE_USER" ]; then
  echo "❌ ERROR: APP_DB_SERVICE_USER is required (explicit service role name)"
  exit 1
fi
if [ -z "$APP_SERVICE_PASS" ]; then
  echo "❌ ERROR: APP_DB_SERVICE_PASSWORD is required (service role credential, separate from APP_DB_PASSWORD)"
  exit 1
fi
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

# Validate identifiers (strict allowlist: alphanumeric + underscore only)
if ! [[ "$APP_USER" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "❌ ERROR: APP_DB_USER contains invalid characters (allowed: a-zA-Z0-9_)"
  exit 1
fi
if ! [[ "$APP_SERVICE_USER" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "❌ ERROR: APP_DB_SERVICE_USER contains invalid characters (allowed: a-zA-Z0-9_)"
  exit 1
fi
if ! [[ "$APP_READONLY_USER" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "❌ ERROR: APP_DB_READONLY_USER contains invalid characters (allowed: a-zA-Z0-9_)"
  exit 1
fi
if ! [[ "$LITELLM_DB" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "❌ ERROR: LITELLM_DB_NAME contains invalid characters (allowed: a-zA-Z0-9_)"
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

# ── Role Creation (Idempotent, shared across all node DBs) ─────────────────

# App Role
echo "🔧 Checking app role '$APP_USER'..."
role_exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_roles WHERE rolname = '$APP_USER'" | grep -c 1 || true)
if [ "$role_exists" -eq 0 ]; then
  echo "   -> Creating role '$APP_USER'..."
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -v ON_ERROR_STOP=1 \
    -v app_pass="$APP_PASS" <<SQL
CREATE ROLE "$APP_USER" WITH LOGIN PASSWORD :'app_pass';
SQL
else
  # Do NOT re-ALTER the password here. DB creds are owned by OpenBao/ESO (the SSOT the
  # app pod reads via its synced Secret). Forcing the role to deploy-infra's .env diverges
  # from ESO → 28P01 → 502 (bug.5002). Set-once at create; never reconciled from .env.
  echo "   -> Role '$APP_USER' already exists (password owned by ESO; not reconciled)."
fi

# Service Role (BYPASSRLS for scheduler, internal workers)
echo "🔧 Checking service role '$APP_SERVICE_USER'..."
service_role_exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_roles WHERE rolname = '$APP_SERVICE_USER'" | grep -c 1 || true)
if [ "$service_role_exists" -eq 0 ]; then
  echo "   -> Creating service role '$APP_SERVICE_USER' with BYPASSRLS..."
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -v ON_ERROR_STOP=1 \
    -v svc_pass="$APP_SERVICE_PASS" <<SQL
CREATE ROLE "$APP_SERVICE_USER" WITH LOGIN PASSWORD :'svc_pass' BYPASSRLS;
SQL
else
  # See app-role note: password owned by ESO; do not reconcile to .env (bug.5002).
  echo "   -> Service role '$APP_SERVICE_USER' already exists (password owned by ESO; not reconciled)."
fi

# Read-only role (BYPASSRLS for cross-tenant support/debugging reads, no write grants)
echo "🔧 Checking read-only role '$APP_READONLY_USER'..."
readonly_role_exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_roles WHERE rolname = '$APP_READONLY_USER'" | grep -c 1 || true)
if [ "$readonly_role_exists" -eq 0 ]; then
  echo "   -> Creating read-only role '$APP_READONLY_USER' with BYPASSRLS..."
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -v ON_ERROR_STOP=1 \
    -v readonly_pass="$APP_READONLY_PASS" <<SQL
CREATE ROLE "$APP_READONLY_USER" WITH LOGIN PASSWORD :'readonly_pass' BYPASSRLS;
ALTER ROLE "$APP_READONLY_USER" SET default_transaction_read_only = on;
ALTER ROLE "$APP_READONLY_USER" SET statement_timeout = '30s';
SQL
else
  # Do NOT re-ALTER the password here (bug.5002 / Invariant 15). The read-only
  # credential is owned out-of-band by its consumers — the Grafana Cloud Postgres
  # datasource (provision-grafana-postgres-datasources.sh) derives the SAME value
  # from POSTGRES_ROOT_PASSWORD. Re-ALTERing from this .env on every deploy makes
  # db-provision a second writer; any divergence knocks the datasource off its
  # value → 28P01 (the same class as bug.5031). Set-once at create; never
  # reconciled from .env. Only re-apply the non-secret read-only SET settings.
  echo "   -> Read-only role '$APP_READONLY_USER' already exists (password owned by consumers; not reconciled). Re-applying SET settings..."
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -v ON_ERROR_STOP=1 <<SQL
ALTER ROLE "$APP_READONLY_USER" SET default_transaction_read_only = on;
ALTER ROLE "$APP_READONLY_USER" SET statement_timeout = '30s';
SQL
fi

# ── Per-Node Database Provisioning (DB_PER_NODE) ──────────────────────────
# Each node gets its own database. The database IS the node boundary.

function provision_node_db() {
  local db_name="$1"

  # Validate identifier
  if ! [[ "$db_name" =~ ^[a-zA-Z0-9_]+$ ]]; then
    echo "❌ ERROR: Database name '$db_name' contains invalid characters (allowed: a-zA-Z0-9_)"
    exit 1
  fi

  echo "🔧 Provisioning node database '$db_name'..."

  # Create database (idempotent)
  local db_exists
  db_exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_database WHERE datname = '$db_name'" | grep -c 1 || true)
  if [ "$db_exists" -eq 0 ]; then
    echo "   -> Creating database '$db_name' with owner '$APP_USER'..."
    run_sql_as_root "postgres" "CREATE DATABASE \"$db_name\" OWNER \"$APP_USER\";"
  else
    echo "   -> Database '$db_name' already exists. Ensuring ownership..."
    run_sql_as_root "postgres" "ALTER DATABASE \"$db_name\" OWNER TO \"$APP_USER\";"
    run_sql_as_root "postgres" "GRANT CONNECT, CREATE, TEMP ON DATABASE \"$db_name\" TO \"$APP_USER\";"
  fi

  # RLS role hardening
  echo "   -> Applying RLS role hardening on '$db_name'..."
  run_sql_as_root "$db_name" "ALTER SCHEMA public OWNER TO \"$APP_USER\";"
  run_sql_as_root "$db_name" "GRANT USAGE, CREATE ON SCHEMA public TO \"$APP_USER\";"
  run_sql_as_root "$db_name" "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"$APP_USER\";"
  run_sql_as_root "$db_name" "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"$APP_USER\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$APP_USER\" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \"$APP_USER\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$APP_USER\" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO \"$APP_USER\";"

  # Service role grants — includes CREATE for migrations (drizzle-kit needs to create schemas + tables)
  run_sql_as_root "$db_name" "GRANT CONNECT, CREATE ON DATABASE \"$db_name\" TO \"$APP_SERVICE_USER\";"
  run_sql_as_root "$db_name" "GRANT USAGE, CREATE ON SCHEMA public TO \"$APP_SERVICE_USER\";"
  run_sql_as_root "$db_name" "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"$APP_SERVICE_USER\";"
  run_sql_as_root "$db_name" "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"$APP_SERVICE_USER\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$APP_USER\" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \"$APP_SERVICE_USER\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$APP_USER\" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO \"$APP_SERVICE_USER\";"

  # Read-only role grants — Grafana/agent support reads across tenants, writes denied by SQL privileges.
  run_sql_as_root "$db_name" "GRANT CONNECT ON DATABASE \"$db_name\" TO \"$APP_READONLY_USER\";"
  run_sql_as_root "$db_name" "GRANT USAGE ON SCHEMA public TO \"$APP_READONLY_USER\";"
  run_sql_as_root "$db_name" "GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"$APP_READONLY_USER\";"
  run_sql_as_root "$db_name" "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"$APP_READONLY_USER\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$APP_USER\" IN SCHEMA public GRANT SELECT ON TABLES TO \"$APP_READONLY_USER\";"
  run_sql_as_root "$db_name" "ALTER DEFAULT PRIVILEGES FOR ROLE \"$APP_USER\" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO \"$APP_READONLY_USER\";"

  echo "   ✅ Node database '$db_name' provisioned."
}

# Provision each node database from comma-separated list
IFS=',' read -ra NODE_DBS <<< "$APP_DBS"
for db in "${NODE_DBS[@]}"; do
  # Trim whitespace
  db=$(echo "$db" | xargs)
  provision_node_db "$db"
done

# ── LiteLLM Database (shared, root-owned) ─────────────────────────────────
echo "🔧 Checking litellm database '$LITELLM_DB'..."
litellm_db_exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_database WHERE datname = '$LITELLM_DB'" | grep -c 1 || true)
if [ "$litellm_db_exists" -eq 0 ]; then
  echo "   -> Creating database '$LITELLM_DB'..."
  run_sql_as_root "postgres" "CREATE DATABASE \"$LITELLM_DB\";"
else
  echo "   -> Database '$LITELLM_DB' already exists."
fi

echo "✅ Provisioning Complete (${#NODE_DBS[@]} node database(s) + litellm)."
