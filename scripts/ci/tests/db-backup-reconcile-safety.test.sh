#!/usr/bin/env bash
set -euo pipefail

# Regression contract for bug.5252: an infra reconcile must not launch a full
# production database dump, overlap backup executors, or hide the evidence when
# PostgreSQL loses a backend.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEPLOY="$ROOT/scripts/ci/deploy-infra.sh"
COMPOSE="$ROOT/infra/compose/runtime/docker-compose.yml"
ALLOY="$ROOT/infra/compose/runtime/configs/alloy-config.metrics.alloy"

grep -Fq 'if [[ "$DEPLOY_ENVIRONMENT" == candidate-* ]]; then' "$DEPLOY"
grep -Fq 'systemctl start cogni-db-backup.service' "$DEPLOY"
grep -Fq 'Skipping inline full backup in ${DEPLOY_ENVIRONMENT}' "$DEPLOY"
grep -Fq 'OnActiveSec=${BACKUP_INTERVAL_SECONDS}s' "$DEPLOY"
grep -Fq 'OnUnitInactiveSec=${BACKUP_INTERVAL_SECONDS}s' "$DEPLOY"
! grep -Fq 'OnBootSec=15min' "$DEPLOY"
! grep -Fq 'OnUnitActiveSec=' "$DEPLOY"
! grep -Fq '$RUNTIME_COMPOSE --profile backup stop db-backup' "$DEPLOY"

stop_line="$(grep -nF 'systemctl stop cogni-db-backup.timer' "$DEPLOY" | cut -d: -f1)"
service_line="$(grep -nF 'systemctl start cogni-db-backup.service' "$DEPLOY" | cut -d: -f1)"
timer_line="$(grep -nF 'systemctl start cogni-db-backup.timer' "$DEPLOY" | cut -d: -f1)"
test "$stop_line" -lt "$service_line"
test "$service_line" -lt "$timer_line"

grep -Fq 'mem_limit: 512m' "$COMPOSE"
grep -Fq 'oom_score_adj: 500' "$COMPOSE"
grep -Fq '/var/log/journal:/var/log/journal:ro' "$COMPOSE"
grep -Fq 'loki.source.journal "kernel"' "$ALLOY"
grep -Fq 'matches        = "_TRANSPORT=kernel"' "$ALLOY"
grep -Eq 'regex[[:space:]]*= .*postgres.*temporal-postgres' "$ALLOY"

echo "PASS: db-backup-reconcile-safety.test.sh"
