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

# Infra-only mode: create the shared, root-owned infra DBs (litellm, openfga) and
# nothing else. Decouples infra-DB creation from the per-node OpenBao creds so a
# fresh env (node creds not yet materialized) still gets openfga/litellm BEFORE
# openfga-migrate. Set by deploy-infra.sh's dedicated infra-DB pass; needs only the
# root Postgres creds — never OpenBao, never a node DB.
INFRA_ONLY="${PROVISION_INFRA_ONLY:-0}"
# Per-node array — declared early so ${#NODE_DBS[@]} is safe under set -u even when
# the per-node path is skipped (INFRA_ONLY).
NODE_DBS=()

# Per-node databases (comma-separated). Required in node mode — no defaults.
APP_DBS="${COGNI_NODE_DBS:-}"
if [ "$INFRA_ONLY" != "1" ] && [ -z "$APP_DBS" ]; then
  echo "❌ ERROR: COGNI_NODE_DBS is required (comma-separated list of database names)"
  exit 1
fi

# LiteLLM database (shared, root-owned — single instance serves all nodes)
LITELLM_DB="${LITELLM_DB_NAME:-}"
if [ -z "$LITELLM_DB" ]; then
  echo "❌ ERROR: LITELLM_DB_NAME is required"
  exit 1
fi

# OpenFGA database (shared — single RBAC store server). Gets a dedicated
# `openfga` login role whose password is OpenBao-sourced (Invariant 15), set-once
# + reconciled like the per-node roles. Drops the root creds from the datastore
# DSN (design.openfga-substrate-unification Phase A).
OPENFGA_DB="${OPENFGA_DB_NAME:-}"
# OpenFGA is shared infra (the INFRA_ONLY pass owns it); the per-node pass carries
# OPENFGA_DB_NAME via compose env but no password — clear it so the openfga blocks
# below skip instead of demanding a password the per-node pass never holds.
[ "$INFRA_ONLY" = "1" ] || OPENFGA_DB=""
OPENFGA_ROLE="openfga"
OPENFGA_PASS="${OPENFGA_DB_PASSWORD:-}"
# Fail loud on source-read failure (Invariant): if the DB exists in the catalog
# but its OpenBao password didn't reach us, never fall back to root.
if [ -n "$OPENFGA_DB" ] && [ -z "$OPENFGA_PASS" ]; then
  echo "❌ ERROR: OPENFGA_DB_PASSWORD is required for the openfga role (OpenBao-sourced; never fall back to root)"
  exit 1
fi

# NOTE: Temporal runs on a DEDICATED postgres (compose service `temporal-postgres`),
# NOT this shared instance. Its `temporal` superuser password is reconciled by
# deploy-infra.sh against temporal-postgres directly (idempotent ALTER USER over the
# local-trust socket) — never here. #1625 mistakenly ALTERed a `temporal` role on
# THIS shared postgres (the wrong DB), which fixed nothing; that misfire is removed.

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

if [ "$INFRA_ONLY" != "1" ] && [ -z "$APP_PASS" ]; then
  echo "❌ ERROR: APP_DB_PASSWORD is required (per-node app role password from OpenBao)"
  exit 1
fi
if [ "$INFRA_ONLY" != "1" ] && [ -z "$APP_SERVICE_PASS" ]; then
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
# Skipped in INFRA_ONLY: the per-node pass owns this role.
if [ "$INFRA_ONLY" != "1" ]; then
  echo "🔧 Reconciling shared read-only role '$APP_READONLY_USER'..."
  provision_app_role "$APP_READONLY_USER" "$APP_READONLY_PASS" "BYPASSRLS"
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -v ON_ERROR_STOP=1 <<SQL
ALTER ROLE "$APP_READONLY_USER" SET default_transaction_read_only = on;
ALTER ROLE "$APP_READONLY_USER" SET statement_timeout = '30s';
SQL
fi

# migrate_owned <db> <from_role> <to_role>
#   In-provisioner cutover for an ALREADY-provisioned DB: transfer objects owned by
#   a legacy shared role to the per-node role, then drop the legacy role's remaining
#   objects/privileges in THIS db. Lives in the recurring provisioner ON PURPOSE:
#   the owner requires ZERO per-env manual steps — every env (candidate-a, preview,
#   production) cuts over by the same flight, not by a hand-run one-shot migration.
#   Idempotent + guarded: no-op on a fresh node (legacy role absent) and after the
#   first run (the legacy role owns nothing here, so REASSIGN/DROP OWNED are no-ops)
#   until the role is finally DROPped cluster-wide (runbook Step 5). DROP OWNED is
#   per-db, so it never touches other nodes' grants on the shared role. Without this,
#   existing tables stay owned by app_user → future ALTER-table migrations fail and
#   DROP ROLE app_user can never complete. The declarative endgame (CloudNativePG /
#   Terraform postgresql provider, task.5016) retires this bash. See
#   docs/guides/vm-secrets-repair.md.
migrate_owned() {
  local db="$1" from="$2" to="$3" exists
  exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_roles WHERE rolname = '$from'" | grep -c 1 || true)
  [ "$exists" -eq 0 ] && return 0
  echo "   -> Reassigning objects owned by legacy '$from' → '$to' in '$db'..."
  run_sql_as_root "$db" "REASSIGN OWNED BY \"$from\" TO \"$to\";"
  run_sql_as_root "$db" "DROP OWNED BY \"$from\";"
}

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

  # Cutover an already-provisioned DB: existing tables/schema are owned by the
  # legacy shared roles; move them to the per-node roles BEFORE re-keying grants so
  # the per-node role is the true owner (migrations + the eventual DROP ROLE work).
  # Idempotent no-op once cut over / on fresh nodes (see migrate_owned).
  migrate_owned "$db_name" "app_user" "$app_role"
  migrate_owned "$db_name" "app_service" "$svc_role"

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
# every node the same password. Skipped in INFRA_ONLY (no node creds, no node DB).
if [ "$INFRA_ONLY" != "1" ]; then
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
fi

# ── LiteLLM Database (shared, root-owned) ─────────────────────────────────
echo "🔧 Checking litellm database '$LITELLM_DB'..."
litellm_db_exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_database WHERE datname = '$LITELLM_DB'" | grep -c 1 || true)
if [ "$litellm_db_exists" -eq 0 ]; then
  echo "   -> Creating database '$LITELLM_DB'..."
  run_sql_as_root "postgres" "CREATE DATABASE \"$LITELLM_DB\";"
else
  echo "   -> Database '$LITELLM_DB' already exists."
fi

# ── OpenFGA Database (dedicated openfga role) ─────────────────────────────
if [ -n "$OPENFGA_DB" ]; then
  echo "🔧 Provisioning openfga database '$OPENFGA_DB' (role '$OPENFGA_ROLE')..."
  provision_app_role "$OPENFGA_ROLE" "$OPENFGA_PASS"
  openfga_db_exists=$(run_sql_as_root "postgres" "SELECT 1 FROM pg_database WHERE datname = '$OPENFGA_DB'" | grep -c 1 || true)
  if [ "$openfga_db_exists" -eq 0 ]; then
    echo "   -> Creating database '$OPENFGA_DB' with owner '$OPENFGA_ROLE'..."
    run_sql_as_root "postgres" "CREATE DATABASE \"$OPENFGA_DB\" OWNER \"$OPENFGA_ROLE\";"
  else
    # Pre-migration store is root(superuser)-owned. Hand the openfga role the DB +
    # schema + full rights on the EXISTING (root-created) objects, WITHOUT dropping
    # data — store + tuple continuity (#1604). Grant-based, not REASSIGN OWNED:
    # REASSIGN fails on superuser-owned objects "required by the database system".
    echo "   -> Database '$OPENFGA_DB' exists; granting ownership/rights to '$OPENFGA_ROLE' (store preserved)..."
    run_sql_as_root "postgres" "ALTER DATABASE \"$OPENFGA_DB\" OWNER TO \"$OPENFGA_ROLE\";"
    run_sql_as_root "postgres" "GRANT CONNECT, CREATE, TEMP ON DATABASE \"$OPENFGA_DB\" TO \"$OPENFGA_ROLE\";"
    run_sql_as_root "$OPENFGA_DB" "ALTER SCHEMA public OWNER TO \"$OPENFGA_ROLE\";"
    run_sql_as_root "$OPENFGA_DB" "GRANT ALL ON SCHEMA public TO \"$OPENFGA_ROLE\";"
    run_sql_as_root "$OPENFGA_DB" "GRANT ALL ON ALL TABLES IN SCHEMA public TO \"$OPENFGA_ROLE\";"
    run_sql_as_root "$OPENFGA_DB" "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO \"$OPENFGA_ROLE\";"
  fi
else
  echo "   -> OPENFGA_DB_NAME not set; skipping openfga database provisioning."
fi

_node_summary="${#NODE_DBS[@]} node database(s)"
[ "$INFRA_ONLY" = "1" ] && _node_summary="infra-only (no node DB)"
if [ -n "$OPENFGA_DB" ]; then
  echo "✅ Provisioning Complete (${_node_summary} + litellm + openfga)."
else
  echo "✅ Provisioning Complete (${_node_summary} + litellm)."
fi
