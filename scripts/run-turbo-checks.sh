#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/run-turbo-checks.sh
# Purpose: Run workspace-scoped turbo tasks for local check scripts.
#          Feature branches use `--affected` against origin/main by default;
#          integration branches fall back to full workspace runs.
# Usage: bash scripts/run-turbo-checks.sh typecheck
#        bash scripts/run-turbo-checks.sh test --concurrency=1
# Exit: 0 if the requested turbo run succeeds, 1 otherwise

set -euo pipefail

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
EXPLICIT_SCOPE=false
UPSTREAM_REF=${TURBO_SCM_BASE:-}
HEAD_REF=${TURBO_SCM_HEAD:-HEAD}

if [ -n "${TURBO_SCM_BASE:-}" ] || [ -n "${TURBO_SCM_HEAD:-}" ]; then
  EXPLICIT_SCOPE=true
fi

if [ -z "$UPSTREAM_REF" ] && git show-ref --verify --quiet refs/remotes/origin/main; then
  UPSTREAM_REF="origin/main"
fi

if [ -z "$UPSTREAM_REF" ]; then
  UPSTREAM_REF=$(git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null || true)
fi

use_affected=false
if [ "$EXPLICIT_SCOPE" = true ]; then
  use_affected=true
elif [ -n "$UPSTREAM_REF" ] && [ "$CURRENT_BRANCH" != "main" ]; then
  use_affected=true
fi

# Match CI's fake-but-valid defaults so per-workspace Vitest runs can import
# serverEnv()-validated modules without requiring a local .env.test setup.
export NODE_ENV="${NODE_ENV:-test}"
export APP_ENV="${APP_ENV:-test}"
export DATABASE_URL="${DATABASE_URL:-postgresql://user:password@localhost:5432/cogni_test}"
export DATABASE_SERVICE_URL="${DATABASE_SERVICE_URL:-postgresql://user_service:password@localhost:5432/cogni_test}"
export COGNI_REPO_PATH="${COGNI_REPO_PATH:-$(pwd)}"
export LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-build-key}"
export AUTH_SECRET="${AUTH_SECRET:-tNf5lFM9yMhdgwS5yeQB8Y2kmigblBqobkvI2XN2brg=}"
export SCHEDULER_API_TOKEN="${SCHEDULER_API_TOKEN:-test-scheduler-api-token-for-ci-min32chars}"
export BILLING_INGEST_TOKEN="${BILLING_INGEST_TOKEN:-test-billing-ingest-token-for-ci-min32ch}"
export DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-test-discord-bot-token-for-ci}"
export POSTHOG_API_KEY="${POSTHOG_API_KEY:-phc_test_key_for_ci}"
export POSTHOG_HOST="${POSTHOG_HOST:-http://localhost:18000}"
export TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"
export TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE:-cogni-test}"
export TEMPORAL_TASK_QUEUE="${TEMPORAL_TASK_QUEUE:-scheduler-tasks}"

# Compact output for check:fast. Passing tasks suppress stdout; failing tasks
# stream grouped output with no per-line package prefix. Override with
# TURBO_LOG_MODE=full for debugging.
if [ "${TURBO_LOG_MODE:-compact}" = "compact" ]; then
  TURBO_LOG_FLAGS=(--output-logs=errors-only --log-order=grouped --log-prefix=none)
else
  TURBO_LOG_FLAGS=()
fi

if [ "$use_affected" = true ]; then
  export TURBO_SCM_BASE="$UPSTREAM_REF"
  export TURBO_SCM_HEAD="$HEAD_REF"
  echo "Turbo scope: affected (${TURBO_SCM_BASE}...${TURBO_SCM_HEAD})"
  exec pnpm turbo run "$@" --affected "${TURBO_LOG_FLAGS[@]}"
fi

echo "Turbo scope: full"
exec pnpm turbo run "$@" "${TURBO_LOG_FLAGS[@]}"
