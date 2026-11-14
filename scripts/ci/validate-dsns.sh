#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/validate-dsns.sh
# Purpose: Validate DSN secrets before deploy (DSN-first: DSNs are authoritative)
# Invariants:
#   - DSNs are the single source of truth for runtime
#   - Usernames must be distinct (app vs service role)
#   - Usernames must not be superuser names (postgres, root, admin, superuser)
#   - Never echo full DSNs; mask them in workflow logs
# Usage: Called by deploy workflows before SSH to VM
# Links: https://cognidao.org/knowledge/node-database-contract

set -euo pipefail

# Required inputs (DSNs only - no component secrets)
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${DATABASE_SERVICE_URL:?DATABASE_SERVICE_URL is required}"

# Mask DSNs immediately to prevent log exposure
echo "::add-mask::${DATABASE_URL}"
echo "::add-mask::${DATABASE_SERVICE_URL}"

# ── Extract username from DSN ────────────────────────────────────────────────
# Parse postgresql://user:pass@host:port/dbname using bash parameter expansion

extract_username() {
  local dsn="$1"
  # Remove scheme: postgresql://user:pass@host/db -> user:pass@host/db
  local without_scheme="${dsn#*://}"
  # Extract user:pass part (before @)
  local userpass="${without_scheme%%@*}"
  # Extract username (before :)
  echo "${userpass%%:*}"
}

APP_USER=$(extract_username "$DATABASE_URL")
SERVICE_USER=$(extract_username "$DATABASE_SERVICE_URL")

# ── Validate invariants ──────────────────────────────────────────────────────

ERRORS=()

# Check 1: Both DSNs are non-empty (already checked via :? above, but validate parsed values)
if [ -z "$APP_USER" ]; then
  ERRORS+=("DATABASE_URL has empty username")
fi
if [ -z "$SERVICE_USER" ]; then
  ERRORS+=("DATABASE_SERVICE_URL has empty username")
fi

# Check 2: Usernames must be distinct
if [ "$APP_USER" = "$SERVICE_USER" ]; then
  ERRORS+=("DATABASE_URL and DATABASE_SERVICE_URL have same username '${APP_USER}' (must be distinct for RLS isolation)")
fi

# Check 3: Usernames must not be superuser names
FORBIDDEN_USERS=("postgres" "root" "admin" "superuser")
for forbidden in "${FORBIDDEN_USERS[@]}"; do
  if [ "$APP_USER" = "$forbidden" ]; then
    ERRORS+=("DATABASE_URL username '${APP_USER}' is a forbidden superuser name")
  fi
  if [ "$SERVICE_USER" = "$forbidden" ]; then
    ERRORS+=("DATABASE_SERVICE_URL username '${SERVICE_USER}' is a forbidden superuser name")
  fi
done

# ── Report results ───────────────────────────────────────────────────────────

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "❌ DSN validation failed:" >&2
  for err in "${ERRORS[@]}"; do
    echo "   - $err" >&2
  done
  exit 1
fi

echo "✅ DSN secrets validated (app_user: ${APP_USER}, service_user: ${SERVICE_USER})"
