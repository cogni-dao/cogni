#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-observability.sh <env> — tofu-free, idempotent verify-and-heal of the
# two per-ENV substrate pieces the operator node-log proxy depends on, so EVERY
# env is "born observable" (GET /api/v1/nodes/{id}/observability/logs reads any
# node's logs out of the box). Sibling to reconcile-env-substrate.sh: same
# substrate-lane shape (SSH to the VM, idempotent upserts, a re-run is a no-op),
# callable WITHOUT a full tofu provision so an env provisioned BEFORE the feature
# existed can be healed in place.
#
# Two gaps it closes (each independently, both verify-and-heal):
#
#   Gap 1 — Alloy `node` Loki stream label not deployed (bug.5041).
#     The alloy-config*.alloy node-label promotion (task.5028) IS in repo, but it
#     only reaches a VM through deploy-infra.sh's runtime-bundle rsync — and the
#     promote pipeline SKIPS deploy-infra by default (skip_infra: true), so an
#     app-only promote never re-pushes the config. Prod's deployed Alloy is stale
#     → prod Loki has zero `node` label values → the proxy's forced {node="<id>"}
#     selector returns nothing. This script rsyncs the runtime configs, checksum-
#     restarts alloy on change (same gate deploy-infra.sh uses), then verifies the
#     restarted Alloy parsed the config.
#
#   Gap 2 — operator Grafana READ creds not seeded at cogni/<env>/operator.
#     The proxy reads GRAFANA_URL + GRAFANA_SERVICE_ACCOUNT_TOKEN from the operator
#     pod (createLokiReader), delivered via the operator ExternalSecret which
#     extracts ALL of cogni/<env>/operator. Provision Phase 5e mints these to
#     cogni/<env>/_shared but never mirrors them to the operator path, so the
#     proxy was wired BY HAND on candidate-a + prod. This script seeds the operator
#     path (source: human — mirrored from _shared, or from explicit inputs) and
#     force-refreshes the operator ExternalSecret so the pod is wired at birth.
#
# Auth + env (mirrors reconcile-env-substrate.sh):
#   VM_IP (or VM_HOST), SSH_OPTS — SSH to the env VM (root).
#   OPENBAO_ROOT_TOKEN or OPENBAO_ROOT_TOKEN_LOCAL (file) — Gap 2 OpenBao writes.
#     Optional: if absent, Gap 2 is SKIPPED (warn) and only Gap 1 runs.
#   GRAFANA_URL / GRAFANA_SERVICE_ACCOUNT_TOKEN (optional) — explicit values to
#     seed for Gap 2. If unset, the script mirrors whatever is already at
#     cogni/<env>/_shared (provision Phase 5e's auto-mint output). The glsa_ read
#     token + stack URL are the same single Grafana stack for every env (env is
#     just a Loki label), so the _shared mirror is correct.
#
# Usage: reconcile-observability.sh <candidate-a|preview|production>

set -euo pipefail

DEPLOY_ENV="${1:?usage: reconcile-observability.sh <candidate-a|preview|production>}"
[[ "$DEPLOY_ENV" =~ ^(candidate-a|candidate-b|preview|production)$ ]] \
  || { echo "❌ unsupported env: $DEPLOY_ENV" >&2; exit 2; }

VM_IP="${VM_IP:-${VM_HOST:-}}"
[[ -n "$VM_IP" ]] || { echo "❌ VM_IP (or VM_HOST) is required" >&2; exit 2; }
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=accept-new -o ConnectTimeout=30}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ROOT_TOKEN="${OPENBAO_ROOT_TOKEN:-}"
if [[ -z "$ROOT_TOKEN" && -n "${OPENBAO_ROOT_TOKEN_LOCAL:-}" && -r "${OPENBAO_ROOT_TOKEN_LOCAL}" ]]; then
  ROOT_TOKEN="$(cat "$OPENBAO_ROOT_TOKEN_LOCAL")"
fi

log() { printf '[reconcile-observability] %s\n' "$*"; }

# shellcheck disable=SC2086  # SSH_OPTS is an intentional word-split option string
remote() { ssh $SSH_OPTS "root@${VM_IP}" "$@"; }
bao_exec() {
  remote "kubectl exec -n openbao openbao-0 -- env BAO_TOKEN='${ROOT_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao $*"
}
# Read one field from cogni/<env>/<svc>; stdout = value (empty if absent).
bao_get_field() {
  local svc="$1" k="$2"
  bao_exec "kv get -format=json 'cogni/${DEPLOY_ENV}/${svc}'" 2>/dev/null \
    | jq -r --arg k "$k" '.data.data[$k] // empty' 2>/dev/null || true
}
# seed_kv: <service> <KEY> <value> → cogni/<env>/<service> (patch-or-put;
# first write creates the path, later writes preserve sibling keys). No-op on
# an empty value. Mirrors provision-env-vm.sh's seed_kv exactly.
seed_kv() {
  local svc="$1" k="$2" v="$3" path op="patch"
  [[ -z "$v" ]] && return 0
  path="cogni/${DEPLOY_ENV}/${svc}"
  if ! bao_exec "kv metadata get '${path}'" >/dev/null 2>&1; then op="put"; fi
  printf '%s' "$v" | remote \
    "kubectl exec -i -n openbao openbao-0 -- env BAO_TOKEN='${ROOT_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao kv ${op} '${path}' '${k}=-'" \
    >/dev/null
}

# Fail-loud deploy-pointer preflight (identical shape to reconcile-env-substrate.sh):
# a stale VM_HOST otherwise surfaces as a cryptic mid-run SSH timeout. Never echo
# the host/IP or raw ssh stderr (privacy: docs/spec/observability.md §5).
if ! ssh $SSH_OPTS -o BatchMode=yes -o ConnectTimeout=15 "root@${VM_IP}" true 2>/tmp/_obsprobe; then
  reason=unreachable
  grep -qi 'permission denied' /tmp/_obsprobe && reason=auth_denied
  rm -f /tmp/_obsprobe
  echo "::error::${DEPLOY_ENV}: VM SSH preflight failed (reason=${reason}) — deploy-pointer drift. The ${DEPLOY_ENV} VM was likely migrated/rebuilt without re-pointing VM_HOST + SSH_DEPLOY_KEY. See .claude/skills/devops-expert." >&2
  exit 1
fi
rm -f /tmp/_obsprobe

log "reconciling observability substrate for env '${DEPLOY_ENV}' on ${VM_IP}"

# ═══════════════════════════════════════════════════════════════════════════
# Gap 1 — re-push Alloy config + checksum-restart + verify (bug.5041)
# ═══════════════════════════════════════════════════════════════════════════
# Mirrors deploy-infra.sh's runtime-bundle rsync + Step 6.6d alloy checksum
# restart, scoped to JUST the alloy configs so it's a cheap, idempotent heal
# that doesn't require the full deploy-infra orchestration (and the secrets it
# pulls). The production stack mounts alloy-config.metrics.alloy (docker-compose
# .yml line ~495); alloy-config.alloy is the logs-only dev variant. We push the
# whole configs/ dir so both stay current.
log "Gap 1: re-pushing Alloy runtime configs to the VM..."
RUNTIME_DIR="/opt/cogni-template-runtime"
remote "mkdir -p ${RUNTIME_DIR}/configs"
# shellcheck disable=SC2086
rsync -a -e "ssh $SSH_OPTS" \
  "$REPO_ROOT/infra/compose/runtime/configs/" \
  "root@${VM_IP}:${RUNTIME_DIR}/configs/"

# Checksum-gated restart — same gate + hash file deploy-infra.sh uses, so a
# subsequent real deploy-infra run sees no drift and does NOT double-restart.
log "Gap 1: checksum-gated alloy restart (skips if unchanged)..."
remote bash -s <<'REMOTE_ALLOY'
set -euo pipefail
RUNTIME_DIR="/opt/cogni-template-runtime"
COMPOSE="docker compose --project-name cogni-runtime --env-file ${RUNTIME_DIR}/.env -f ${RUNTIME_DIR}/docker-compose.yml"
hash_file() { sha256sum "$1" 2>/dev/null | awk '{print $1}' || echo "no-hash-tool"; }
mkdir -p /var/lib/cogni
ALLOY_CONFIG="${RUNTIME_DIR}/configs/alloy-config.metrics.alloy"
ALLOY_HASH_FILE="/var/lib/cogni/alloy-config.sha256"
if [[ -f "$ALLOY_CONFIG" ]]; then
  NEW=$(hash_file "$ALLOY_CONFIG"); OLD=$(cat "$ALLOY_HASH_FILE" 2>/dev/null || echo none)
  if [[ "$NEW" != "$OLD" && "$NEW" != "no-hash-tool" ]]; then
    echo "[remote] alloy config changed (${NEW:0:12}...), restarting alloy"
    $COMPOSE restart alloy
    echo "$NEW" > "$ALLOY_HASH_FILE"
  else
    echo "[remote] alloy config unchanged (${NEW:0:12}...), no restart"
  fi
else
  echo "[remote] WARN: $ALLOY_CONFIG missing — is the runtime stack up?"
fi
REMOTE_ALLOY

# Verify the running Alloy parsed the config (the node-label stage lives in
# loki.process "docker_logs"). A bad config leaves Alloy crash-looping; a healthy
# container that has the metrics config mounted is our proxy-readiness signal.
# We CANNOT assert the `node` Loki LABEL here without querying Grafana Cloud (the
# label only appears once a node-tagged log line ships); that end-to-end assert
# lives in /validate-candidate. This step proves the heal landed + Alloy is live.
log "Gap 1: verifying Alloy is up and serving the metrics config..."
if remote "docker inspect -f '{{.State.Running}}' cogni-runtime-alloy-1 2>/dev/null" | grep -q true; then
  if remote "grep -q 'node = \"\"' ${RUNTIME_DIR}/configs/alloy-config.metrics.alloy"; then
    log "Gap 1: ✅ Alloy running with node-label promotion present in the deployed config"
  else
    echo "::error::${DEPLOY_ENV}: deployed alloy-config.metrics.alloy is MISSING the node-label stage after rsync" >&2
    exit 1
  fi
else
  log "Gap 1: ⚠️ alloy container not running (stack may be down) — config pushed; it will load on next start"
fi

# ═══════════════════════════════════════════════════════════════════════════
# Gap 2 — seed operator Grafana read creds at cogni/<env>/operator
# ═══════════════════════════════════════════════════════════════════════════
# The operator ExternalSecret extracts ALL of cogni/<env>/operator, so seeding
# these two keys there wires the node-log proxy's Loki credential at birth.
# source: human — we never auto-generate. Value precedence:
#   1. explicit GRAFANA_URL / GRAFANA_SERVICE_ACCOUNT_TOKEN env (operator paste)
#   2. mirror from cogni/<env>/_shared (provision Phase 5e auto-mint output)
# Idempotent: if the operator path already carries non-empty values and no
# explicit override is given, we leave them (0 churn).
if [[ -z "$ROOT_TOKEN" ]]; then
  log "Gap 2: ⚠️ no OpenBao root token (set OPENBAO_ROOT_TOKEN[_LOCAL]) — skipping operator Grafana cred seed"
else
  log "Gap 2: seeding operator Grafana read creds at cogni/${DEPLOY_ENV}/operator..."
  for k in GRAFANA_URL GRAFANA_SERVICE_ACCOUNT_TOKEN; do
    explicit="${!k:-}"
    existing="$(bao_get_field operator "$k")"
    if [[ -n "$explicit" ]]; then
      val="$explicit"
    elif [[ -n "$existing" ]]; then
      log "Gap 2:   cogni/${DEPLOY_ENV}/operator/${k} already set — leaving (0 churn)"
      continue
    else
      val="$(bao_get_field _shared "$k")"
      if [[ -z "$val" ]]; then
        log "Gap 2:   ⚠️ ${k} unset at operator AND _shared, and no explicit value — skipping (provide it or run Phase 5e auto-mint)"
        continue
      fi
      log "Gap 2:   mirroring ${k} from cogni/${DEPLOY_ENV}/_shared → operator"
    fi
    seed_kv operator "$k" "$val"
    log "Gap 2:   seeded cogni/${DEPLOY_ENV}/operator/${k}"
  done

  # Force-refresh the operator ExternalSecret so ESO pulls the new keys into the
  # operator-env-secrets k8s Secret immediately (vs the 1h refresh cycle). Same
  # acceleration pattern as deploy-infra.sh refresh_operator_openfga_secret;
  # absent ES on a fresh env is benign (ESO syncs on first rollout).
  K8S_NS="cogni-${DEPLOY_ENV}"
  for es in operator-env-secrets env-secrets; do
    if remote "kubectl -n ${K8S_NS} get externalsecret ${es}" >/dev/null 2>&1; then
      remote "kubectl -n ${K8S_NS} annotate externalsecret ${es} force-sync=$(date +%s) --overwrite" >/dev/null 2>&1 \
        && log "Gap 2:   requested ESO refresh for ${es}" || true
      break
    fi
  done
fi

log "observability substrate reconciled for ${DEPLOY_ENV} (idempotent; re-run is a no-op)"
