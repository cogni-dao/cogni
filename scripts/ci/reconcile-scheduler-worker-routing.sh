#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-scheduler-worker-routing.sh — on every node flight, propagate the
# catalog-rendered scheduler-worker base manifests to the per-env deploy branch
# (deploy/<env>-scheduler-worker) so a node-add actually reaches the worker.
#
# THE GAP THIS CLOSES (bug.5035 / bug.5021): the worker must poll one Temporal
# task queue per node, driven by COGNI_NODE_ENDPOINTS in its ConfigMap. The roll
# half exists — base/scheduler-worker/deployment.yaml carries the Reloader
# annotation (#1609), so the worker auto-rolls when its ConfigMap changes. But a
# node flight only refreshes deploy/<env>-<node>; the worker's Argo app syncs
# deploy/<env>-scheduler-worker, which a node-add NEVER refreshed — so the new
# ConfigMap never reached the cluster and Reloader had nothing to react to. The
# manual heal was exactly: refresh deploy/<env>-scheduler-worker from main. This
# script makes that refresh an idempotent, env-singleton reconcile on every flight.
#
# Env-singleton (substrate-registry: scheduler-worker-routing): desired state is a
# function of the whole node SET, so it is re-reconciled on EVERY node flight
# (affected-only governs image builds, never substrate routing). The source of
# truth is the PR-head app checkout's base/scheduler-worker — env-invariant,
# already gated against the catalog by render-scheduler-worker-endpoints.sh
# --check. We copy it (never re-render here: the deploy branch carries only the
# flighted node's catalog file, so re-rendering would drop sibling nodes).
#
# The env overlay (infra/k8s/overlays/<env>/scheduler-worker) — which pins the
# image digest + patches TEMPORAL_NAMESPACE — is NEVER touched, so promotion
# state is preserved. Only infra/k8s/base/scheduler-worker/ is propagated.
#
# Idempotent: re-running with an unchanged catalog produces no diff → no commit
# (status "noop"). The single per-env CI concurrency group serializes flights so
# concurrent node flights never race on the shared branch.
#
# Usage:
#   reconcile-scheduler-worker-routing.sh <env>
#
# Env:
#   APP_SOURCE_DIR     PR-head app checkout (default "."); source of the
#                      catalog-rendered base/scheduler-worker + the renderer.
#   GH_TOKEN           push auth (required unless DRY_RUN=1 or DEPLOY_BRANCH_DIR set).
#   GITHUB_REPOSITORY  owner/repo to clone (required unless DEPLOY_BRANCH_DIR set).
#   DEPLOY_BRANCH_DIR  reuse an existing deploy-branch checkout instead of cloning
#                      (tests / local). When set, no clone and no push.
#   DRY_RUN=1          render + diff only; never push (commits locally for the diff).
#   SWR_RECONCILE_SUMMARY_FILE  optional path to receive one structured JSON summary.
set -euo pipefail

rc=0 # assigned by the EXIT traps below ($? at fire time); declared for shellcheck.
DEPLOY_ENV=""
for arg in "$@"; do
  case "$arg" in
    -*) echo "[ERROR] reconcile-scheduler-worker-routing: unknown flag: $arg" >&2; exit 1 ;;
    *) DEPLOY_ENV="$arg" ;;
  esac
done
if [ -z "$DEPLOY_ENV" ]; then
  echo "Usage: reconcile-scheduler-worker-routing.sh <env>" >&2
  exit 1
fi

APP_SOURCE_DIR="${APP_SOURCE_DIR:-.}"
BRANCH="deploy/${DEPLOY_ENV}-scheduler-worker"
BOOTSTRAP_BRANCH="deploy/${DEPLOY_ENV}"
SUBPATH="infra/k8s/base/scheduler-worker"
SRC_DIR="${APP_SOURCE_DIR}/${SUBPATH}"

ENDPOINTS_COUNT=0
NODE_COUNT=0
STATUS="unknown"
SUMMARY_WRITTEN=false

write_summary() {
  [ -n "${SWR_RECONCILE_SUMMARY_FILE:-}" ] || return 0
  local status="$1"
  SWR_STATUS="$status" \
    SWR_DEPLOY_ENV="$DEPLOY_ENV" \
    SWR_BRANCH="$BRANCH" \
    SWR_ENDPOINTS_COUNT="$ENDPOINTS_COUNT" \
    SWR_NODE_COUNT="$NODE_COUNT" \
    SWR_DRY_RUN="${DRY_RUN:-}" \
    SWR_WORKFLOW="${GITHUB_WORKFLOW:-}" \
    SWR_JOB="${GITHUB_JOB:-}" \
    SWR_RUN_ID="${GITHUB_RUN_ID:-}" \
    SWR_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}" \
    SWR_REF="${GITHUB_REF_NAME:-}" \
    SWR_WORKFLOW_SHA="${GITHUB_SHA:-}" \
    SWR_HEAD_SHA="${SWR_RECONCILE_HEAD_SHA:-}" \
    SWR_NODE_SOURCE_SHA="${SWR_RECONCILE_NODE_SOURCE_SHA:-}" \
    SWR_PR_NUMBER="${SWR_RECONCILE_PR_NUMBER:-}" \
    SWR_NODE_SLUG="${SWR_RECONCILE_NODE_SLUG:-}" \
    SWR_STATUS_URL="${SWR_RECONCILE_STATUS_URL:-}" \
    SWR_COMMIT_SHA="${COMMIT_SHA:-}" \
    python3 - <<'PY' >"${SWR_RECONCILE_SUMMARY_FILE}.tmp" || return 0
import datetime
import os

def boolish(name):
    return os.environ.get(name, "") in ("1", "true", "True")

def intish(name):
    try:
        return int(os.environ.get(name, "") or 0)
    except ValueError:
        return 0

payload = {
    "schema_version": 1,
    "type": "scheduler_worker_routing_reconcile",
    "status": os.environ["SWR_STATUS"],
    "deploy_env": os.environ["SWR_DEPLOY_ENV"],
    "branch": os.environ["SWR_BRANCH"],
    "endpoints_count": intish("SWR_ENDPOINTS_COUNT"),
    "node_count": intish("SWR_NODE_COUNT"),
    "dry_run": boolish("SWR_DRY_RUN"),
    "workflow": os.environ.get("SWR_WORKFLOW", ""),
    "job": os.environ.get("SWR_JOB", ""),
    "run_id": os.environ.get("SWR_RUN_ID", ""),
    "attempt": os.environ.get("SWR_ATTEMPT", ""),
    "ref": os.environ.get("SWR_REF", ""),
    "workflow_sha": os.environ.get("SWR_WORKFLOW_SHA", ""),
    "head_sha": os.environ.get("SWR_HEAD_SHA", ""),
    "node_source_sha": os.environ.get("SWR_NODE_SOURCE_SHA", ""),
    "pr_number": os.environ.get("SWR_PR_NUMBER", ""),
    "node_slug": os.environ.get("SWR_NODE_SLUG", ""),
    "status_url": os.environ.get("SWR_STATUS_URL", ""),
    "commit_sha": os.environ.get("SWR_COMMIT_SHA", ""),
    "emitted_at": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
import json
print(json.dumps(payload, separators=(",", ":")))
PY
  mv "${SWR_RECONCILE_SUMMARY_FILE}.tmp" "$SWR_RECONCILE_SUMMARY_FILE" 2>/dev/null || return 0
  SUMMARY_WRITTEN=true
}

trap 'rc=$?; if [ "$rc" -ne 0 ] && [ "$SUMMARY_WRITTEN" != "true" ]; then write_summary "failure"; fi' EXIT

# ── Source validation ─────────────────────────────────────────────────────────
if [ ! -d "$SRC_DIR" ]; then
  echo "[ERROR] source manifests absent: $SRC_DIR (is APP_SOURCE_DIR correct?)" >&2
  exit 1
fi
if [ ! -f "$SRC_DIR/configmap.yaml" ]; then
  echo "[ERROR] $SRC_DIR/configmap.yaml missing — cannot propagate routing" >&2
  exit 1
fi

# Self-validate against the catalog before propagating: never ship a stale routing
# table to the worker. The renderer is the same SSOT the static gate uses; if it is
# absent at this ref (pre-#1609 head) we warn + skip rather than 127, mirroring DNS.
if [ -f "$APP_SOURCE_DIR/scripts/ci/render-scheduler-worker-endpoints.sh" ]; then
  if ! ( cd "$APP_SOURCE_DIR" && bash scripts/ci/render-scheduler-worker-endpoints.sh --check ); then
    echo "[ERROR] base scheduler-worker configmap is stale vs catalog — refusing to propagate." >&2
    echo "        Run: bash scripts/ci/render-scheduler-worker-endpoints.sh --write" >&2
    exit 1
  fi
else
  echo "::warning::render-scheduler-worker-endpoints.sh absent at this ref — propagating committed configmap without re-validation"
fi

# Counts are telemetry only — the propagation itself is rsync + git, so a missing
# yq must never block the reconcile.
ENDPOINTS_CSV=""
if command -v yq >/dev/null 2>&1; then
  ENDPOINTS_CSV="$(yq -N '.data.COGNI_NODE_ENDPOINTS // ""' "$SRC_DIR/configmap.yaml" 2>/dev/null || true)"
fi
if [ -n "$ENDPOINTS_CSV" ]; then
  ENDPOINTS_COUNT="$(awk -F',' '{print NF}' <<<"$ENDPOINTS_CSV")"
  # slug aliases only (skip uuid=... aliases): one per node.
  NODE_COUNT="$(tr ',' '\n' <<<"$ENDPOINTS_CSV" | grep -cvE '^[0-9a-f]{8}-' || true)"
fi
echo "Reconciling scheduler-worker routing for env '${DEPLOY_ENV}' → ${BRANCH}"
echo "  ${NODE_COUNT} node(s), ${ENDPOINTS_COUNT} endpoint alias(es)"

# ── Resolve the deploy-branch checkout ────────────────────────────────────────
CLONED_DIR=""
if [ -n "${DEPLOY_BRANCH_DIR:-}" ]; then
  WORKDIR="$DEPLOY_BRANCH_DIR"
else
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required to clone (or set DEPLOY_BRANCH_DIR)}"
  : "${GH_TOKEN:?GH_TOKEN required to clone/push (or set DRY_RUN=1 + DEPLOY_BRANCH_DIR)}"
  CLONED_DIR="$(mktemp -d -t swr-deploy-branch.XXXXXX)"
  WORKDIR="$CLONED_DIR/repo"
  git clone --quiet "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$WORKDIR"
  (
    cd "$WORKDIR"
    git fetch --quiet origin "+refs/heads/deploy/*:refs/remotes/origin/deploy/*"
    if git rev-parse --verify --quiet "refs/remotes/origin/${BRANCH}" >/dev/null; then
      git checkout -B "$BRANCH" "origin/${BRANCH}" >/dev/null 2>&1
    else
      echo "::warning::${BRANCH} missing — bootstrapping from ${BOOTSTRAP_BRANCH}"
      git fetch --quiet origin "$BOOTSTRAP_BRANCH"
      git checkout -B "$BRANCH" "origin/${BOOTSTRAP_BRANCH}" >/dev/null 2>&1
    fi
  )
fi
trap 'rc=$?; [ -n "$CLONED_DIR" ] && rm -rf "$CLONED_DIR"; if [ "$rc" -ne 0 ] && [ "$SUMMARY_WRITTEN" != "true" ]; then write_summary "failure"; fi' EXIT

DST_DIR="${WORKDIR}/${SUBPATH}"
mkdir -p "$DST_DIR"

# Propagate the env-invariant base/scheduler-worker (configmap + the Reloader-
# annotated deployment + services). --delete keeps it byte-identical to main so a
# pre-#1609 deploy branch also gains the Reloader annotation.
rsync -a --delete "$SRC_DIR/" "$DST_DIR/"

git -C "$WORKDIR" config user.name "github-actions[bot]"
git -C "$WORKDIR" config user.email "github-actions[bot]@users.noreply.github.com"
git -C "$WORKDIR" add -A "$SUBPATH"
if git -C "$WORKDIR" diff --cached --quiet; then
  STATUS="noop"
  write_summary "$STATUS"
  echo "scheduler-worker routing already current — ${BRANCH} unchanged (no-op)."
  exit 0
fi

COMMIT_MSG="candidate-flight: scheduler-worker routing (${NODE_COUNT} nodes)"
[ -n "${SWR_RECONCILE_NODE_SOURCE_SHA:-}" ] && COMMIT_MSG="${COMMIT_MSG} node-ref ${SWR_RECONCILE_NODE_SOURCE_SHA}"
git -C "$WORKDIR" commit --quiet -m "$COMMIT_MSG"
COMMIT_SHA="$(git -C "$WORKDIR" rev-parse HEAD)"

if [ "${DRY_RUN:-}" = "1" ] || [ -n "${DEPLOY_BRANCH_DIR:-}" ]; then
  STATUS="updated-local"
  write_summary "$STATUS"
  echo "scheduler-worker routing updated locally (${COMMIT_SHA:0:8}); push skipped (DRY_RUN / DEPLOY_BRANCH_DIR)."
  exit 0
fi

git -C "$WORKDIR" push --quiet origin "HEAD:${BRANCH}"
STATUS="updated"
write_summary "$STATUS"
echo "scheduler-worker routing propagated to ${BRANCH} (${COMMIT_SHA:0:8}) — Argo sync + Reloader will roll the worker."
