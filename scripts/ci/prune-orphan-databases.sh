#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Drop databases that no catalog row can produce — dump first, assert idle, assert
# underivable, then DROP. Runs on the env's VM inside the runtime Compose project.
#
# WHY THIS IS A SCRIPT AND NOT AN SSH SESSION. Privileged SQL on a fleet instance
# belongs on the governed path, not in someone's terminal (database-expert skill:
# "Production recovery and privileged SQL use the governed operator/runbook path.
# Routine SSH and ad-hoc direct writes are not the operating model"). The node-scoped
# repair plane that should own this is story.5052, still needs_design, so this is the
# narrowest possible stand-in: ONE verb, an explicit committed allowlist, no wildcards,
# and a dump that makes an irreversible statement reversible.
#
# FOUR GUARDS, ALL FAIL-CLOSED, PER DATABASE:
#   1. It is named in ORPHAN_DATABASES_FILE. There is no pattern matching and no
#      "prune everything not in the roster" mode — an over-broad DROP is far worse
#      than the orphans (same rule the Grafana datasource prune follows, bug.5117).
#   2. No catalog row can derive the name, in EITHER derivation: the laneless
#      `cogni_<node>` and the lane-aware `cogni_<node>_<lane>` for every env in that
#      node's `envs:` list. A name the provisioner can recreate is not an orphan.
#   3. pg_stat_activity shows zero backends for it RIGHT NOW. The 7-day metric that
#      nominated it is evidence, not authorization. Plain DROP (never WITH FORCE) so a
#      connection that appears between the check and the statement fails the run loudly
#      instead of being terminated.
#   4. A pg_dump landed, is non-empty, and its sha256 is logged. Verified before the
#      DROP, so the rollback artifact provably exists first.
#
# Idempotent: a name already absent is reported and skipped, so a normal reconcile
# re-runs this harmlessly forever.
#
# Links: bug.5299, story.5052, docs/spec/databases.md

set -euo pipefail

: "${DEPLOY_ENVIRONMENT:?DEPLOY_ENVIRONMENT is required}"
ORPHAN_DATABASES_FILE="${ORPHAN_DATABASES_FILE:?ORPHAN_DATABASES_FILE is required}"
PRUNE_DUMP_DIR="${PRUNE_DUMP_DIR:-/backups/orphan-prune}"
POSTGRES_ROOT_USER="${POSTGRES_ROOT_USER:-postgres}"
DRY_RUN="${ORPHAN_PRUNE_DRY_RUN:-1}"
COMPOSE="${RUNTIME_COMPOSE:-docker compose}"

log() { printf '[orphan-prune] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

psql_q() {
  # shellcheck disable=SC2086
  $COMPOSE exec -T postgres psql -U "$POSTGRES_ROOT_USER" -d postgres -tAc "$1" </dev/null
}

[[ -f "$ORPHAN_DATABASES_FILE" ]] || die "allowlist not found: $ORPHAN_DATABASES_FILE"

# ── Guard 2 input: every name any catalog row can produce, in both derivations ──
derivable_names() {
  local catalog="${COGNI_CATALOG_ROOT:-infra/catalog}" f node env ctl sfx
  for f in "$catalog"/*.yaml; do
    node="$(basename "$f" .yaml)"
    [[ "$node" == "_schema" ]] && continue
    printf 'cogni_%s\n' "${node//-/_}"
    for env in $(yq -r '(.envs // [])[]' "$f" 2>/dev/null); do
      ctl="$(control_env_for "$env" "$node" 2>/dev/null || echo "$env")"
      sfx=""
      [[ "$ctl" != "$env" ]] && sfx="_${env//-/_}"
      printf 'cogni_%s%s\n' "${node//-/_}" "$sfx"
    done
  done
}

# WHERE GUARD 2 IS COMPUTED. The catalog and `yq` live on the RUNNER; the VM has
# neither, and shipping the catalog to every VM just to answer a name question would
# add a second source of truth to keep in sync. So the caller computes the derivable
# set where the catalog actually is and passes it in; only the psql guards need the VM.
# Absent input, the script computes it itself — which is what the local tests do.
if [[ -n "${ORPHAN_PRUNE_DERIVABLE:-}" ]]; then
  DERIVABLE="$(printf '%s\n' "$ORPHAN_PRUNE_DERIVABLE" | tr ', ' '\n' | sed '/^$/d' | sort -u)"
  log "derivable set supplied by the caller"
else
  if ! command -v control_env_for >/dev/null 2>&1; then
    # shellcheck source=scripts/ci/lib/appset-paths.sh
    source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/appset-paths.sh"
  fi
  command -v yq >/dev/null 2>&1 ||
    die "no ORPHAN_PRUNE_DERIVABLE supplied and yq is unavailable to read the catalog — refusing to prune without guard 2"
  DERIVABLE="$(derivable_names | sort -u)"
fi
[[ -n "$DERIVABLE" ]] ||
  die "the catalog produced zero derivable database names — refusing to prune against an empty roster, because every orphan check would pass vacuously"
log "catalog derives $(printf '%s\n' "$DERIVABLE" | wc -l | tr -d ' ') database name(s)"

mkdir -p "$PRUNE_DUMP_DIR"
dropped=0 skipped=0

while IFS= read -r db; do
  db="${db%%#*}"; db="$(printf '%s' "$db" | tr -d '[:space:]')"
  [[ -n "$db" ]] || continue

  # Guard 1 is the file itself. Guard 2:
  if printf '%s\n' "$DERIVABLE" | grep -qxF "$db"; then
    die "$db IS derivable from the catalog — it is a live database, not an orphan. Remove it from $ORPHAN_DATABASES_FILE or fix the catalog."
  fi

  if [[ "$(psql_q "SELECT count(*) FROM pg_database WHERE datname='${db}'" | tr -d '[:space:]')" != "1" ]]; then
    log "$db absent — nothing to do"
    skipped=$((skipped + 1))
    continue
  fi

  # Guard 3: idle right now, not idle last week.
  backends="$(psql_q "SELECT count(*) FROM pg_stat_activity WHERE datname='${db}'" | tr -d '[:space:]')"
  [[ "$backends" == "0" ]] ||
    die "$db has ${backends} live backend(s) right now — it is in use. Refusing to drop; investigate who is connected before nominating it again."

  # Guard 4: the rollback artifact exists before the irreversible statement.
  dump="${PRUNE_DUMP_DIR}/${db}.sql"
  log "dumping $db to $dump"
  # shellcheck disable=SC2086
  $COMPOSE exec -T postgres pg_dump -U "$POSTGRES_ROOT_USER" --format=plain "$db" </dev/null >"$dump" ||
    die "pg_dump of $db failed — no rollback artifact, so no DROP"
  [[ -s "$dump" ]] || die "pg_dump of $db produced an EMPTY file — refusing to drop without a usable rollback artifact"
  log "$db dump $(wc -c <"$dump" | tr -d ' ') bytes sha256=$( (sha256sum "$dump" 2>/dev/null || shasum -a 256 "$dump") | awk '{print $1}')"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY RUN: would DROP DATABASE ${db} (0 backends, not catalog-derivable, dump verified)"
    continue
  fi

  log "DROP DATABASE ${db}"
  psql_q "DROP DATABASE \"${db}\"" >/dev/null
  [[ "$(psql_q "SELECT count(*) FROM pg_database WHERE datname='${db}'" | tr -d '[:space:]')" == "0" ]] ||
    die "$db still present after DROP"
  log "$db dropped"
  dropped=$((dropped + 1))
done <"$ORPHAN_DATABASES_FILE"

log "done: dropped=${dropped} skipped=${skipped} dry_run=${DRY_RUN} env=${DEPLOY_ENVIRONMENT}"
