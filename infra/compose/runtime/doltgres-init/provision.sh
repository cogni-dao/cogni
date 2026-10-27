#!/bin/bash
set -euo pipefail

# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: infra/compose/doltgres-init/provision.sh
# Purpose: Idempotent Doltgres DB + role provisioning. Schema is owned by
#   drizzle-kit (see nodes/<node>/drizzle.doltgres.config.ts +
#   nodes/<node>/app/schema/ + generated .../doltgres-migrations/*.sql). This
#   script only creates the per-node knowledge databases and the reader/
#   writer roles. The migrator (doltgres-migrate-<node>) creates tables.
# Scope: Executed by doltgres-provision compose service (bootstrap profile).
# Invariants: Follows postgres-init/provision.sh pattern. Idempotent.
# Side-effects: IO (psql commands against Doltgres server)
# Links: docs/spec/knowledge-data-plane.md, nodes/poly/app/schema/README.md

DG_HOST="${DOLTGRES_HOST:-doltgres}"
DG_PORT="${DOLTGRES_PORT:-5432}"
DG_PASS="${DOLTGRES_PASSWORD:-doltgres}"
DG_READER_PASS="${DOLTGRES_READER_PASSWORD:-knowledge_reader}"
DG_WRITER_PASS="${DOLTGRES_WRITER_PASSWORD:-knowledge_writer}"

# Derive knowledge DB names from COGNI_NODE_DBS (same list as Postgres provisioning)
# cogni_operator → knowledge_operator, cogni_poly → knowledge_poly, etc.
if [ -z "${COGNI_NODE_DBS:-}" ]; then
  echo "❌ ERROR: COGNI_NODE_DBS is required (comma-separated list of node databases)"
  exit 1
fi

run_sql() {
  local db="$1"
  local sql="$2"
  PGPASSWORD="$DG_PASS" psql -h "$DG_HOST" -p "$DG_PORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -c "$sql"
}

run_sql_quiet() {
  local db="$1"
  local sql="$2"
  PGPASSWORD="$DG_PASS" psql -h "$DG_HOST" -p "$DG_PORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -c "$sql" 2>/dev/null || true
}

# Wait for Doltgres — probe the `postgres` DB itself, NOT pg_isready. On a FRESH volume the
# server accepts connections (pg_isready passes) a few seconds BEFORE it finishes creating the
# default `postgres` database, so a pg_isready-gated connect races straight into
# `database "postgres" does not exist`. Poll a real SELECT against `postgres` until it succeeds.
echo "⏳ Waiting for Doltgres postgres DB at $DG_HOST:$DG_PORT..."
ELAPSED=0
TIMEOUT=120
until PGPASSWORD="$DG_PASS" psql -h "$DG_HOST" -p "$DG_PORT" -U postgres -d postgres -c 'SELECT 1' >/dev/null 2>&1; do
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "❌ Timed out waiting for Doltgres postgres DB after ${TIMEOUT}s"
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
echo "✅ Doltgres postgres DB connectable."

# ── Roles ──────────────────────────────────────────────────────────────────
echo "🔧 Creating roles..."
# Doltgres doesn't support psql :'var' binding or pg_roles checks.
# Passwords are dev defaults or CI-derived (not user input) — direct interpolation is safe.
run_sql_quiet "postgres" "CREATE ROLE knowledge_reader WITH LOGIN PASSWORD '${DG_READER_PASS}'"
run_sql_quiet "postgres" "CREATE ROLE knowledge_writer WITH LOGIN PASSWORD '${DG_WRITER_PASS}'"
run_sql "postgres" "SELECT 1" > /dev/null
echo "   -> Roles ready (knowledge_reader, knowledge_writer)"

# ── Per-node databases (no schema; drizzle-kit owns that) ──────────────────
for COGNI_DB in $(echo "$COGNI_NODE_DBS" | tr ',' ' '); do
  # cogni_operator → knowledge_operator
  DB="knowledge_${COGNI_DB#cogni_}"
  echo "🔧 Provisioning database '$DB'..."
  run_sql_quiet "postgres" "CREATE DATABASE $DB"

  # Doltgres has partial/evolving GRANT support. Each statement is best-effort:
  # GRANT USAGE works on Doltgres 0.56.x; ALTER DEFAULT PRIVILEGES does not yet
  # (dolthub/doltgresql: "ALTER DEFAULT PRIVILEGES statement is not yet supported").
  # Doltgres roles are permissive by default on the `public` schema, so missing
  # grants there don't block reads/writes. The `dolt` system schema is NOT
  # permissive: without these grants, knowledge_writer gets "permission denied
  # for table status/branches/merge_status/conflicts" on every atomic branch
  # mutation (bug.5545) — @cogni-dao/doltgres-admission's clean-state checks
  # (dolt.status, dolt.branches, dolt.merge_status, dolt.conflicts) run on
  # every EDO hypothesize/decide/outcome write and every knowledge contribution.
  run_sql_quiet "$DB" "GRANT USAGE ON SCHEMA public TO knowledge_reader"
  run_sql_quiet "$DB" "GRANT USAGE ON SCHEMA public TO knowledge_writer"
  run_sql_quiet "$DB" "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO knowledge_reader"
  run_sql_quiet "$DB" "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knowledge_writer"
  run_sql_quiet "$DB" "GRANT USAGE ON SCHEMA dolt TO knowledge_reader"
  run_sql_quiet "$DB" "GRANT USAGE ON SCHEMA dolt TO knowledge_writer"
  run_sql_quiet "$DB" "GRANT SELECT ON ALL TABLES IN SCHEMA dolt TO knowledge_reader"
  run_sql_quiet "$DB" "GRANT SELECT ON ALL TABLES IN SCHEMA dolt TO knowledge_writer"

  # Provisioning does not own application working sets. Schema migrations and
  # admitted content writers own commits, including the first schema commit.

  echo "   -> $DB provisioned."
done

echo "✅ Doltgres provisioning complete (DBs + roles only; tables created by drizzle-kit migrator)."
