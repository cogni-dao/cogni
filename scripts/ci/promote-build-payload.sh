#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/promote-build-payload.sh
# Purpose: Apply a resolved image payload to a deploy-branch overlay via
#   promote-k8s-image.sh. Runs from the deploy-branch checkout.
#
# Side-effects:
#   - Writes overlay digest fields under infra/k8s/overlays/{OVERLAY_ENV}/.
#   - Emits $GITHUB_OUTPUT.promoted_apps = CSV of apps that received a new
#     digest. Empty string when the payload had no new digests — consumed
#     by verify-candidate / verify-deploy job-level gates (bug.0321 Fix 1).
#   - Merges per-promoted-app {app → source_sha} entries into
#     .promote-state/source-sha-by-app.json on the deploy branch. Consumed
#     by verify-buildsha.sh in SOURCE_SHA_MAP mode for cross-env/cross-PR
#     contract verification (bug.0321 Fix 4).
#
# bug.0328: promoted_apps is emitted incrementally after each successful
# promotion AND re-emitted by an EXIT trap, so a silent abort between
# promotions and the trailing output write cannot produce an empty
# promoted_apps while the deploy branch already carries real promotions.
# Source-sha-map writes are a second pass after all promotions are
# recorded; a map-write failure is logged but never shadows promoted_apps.
#
# Env:
#   PAYLOAD_FILE    (required) path to resolved-pr-images.json
#   OVERLAY_ENV     (required) candidate-a | preview | production
#   MAP_FILE        (optional) .promote-state/source-sha-by-app.json path
#   PROMOTE_SCRIPT  (optional) path to promote-k8s-image.sh
#   MAP_SCRIPT      (optional) path to update-source-sha-map.sh

set -euo pipefail

# Source catalog (ALL_TARGETS / NODE_TARGETS) so additions to infra/catalog/*
# flow through here without script edits. CATALOG_IS_SSOT (docs/spec/ci-cd.md
# axiom 16). task.5079 follow-up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/image-tags.sh
. "$SCRIPT_DIR/lib/image-tags.sh"

PAYLOAD_FILE=${PAYLOAD_FILE:-}
OVERLAY_ENV=${OVERLAY_ENV:-}
PROMOTE_SCRIPT=${PROMOTE_SCRIPT:-../app-src/scripts/ci/promote-k8s-image.sh}
# Per-app source-SHA map writer (bug.0321 Fix 4). Same relative path
# convention as PROMOTE_SCRIPT: callers run from the deploy-branch
# checkout, scripts live under ../app-src/.
MAP_SCRIPT=${MAP_SCRIPT:-../app-src/scripts/ci/update-source-sha-map.sh}
MAP_FILE=${MAP_FILE:-.promote-state/source-sha-by-app.json}

if [ -z "$PAYLOAD_FILE" ] || [ ! -f "$PAYLOAD_FILE" ]; then
  echo "[ERROR] PAYLOAD_FILE is required and must exist" >&2
  exit 1
fi

if [ -z "$OVERLAY_ENV" ]; then
  echo "[ERROR] OVERLAY_ENV is required" >&2
  exit 1
fi

# Track which apps actually had a non-empty digest and got written to the
# overlay. Emitted as $GITHUB_OUTPUT.promoted_apps so downstream
# verification jobs can (a) scope wait-for-argocd to only the apps that
# changed and (b) gate at the job level — an empty promoted_apps surfaces
# as a visibly skipped verify job instead of a silent-green skipped step.
PROMOTED=()
declare -A PROMOTED_SOURCE_SHA=()

emit_promoted_apps() {
  local csv=""
  if [ ${#PROMOTED[@]} -gt 0 ]; then
    csv=$(IFS=,; echo "${PROMOTED[*]}")
  fi
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    # Last-write-wins in $GITHUB_OUTPUT — incremental overwrites are safe.
    echo "promoted_apps=${csv}" >> "$GITHUB_OUTPUT"
  fi
}

# bug.0328: EXIT trap guarantees promoted_apps is written even on abort.
# Without this, a non-zero return from any command after the last
# promotion would leave promoted_apps empty despite real overlay writes,
# and release-slot would treat verify-candidate's (correct) job-level
# skip as a green flight. The trap pins the invariant: if promoted_apps
# is empty at gate evaluation time, no overlay was written.
trap emit_promoted_apps EXIT

extract_digest() {
  local target="$1"
  python3 - "$PAYLOAD_FILE" "$target" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
for item in payload["targets"]:
    if item["target"] == sys.argv[2]:
        print(item["digest"])
        break
PY
}

extract_source_sha() {
  local target="$1"
  python3 - "$PAYLOAD_FILE" "$target" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
fallback = payload.get("source_sha", "")
for item in payload["targets"]:
    if item["target"] == sys.argv[2]:
        print(item.get("source_sha") or fallback)
        break
PY
}

promote_target() {
  local target="$1"
  local digest item_source_sha

  # type:infra (e.g. litellm) deploys via Compose-on-VM, not k8s overlays —
  # there is no overlay digest to promote. deploy-infra resolves its content-
  # hash tag directly. Skip regardless of caller-supplied target list.
  is_infra_target "$target" && return 0

  digest=$(extract_digest "$target")
  [ -z "$digest" ] && return 0

  bash "$PROMOTE_SCRIPT" --no-commit --env "$OVERLAY_ENV" --app "$target" --digest "$digest"

  PROMOTED+=("$target")
  item_source_sha="$(extract_source_sha "$target")"
  PROMOTED_SOURCE_SHA["$target"]="$item_source_sha"
  # Re-emit after every success so a later abort still leaves an accurate
  # promoted_apps in $GITHUB_OUTPUT (last-write-wins).
  emit_promoted_apps
}

# Write a per-app `app → source_sha` entry into .promote-state/source-sha-by-app.json
# on the deploy branch. Called in a second pass after all promotions are
# recorded, so a map-write failure can never shadow promoted_apps. Per-app
# failures are surfaced as GitHub Actions `::warning::` annotations (visible
# in the run summary, not buried in stderr). If the map write fails for
# EVERY promoted app, the map stops recording provenance entirely — that
# is a hard break and the caller exits non-zero after pass 2.
MAP_FAILURES=0
update_source_sha_map() {
  local app="$1"
  local source_sha="${PROMOTED_SOURCE_SHA[$app]:-}"
  if [ -z "$source_sha" ]; then
    echo "::warning::source_sha missing from payload — skipping map update for ${app}"
    MAP_FAILURES=$((MAP_FAILURES + 1))
    return 0
  fi
  if ! APP="$app" SOURCE_SHA="$source_sha" MAP_FILE="$MAP_FILE" \
       bash "$MAP_SCRIPT"; then
    echo "::warning::source-sha-map write failed for ${app} — overlay already promoted, provenance side-car not updated"
    MAP_FAILURES=$((MAP_FAILURES + 1))
  fi
}

# Pass 1 — promotions. Each appends to PROMOTED and emits $GITHUB_OUTPUT.
# Catalog-driven: iterate ALL_TARGETS sourced from infra/catalog/. NODES env
# var (CSV) scopes a single-cell flight to its own matrix entry; unset =
# every catalog target. `promote_target` is a no-op for any target whose
# digest isn't in the payload (extract_digest returns empty), so iterating
# all targets is safe even on affected-only PR builds.
if [ -n "${NODES:-}" ]; then
  IFS=',' read -r -a _to_promote <<<"$NODES"
else
  _to_promote=("${ALL_TARGETS[@]}")
fi
for target in "${_to_promote[@]}"; do
  promote_target "$target"
done

# Pass 2 — source-sha-map. Non-fatal on per-app failure.
for app in "${PROMOTED[@]}"; do
  update_source_sha_map "$app"
done

# Final emission for the happy-path log line; trap EXIT would also fire
# this, but an explicit end-of-success message helps humans grep.
emit_promoted_apps
if [ ${#PROMOTED[@]} -eq 0 ]; then
  echo "Promoted apps: none"
else
  echo "Promoted apps: $(IFS=,; echo "${PROMOTED[*]}")"
fi

# Hard break: provenance side-car is dead across every promoted app.
# Partial failures are ::warning:: annotations above; total failure is an
# ::error:: that fails the flight job so humans investigate MAP_SCRIPT or
# the payload's source_sha field rather than letting provenance decay
# silently across future flights.
if [ ${#PROMOTED[@]} -gt 0 ] && [ "$MAP_FAILURES" -eq "${#PROMOTED[@]}" ]; then
  echo "::error::source-sha-map write failed for all ${#PROMOTED[@]} promoted app(s) — provenance side-car is dead (check MAP_SCRIPT=${MAP_SCRIPT} and payload source_sha)"
  exit 1
fi
