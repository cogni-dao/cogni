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
RELIABILITY_ROLE="database_reliability_actuator"
RELIABILITY_PASS="${DATABASE_RELIABILITY_PASSWORD:-}"
READMITTER_ROLE="database_reliability_readmitter"
READMITTER_PASS="${DATABASE_RELIABILITY_READMIT_PASSWORD:-}"
MIGRATION_PASS="${APP_DB_MIGRATION_PASSWORD:-}"
DB_BUDGET_PROFILE="${DB_BUDGET_PROFILE:-}"
DB_APP_CONNECTION_LIMIT="${DB_APP_CONNECTION_LIMIT:-}"
DB_APP_STATEMENT_TIMEOUT_MS="${DB_APP_STATEMENT_TIMEOUT_MS:-}"
DB_SERVICE_CONNECTION_LIMIT="${DB_SERVICE_CONNECTION_LIMIT:-}"
DB_SERVICE_STATEMENT_TIMEOUT_MS="${DB_SERVICE_STATEMENT_TIMEOUT_MS:-}"
DB_LOCK_TIMEOUT_MS="${DB_LOCK_TIMEOUT_MS:-}"
DB_IDLE_IN_TRANSACTION_TIMEOUT_MS="${DB_IDLE_IN_TRANSACTION_TIMEOUT_MS:-}"
DB_TEMP_FILE_LIMIT_MIB="${DB_TEMP_FILE_LIMIT_MIB:-}"
DB_WORK_MEM_MIB="${DB_WORK_MEM_MIB:-}"
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
if [ "$INFRA_ONLY" != "1" ] && [ -z "$MIGRATION_PASS" ]; then
  echo "❌ ERROR: APP_DB_MIGRATION_PASSWORD is required (per-node migration role password from OpenBao)"
  exit 1
fi
if [ "$INFRA_ONLY" != "1" ]; then
  [ -n "$DB_BUDGET_PROFILE" ] || { echo "❌ ERROR: DB_BUDGET_PROFILE is required"; exit 1; }
  for budget_name in \
    DB_APP_CONNECTION_LIMIT DB_APP_STATEMENT_TIMEOUT_MS \
    DB_SERVICE_CONNECTION_LIMIT DB_SERVICE_STATEMENT_TIMEOUT_MS \
    DB_LOCK_TIMEOUT_MS DB_IDLE_IN_TRANSACTION_TIMEOUT_MS \
    DB_TEMP_FILE_LIMIT_MIB DB_WORK_MEM_MIB; do
    budget_value="${!budget_name:-}"
    if ! [[ "$budget_value" =~ ^[1-9][0-9]*$ ]]; then
      echo "❌ ERROR: $budget_name must be a positive integer from DB_BUDGET_PROFILE '$DB_BUDGET_PROFILE'"
      exit 1
    fi
  done
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
if ! [[ "$RELIABILITY_ROLE" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "❌ ERROR: DATABASE_RELIABILITY_ROLE contains invalid characters"
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
#   caller passes the OpenBao read here. Existing LOGIN state is preserved: only
#   the audited readmitter may reopen a contained runtime role.
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
ALTER ROLE "$role" WITH PASSWORD :'pw';
SQL
  fi
}

# PostgreSQL 15's CREATEROLE can alter every non-superuser role; the
# ADMIN-OPTION-scoped behavior only exists in PostgreSQL 16+. Keep the actuator
# NOCREATEROLE and expose one root-owned SECURITY DEFINER function that accepts
# only exact provisioned app_<slug>/service_<slug> roles and drains only that
# role's sessions. The login role never receives pg_signal_backend. pg_monitor
# provides read-only status visibility.
if [ -n "$RELIABILITY_PASS" ] && [ -n "$READMITTER_PASS" ]; then
  provision_app_role "$RELIABILITY_ROLE" "$RELIABILITY_PASS"
  provision_app_role "$READMITTER_ROLE" "$READMITTER_PASS"
  run_sql_as_root postgres "ALTER ROLE \"$RELIABILITY_ROLE\" NOCREATEROLE INHERIT NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS;"
  run_sql_as_root postgres "ALTER ROLE \"$READMITTER_ROLE\" NOCREATEROLE NOINHERIT NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS;"
  run_sql_as_root postgres "REVOKE pg_signal_backend FROM \"$RELIABILITY_ROLE\", \"$READMITTER_ROLE\";"
  run_sql_as_root postgres "REVOKE pg_monitor FROM \"$READMITTER_ROLE\";"
  run_sql_as_root postgres "DO \$reliability_membership\$
DECLARE member_role text;
DECLARE granted_role text;
BEGIN
  FOREACH member_role IN ARRAY ARRAY['$RELIABILITY_ROLE', '$READMITTER_ROLE']
  LOOP
    FOR granted_role IN
      SELECT parent.rolname
        FROM pg_auth_members membership
        JOIN pg_roles parent ON parent.oid = membership.roleid
        JOIN pg_roles member ON member.oid = membership.member
       WHERE member.rolname = member_role
         AND parent.rolname ~ '^(app|service|migration)_'
    LOOP
      EXECUTE format('REVOKE %I FROM %I', granted_role, member_role);
    END LOOP;
  END LOOP;
END
\$reliability_membership\$;"
  run_sql_as_root postgres "GRANT pg_monitor TO \"$RELIABILITY_ROLE\";"
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
CREATE OR REPLACE FUNCTION public.contain_database_role(target_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS \$function\$
DECLARE
  role_suffix text;
BEGIN
  IF to_regnamespace('cogni_control') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy containment disabled by versioned recovery control' USING ERRCODE = '42501';
  END IF;
  IF target_role !~ '^(app|service)_[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'database containment role is outside the per-node role namespace' USING ERRCODE = '42501';
  END IF;
  role_suffix := regexp_replace(target_role, '^(app|service)_', '');
  IF NOT EXISTS (
    SELECT 1
      FROM pg_database database_role_boundary
      JOIN pg_roles app_owner ON app_owner.oid = database_role_boundary.datdba
     WHERE database_role_boundary.datname = 'cogni_' || role_suffix
       AND app_owner.rolname = 'app_' || role_suffix
  ) OR NOT EXISTS (SELECT 1 FROM pg_roles provisioned_role WHERE provisioned_role.rolname = target_role) THEN
    RAISE EXCEPTION 'database containment role is not provisioned' USING ERRCODE = '42501';
  END IF;
  IF session_user <> '$RELIABILITY_ROLE' THEN
    RAISE EXCEPTION 'containment requires the reliability actuator identity' USING ERRCODE = '42501';
  END IF;
  EXECUTE format('ALTER ROLE %I NOLOGIN', target_role);
  PERFORM pg_terminate_backend(pid)
    FROM pg_stat_activity
   WHERE usename = target_role AND pid <> pg_backend_pid();
END
\$function\$;
REVOKE ALL ON FUNCTION public.contain_database_role(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.readmit_database_role(target_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS \$function\$
DECLARE
  role_suffix text;
BEGIN
  IF to_regnamespace('cogni_control') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy readmission disabled by versioned recovery control' USING ERRCODE = '42501';
  END IF;
  IF session_user <> '$READMITTER_ROLE' THEN
    RAISE EXCEPTION 'readmission requires the dedicated human-gated identity' USING ERRCODE = '42501';
  END IF;
  IF target_role !~ '^(app|service)_[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'database readmission role is outside the per-node role namespace' USING ERRCODE = '42501';
  END IF;
  role_suffix := regexp_replace(target_role, '^(app|service)_', '');
  IF NOT EXISTS (
    SELECT 1
      FROM pg_database database_role_boundary
      JOIN pg_roles app_owner ON app_owner.oid = database_role_boundary.datdba
     WHERE database_role_boundary.datname = 'cogni_' || role_suffix
       AND app_owner.rolname = 'app_' || role_suffix
  ) OR NOT EXISTS (SELECT 1 FROM pg_roles provisioned_role WHERE provisioned_role.rolname = target_role) THEN
    RAISE EXCEPTION 'database readmission role is not provisioned' USING ERRCODE = '42501';
  END IF;
  EXECUTE format('ALTER ROLE %I LOGIN', target_role);
END
\$function\$;
REVOKE ALL ON FUNCTION public.readmit_database_role(text) FROM PUBLIC;
DO \$legacy_grants\$
BEGIN
  IF to_regnamespace('cogni_control') IS NULL THEN
    GRANT EXECUTE ON FUNCTION public.contain_database_role(text) TO "$RELIABILITY_ROLE";
    GRANT EXECUTE ON FUNCTION public.readmit_database_role(text) TO "$READMITTER_ROLE";
  ELSE
    REVOKE ALL ON FUNCTION public.contain_database_role(text), public.readmit_database_role(text)
      FROM "$RELIABILITY_ROLE", "$READMITTER_ROLE";
  END IF;
END
\$legacy_grants\$;
SQL
else
  echo "ℹ️  reliability actuator/readmitter password absent; control roles not reconciled"
fi

# Shared read-only role (env-level; superuser-derived password; BYPASSRLS support
# reads for the Grafana datasource). Created once, outside the per-node loop.
# Skipped in INFRA_ONLY: the per-node pass owns this role.
if [ "$INFRA_ONLY" != "1" ]; then
  echo "🔧 Reconciling shared read-only role '$APP_READONLY_USER'..."
  # Independent node jobs share this role. Lock before existence/read/update in
  # the same transaction/session; a separate psql call would release the lock.
  PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "postgres" -v ON_ERROR_STOP=1 \
    -v readonly_role="$APP_READONLY_USER" -v pw="$APP_READONLY_PASS" <<SQL
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('cogni:shared-readonly:' || :'readonly_role', 0));
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'readonly_role') AS readonly_exists \gset
\if :readonly_exists
ALTER ROLE "$APP_READONLY_USER" WITH PASSWORD :'pw';
\else
CREATE ROLE "$APP_READONLY_USER" WITH LOGIN PASSWORD :'pw' BYPASSRLS;
\endif
ALTER ROLE "$APP_READONLY_USER" SET default_transaction_read_only = on;
ALTER ROLE "$APP_READONLY_USER" SET statement_timeout = '30s';
-- bug.5293: this role is also the metrics identity. Alloy's
-- prometheus.exporter.postgres connects as it to read pg_stat_database (one row
-- per node database — the per-tenant signal) plus the instance-scoped pg_stat_*
-- views. Those views withhold other sessions' rows from an unprivileged role, so
-- without pg_monitor the exporter silently reports a partial picture rather than
-- failing. pg_monitor is the PostgreSQL-native predefined role for exactly this
-- (pg_read_all_stats + pg_read_all_settings + pg_stat_scan_tables) and grants NO
-- table data access, so it does not widen this role beyond observability.
-- Idempotent: GRANT of an already-held role membership is a no-op.
GRANT pg_monitor TO "$APP_READONLY_USER";
COMMIT;
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
  local migration_role="migration_${node}"

  echo "🔧 Provisioning node '$node' (db '$db_name', roles '$app_role'/'$svc_role')..."

  # Per-node roles — passwords reconciled to this node's OpenBao values.
  # app_role is RLS-SUBJECT (no BYPASSRLS): FORCE ROW LEVEL SECURITY on user
  # tables keeps the owning role tenant-isolated. svc_role is BYPASSRLS (workers).
  provision_app_role "$app_role" "$APP_PASS"
  provision_app_role "$svc_role" "$APP_SERVICE_PASS" "BYPASSRLS"
  provision_app_role "$migration_role" "$MIGRATION_PASS" "NOINHERIT"
  # CREATE-only opts are not reconciliation. Repair elevated attribute drift on
  # every run before applying budgets, and remove any inherited privilege edge.
  run_sql_as_root postgres "ALTER ROLE \"$app_role\" INHERIT NOCREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS;"
  run_sql_as_root postgres "ALTER ROLE \"$svc_role\" INHERIT NOCREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION BYPASSRLS;"
  for runtime_role in "$app_role" "$svc_role"; do
    run_sql_as_root postgres "DO \$membership\$
DECLARE granted_role text;
BEGIN
  FOR granted_role IN
    SELECT parent.rolname
      FROM pg_auth_members membership
      JOIN pg_roles parent ON parent.oid = membership.roleid
      JOIN pg_roles member ON member.oid = membership.member
     WHERE member.rolname = '$runtime_role'
  LOOP
    EXECUTE format('REVOKE %I FROM %I', granted_role, '$runtime_role');
  END LOOP;
END
\$membership\$;"
  done
  run_sql_as_root postgres "ALTER ROLE \"$migration_role\" LOGIN NOCREATEROLE NOINHERIT NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;"
  # Attribute and membership drift is privilege drift. Remove every inherited
  # role before restoring the sole reviewed SET ROLE edge to this node's app
  # owner; a re-run must repair an accidentally privileged migration identity.
  run_sql_as_root postgres "DO \$membership\$
DECLARE granted_role text;
BEGIN
  FOR granted_role IN
    SELECT parent.rolname
      FROM pg_auth_members membership
      JOIN pg_roles parent ON parent.oid = membership.roleid
      JOIN pg_roles member ON member.oid = membership.member
     WHERE member.rolname = '$migration_role'
  LOOP
    EXECUTE format('REVOKE %I FROM %I', granted_role, '$migration_role');
  END LOOP;
END
\$membership\$;"
  run_sql_as_root postgres "GRANT \"$app_role\" TO \"$migration_role\";"

  # PG15 USERSET parameters remain session-overridable by definition: the
  # statement_timeout, lock_timeout, idle_in_transaction_session_timeout, and
  # work_mem values below are intentionally fresh-session defaults, not ceilings.
  # Parameter ACLs cannot change that semantic. temp_file_limit is
  # SUSET, so explicitly remove any direct drifted SET grant from every node
  # identity. Connection limits and temp-file limits are hard admission/resource
  # controls; the remaining values are catalog-selected fresh-session defaults.
  run_sql_as_root postgres "REVOKE SET ON PARAMETER temp_file_limit FROM PUBLIC, \"$app_role\", \"$svc_role\", \"$migration_role\";"
  run_sql_as_root postgres "ALTER ROLE \"$migration_role\" SET statement_timeout = '900000ms';"
  run_sql_as_root postgres "ALTER ROLE \"$migration_role\" SET lock_timeout = '${DB_LOCK_TIMEOUT_MS}ms';"
  run_sql_as_root postgres "ALTER ROLE \"$migration_role\" SET idle_in_transaction_session_timeout = '${DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms';"
  run_sql_as_root postgres "ALTER ROLE \"$migration_role\" SET temp_file_limit = '${DB_TEMP_FILE_LIMIT_MIB}MB';"
  run_sql_as_root postgres "ALTER ROLE \"$migration_role\" SET work_mem = '${DB_WORK_MEM_MIB}MB';"

  # Enforce the catalog-selected runtime-role budget. All settings below are
  # PostgreSQL 15 per-role USER-context settings; no shared postgresql.conf
  # mutation can spill one node's profile onto a neighbor. The migration
  # process receives its reviewed 15-minute default from its isolated role.
  run_sql_as_root postgres "ALTER ROLE \"$app_role\" CONNECTION LIMIT $DB_APP_CONNECTION_LIMIT;"
  run_sql_as_root postgres "ALTER ROLE \"$svc_role\" CONNECTION LIMIT $DB_SERVICE_CONNECTION_LIMIT;"
  for role_budget in \
    "$app_role:$DB_APP_STATEMENT_TIMEOUT_MS" \
    "$svc_role:$DB_SERVICE_STATEMENT_TIMEOUT_MS"; do
    role="${role_budget%%:*}"
    statement_timeout_ms="${role_budget##*:}"
    run_sql_as_root postgres "ALTER ROLE \"$role\" SET statement_timeout = '${statement_timeout_ms}ms';"
    run_sql_as_root postgres "ALTER ROLE \"$role\" SET lock_timeout = '${DB_LOCK_TIMEOUT_MS}ms';"
    run_sql_as_root postgres "ALTER ROLE \"$role\" SET idle_in_transaction_session_timeout = '${DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms';"
    run_sql_as_root postgres "ALTER ROLE \"$role\" SET temp_file_limit = '${DB_TEMP_FILE_LIMIT_MIB}MB';"
    run_sql_as_root postgres "ALTER ROLE \"$role\" SET work_mem = '${DB_WORK_MEM_MIB}MB';"
  done
  # The named profile is not considered enforced until PostgreSQL reads back
  # the exact connection limit and every per-role setting. This catches a
  # rejected/partially-applied ALTER before admitting the node.
  run_sql_as_root postgres "DO \$budget\$
DECLARE
  app_config text[];
  service_config text[];
  app_attributes_ok boolean;
  service_attributes_ok boolean;
  runtime_memberships bigint;
BEGIN
  SELECT rolconfig,
         rolinherit AND NOT rolsuper AND NOT rolcreaterole
           AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
    INTO app_config, app_attributes_ok FROM pg_roles
    WHERE rolname = '$app_role' AND rolconnlimit = $DB_APP_CONNECTION_LIMIT;
  SELECT rolconfig,
         rolinherit AND NOT rolsuper AND NOT rolcreaterole
           AND NOT rolcreatedb AND NOT rolreplication AND rolbypassrls
    INTO service_config, service_attributes_ok FROM pg_roles
    WHERE rolname = '$svc_role' AND rolconnlimit = $DB_SERVICE_CONNECTION_LIMIT;
  SELECT count(*) INTO runtime_memberships
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
   WHERE member.rolname IN ('$app_role', '$svc_role');
  IF app_attributes_ok IS DISTINCT FROM true OR runtime_memberships <> 0
     OR app_config IS NULL OR NOT app_config @> ARRAY[
    'statement_timeout=${DB_APP_STATEMENT_TIMEOUT_MS}ms',
    'lock_timeout=${DB_LOCK_TIMEOUT_MS}ms',
    'idle_in_transaction_session_timeout=${DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms',
    'temp_file_limit=${DB_TEMP_FILE_LIMIT_MIB}MB',
    'work_mem=${DB_WORK_MEM_MIB}MB'
  ] THEN
    RAISE EXCEPTION 'database budget profile $DB_BUDGET_PROFILE failed readback for $app_role';
  END IF;
  IF service_attributes_ok IS DISTINCT FROM true OR service_config IS NULL OR NOT service_config @> ARRAY[
    'statement_timeout=${DB_SERVICE_STATEMENT_TIMEOUT_MS}ms',
    'lock_timeout=${DB_LOCK_TIMEOUT_MS}ms',
    'idle_in_transaction_session_timeout=${DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms',
    'temp_file_limit=${DB_TEMP_FILE_LIMIT_MIB}MB',
    'work_mem=${DB_WORK_MEM_MIB}MB'
  ] THEN
    RAISE EXCEPTION 'database budget profile $DB_BUDGET_PROFILE failed readback for $svc_role';
  END IF;
END
\$budget\$;"
  echo "   -> Enforced and read back database budget '$DB_BUDGET_PROFILE' on '$app_role'/'$svc_role'."

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
  # Login as the isolated credential, then automatically SET ROLE to the
  # object-owning app identity so migrations create/alter objects with the same
  # ownership as before without exposing the app runtime credential.
  run_sql_as_root postgres "ALTER ROLE \"$migration_role\" IN DATABASE \"$db_name\" SET role = '$app_role';"
  run_sql_as_root "$db_name" "REVOKE ALL PRIVILEGES ON DATABASE \"$db_name\" FROM \"$migration_role\";"
  run_sql_as_root "$db_name" "REVOKE ALL PRIVILEGES ON SCHEMA public FROM \"$migration_role\";"
  run_sql_as_root "$db_name" "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM \"$migration_role\";"
  run_sql_as_root "$db_name" "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM \"$migration_role\";"
  run_sql_as_root postgres "DO \$migration_guard\$
DECLARE
  role_ok boolean;
  memberships text[];
  migration_config text[];
BEGIN
  SELECT rolcanlogin AND NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole
         AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
         AND rolconnlimit = 1,
         rolconfig
    INTO role_ok, migration_config
    FROM pg_roles
   WHERE rolname = '$migration_role';
  SELECT coalesce(array_agg(parent.rolname ORDER BY parent.rolname), ARRAY[]::text[])
    INTO memberships
    FROM pg_auth_members membership
    JOIN pg_roles parent ON parent.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
   WHERE member.rolname = '$migration_role';
  IF role_ok IS DISTINCT FROM true OR memberships <> ARRAY['$app_role']::text[] THEN
    RAISE EXCEPTION 'migration role attribute/membership readback failed for $migration_role';
  END IF;
  IF migration_config IS NULL OR NOT migration_config @> ARRAY[
    'statement_timeout=900000ms',
    'lock_timeout=${DB_LOCK_TIMEOUT_MS}ms',
    'idle_in_transaction_session_timeout=${DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms',
    'temp_file_limit=${DB_TEMP_FILE_LIMIT_MIB}MB',
    'work_mem=${DB_WORK_MEM_MIB}MB'
  ] THEN
    RAISE EXCEPTION 'migration role budget readback failed for $migration_role';
  END IF;
END
\$migration_guard\$;"
  for runtime_credential in \
    "$app_role:$APP_PASS" \
    "$svc_role:$APP_SERVICE_PASS"; do
    runtime_role="${runtime_credential%%:*}"
    runtime_password="${runtime_credential#*:}"
    runtime_can_login="$(PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres \
      -XAtv ON_ERROR_STOP=1 -c "SELECT rolcanlogin FROM pg_roles WHERE rolname = '$runtime_role'")"
    if [ "$runtime_can_login" = f ]; then
      echo "   -> Runtime role '$runtime_role' remains contained; catalog budget readback passed, login probes deferred."
      continue
    fi
    [ "$runtime_can_login" = t ] || { echo "❌ ERROR: runtime role '$runtime_role' login state missing"; exit 1; }
    runtime_role_saturated="$(PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres \
      -XAtv ON_ERROR_STOP=1 -c "SELECT role_budget.rolconnlimit > 0 AND
        (SELECT count(*) FROM pg_stat_activity
          WHERE usename = role_budget.rolname AND backend_type = 'client backend') >= role_budget.rolconnlimit
        FROM pg_roles role_budget WHERE role_budget.rolname = '$runtime_role'")"
    case "$runtime_role_saturated" in
      t)
        run_sql_as_root "$db_name" "DO \$deferred_probe\$
BEGIN
  IF has_parameter_privilege('$runtime_role', 'temp_file_limit', 'SET') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'runtime role $runtime_role can override enforced temp_file_limit';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_db_role_setting role_settings
    CROSS JOIN LATERAL unnest(role_settings.setconfig) AS setting(value)
    WHERE role_settings.setrole = (SELECT oid FROM pg_roles WHERE rolname = '$runtime_role')
      AND role_settings.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND split_part(setting.value, '=', 1) IN (
        'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'temp_file_limit', 'work_mem')
  ) THEN
    RAISE EXCEPTION 'runtime role $runtime_role per-database budget overrides prevent saturated probe deferral';
  END IF;
END
\$deferred_probe\$;"
        echo "::warning::runtime_role_probe_deferred role=$runtime_role reason=role_connection_limit authentication=unverified catalog_budget=verified"
        continue
        ;;
      f) ;;
      *) echo "❌ ERROR: runtime role '$runtime_role' admission state missing"; exit 1 ;;
    esac
    session_budget="$(PGPASSWORD="$runtime_password" psql -h "$PG_HOST" -p "$PG_PORT" -U "$runtime_role" -d "$db_name" \
      -XAtv ON_ERROR_STOP=1 -c "SELECT string_agg(setting, ':' ORDER BY array_position(ARRAY['statement_timeout','lock_timeout','idle_in_transaction_session_timeout','temp_file_limit','work_mem'], name)) FROM pg_settings WHERE name = ANY (ARRAY['statement_timeout','lock_timeout','idle_in_transaction_session_timeout','temp_file_limit','work_mem'])")"
    expected_statement_timeout="$DB_APP_STATEMENT_TIMEOUT_MS"
    [ "$runtime_role" = "$svc_role" ] && expected_statement_timeout="$DB_SERVICE_STATEMENT_TIMEOUT_MS"
    expected_session_budget="${expected_statement_timeout}:${DB_LOCK_TIMEOUT_MS}:${DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}:$((DB_TEMP_FILE_LIMIT_MIB * 1024)):$((DB_WORK_MEM_MIB * 1024))"
    [ "$session_budget" = "$expected_session_budget" ] \
      || { echo "❌ ERROR: runtime role '$runtime_role' fresh-session budget mismatch: '$session_budget'"; exit 1; }
    if PGPASSWORD="$runtime_password" psql -h "$PG_HOST" -p "$PG_PORT" -U "$runtime_role" -d "$db_name" \
      -v ON_ERROR_STOP=1 -c "SET temp_file_limit = '1GB'" >/dev/null 2>&1; then
      echo "❌ ERROR: runtime role '$runtime_role' can override enforced temp_file_limit"
      exit 1
    fi
  done
  migration_identity="$(PGPASSWORD="$MIGRATION_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$migration_role" -d "$db_name" -XAtv ON_ERROR_STOP=1 \
    -c "SELECT session_user || ':' || current_user || ':' || current_setting('statement_timeout')")"
  [[ "$migration_identity" == "$migration_role:$app_role:15min" || "$migration_identity" == "$migration_role:$app_role:900s" ]] \
    || { echo "❌ ERROR: migration role identity/budget readback failed: '$migration_identity'"; exit 1; }
  if PGPASSWORD="$MIGRATION_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$migration_role" -d "$db_name" \
    -v ON_ERROR_STOP=1 -c "SET temp_file_limit = '1GB'" >/dev/null 2>&1; then
    echo "❌ ERROR: migration role can override enforced temp_file_limit"
    exit 1
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

  if [ -n "$RELIABILITY_PASS" ] && [ -n "$READMITTER_PASS" ]; then
    for control_identity in \
      "$RELIABILITY_ROLE:$RELIABILITY_PASS" \
      "$READMITTER_ROLE:$READMITTER_PASS"; do
      control_role="${control_identity%%:*}"
      control_password="${control_identity#*:}"
      if PGPASSWORD="$control_password" psql -h "$PG_HOST" -p "$PG_PORT" -U "$control_role" -d "$db_name" \
        -v ON_ERROR_STOP=1 -c "SET ROLE \"$app_role\"" >/dev/null 2>&1; then
        echo "❌ ERROR: control role '$control_role' can SET ROLE into '$app_role'"
        exit 1
      fi
      data_access="$(PGPASSWORD="$control_password" psql -h "$PG_HOST" -p "$PG_PORT" -U "$control_role" -d "$db_name" -XAtv ON_ERROR_STOP=1 \
        -c "SELECT coalesce(bool_or(has_table_privilege(session_user, format('%I.%I', schemaname, tablename), 'SELECT')), false) FROM pg_tables WHERE schemaname = 'public'")"
      [[ "$data_access" == f ]] \
        || { echo "❌ ERROR: control role '$control_role' can read node data in '$db_name'"; exit 1; }
    done
  fi

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
