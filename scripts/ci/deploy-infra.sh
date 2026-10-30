#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/deploy-infra.sh
# Purpose: Infra lever (task.0314) — deploy Compose infrastructure (postgres,
#          litellm, temporal, redis, alloy, caddy) to a remote VM via SSH. App
#          containers are managed by k8s/Argo CD; this script only handles
#          infra services.
# Usage:
#   deploy-infra.sh [--ref <git-ref>] [--dry-run] [--recover-installed-runtime]
#     --ref <git-ref>  Source ref for infra/compose/** (default: main). Rsync
#                      source is a detached `git worktree add` of this ref,
#                      NOT the caller workflow's checkout. An app PR branched
#                      before an infra change on main cannot ship stale compose
#                      config to the VM.
#     --dry-run        Validate config + worktree resolution, print planned
#                      actions, exit 0 without any SSH.
#     --k8s-secrets-only
#                      Update k8s app secrets + roll pods without touching
#                      Compose infra. Bridge mode until pods consume ESO.
#     --recover-installed-runtime
#                      Validate the installed last-good receipt, then start only
#                      postgres, LiteLLM, and autoheal without reading custody,
#                      pulling images, or changing installed files.
# Invariants:
#   - DEPLOY_ENVIRONMENT must be set to 'candidate-a', 'preview', or 'production'
#     (legacy 'canary' value is still accepted for backward compatibility during
#     the bug.0312 rename; will be removed once no caller sends it)
#   - App/migrator/scheduler-worker containers are NOT started (k8s handles those)
#   - DB migrations are NOT run (k8s PreSync hook handles those)
#   - SSH_KEEPALIVE: All SSH connections use ServerAliveInterval to survive long operations.
#   - SSH_MULTIPLEXED (bug.5159): every ssh/scp/rsync leg rides ONE ControlMaster
#     transport over a per-run mktemp socket, so the ~12-leg deploy performs a
#     single handshake and cannot trip sshd's MaxStartups admission control.
#   - INFRA_REF_IS_EXPLICIT (task.0314): rsync source is a clean worktree of --ref,
#     never the caller's working tree.
# Callers:
#   - .github/workflows/candidate-flight-infra.yml  (candidate-a infra lever)
#   - .github/workflows/promote-and-deploy.yml      (preview/prod deploy-infra job)

set -euo pipefail

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Flag parsing
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# --ref <git-ref>  Source ref for infra/compose/** (default: main).
#                  Rsync to the VM comes from a detached `git worktree add`
#                  of this ref, NOT from whatever the caller has checked out.
#                  This is the INFRA_REF_IS_EXPLICIT invariant (task.0314).
# --dry-run        Resolve the source worktree and print planned actions
#                  (rsync source, VM target, services) without any SSH.
# --k8s-secrets-only
#                  Update k8s app secrets + roll pods without touching Compose.
REF="main"
DRY_RUN=false
K8S_SECRETS_ONLY=false
RECOVER_INSTALLED_RUNTIME=false
usage() {
  echo "Usage: $0 [--ref <git-ref>] [--dry-run] [--k8s-secrets-only] [--recover-installed-runtime]" >&2
  exit 2
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
        echo "--ref requires a non-empty value (got: '${2:-<end-of-args>}')" >&2
        usage
      fi
      REF="$2"
      shift 2
      ;;
    --ref=*)
      REF="${1#--ref=}"
      if [[ -z "$REF" ]]; then
        echo "--ref= requires a non-empty value" >&2
        usage
      fi
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --k8s-secrets-only)
      K8S_SECRETS_ONLY=true
      shift
      ;;
    --recover-installed-runtime)
      RECOVER_INSTALLED_RUNTIME=true
      shift
      ;;
    *)
      echo "Unknown flag: $1" >&2
      usage
      ;;
  esac
done

# Caller's working tree — used for git operations only (fetch + worktree add).
# REPO_ROOT is set later from the detached worktree at --ref, so any pre-worktree
# read of REPO_ROOT would be a bug — let `set -u` catch it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CALLER_REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

on_fail() {
  code=$?
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[ERROR] deploy-infra failed (exit $code)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  emit_deployment_event "infra_deployment.failed" "failed" "Infrastructure deployment failed with exit code $code"

  if [[ -n "${VM_HOST:-}" ]]; then
    echo ""
    echo "=== VM disk state ==="
    ssh $SSH_OPTS root@"$VM_HOST" "df -h / 2>/dev/null || true" || true

    echo ""
    echo "=== .env files (redacted) ==="
    ssh $SSH_OPTS root@"$VM_HOST" "head -5 /opt/cogni-template-runtime/.env 2>/dev/null | sed 's/=.*/=***/' || echo '(.env not found)'" || true

    echo ""
    echo "=== edge compose ps ==="
    ssh $SSH_OPTS root@"$VM_HOST" "docker compose --project-name cogni-edge -f /opt/cogni-template-edge/docker-compose.yml ps 2>&1 || true" || true

    echo ""
    echo "=== runtime compose ps ==="
    ssh $SSH_OPTS root@"$VM_HOST" "docker compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml ps 2>&1 || true" || true

    echo ""
    echo "=== logs: litellm ==="
    ssh $SSH_OPTS root@"$VM_HOST" "docker compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml logs --tail 40 litellm 2>&1 || true" || true

    echo ""
    echo "=== logs: alloy ==="
    ssh $SSH_OPTS root@"$VM_HOST" "docker compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml logs --tail 20 alloy 2>&1 || true" || true

    echo ""
    echo "=== healthcheck history (unhealthy/starting containers) ==="
    ssh $SSH_OPTS root@"$VM_HOST" 'for cid in $(docker ps -a --filter "label=com.docker.compose.project=cogni-runtime" --format "{{.ID}}"); do name=$(docker inspect --format="{{.Name}}" "$cid" | sed "s|^/||"); status=$(docker inspect --format="{{.State.Health.Status}}" "$cid" 2>/dev/null || echo "none"); if [ "$status" != "healthy" ] && [ "$status" != "none" ]; then echo "--- $name ($status) ---"; docker inspect --format="{{json .State.Health}}" "$cid" 2>&1; echo; fi; done' || true

  fi

  exit "$code"
}

trap on_fail ERR

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_fatal() {
    echo -e "${RED}[FATAL]${NC} $1" >&2
    exit 1
}

# Emit deployment event to Grafana Cloud Loki (from CI runner)
emit_deployment_event() {
  local event="$1"
  local status="$2"
  local message="$3"

  command -v jq >/dev/null 2>&1 || { echo "[deploy-infra] jq missing; skipping deployment event" >&2; return 0; }
  if [[ -z "${GRAFANA_CLOUD_LOKI_URL:-}" ]] || [[ -z "${GRAFANA_CLOUD_LOKI_USER:-}" ]] || [[ -z "${GRAFANA_CLOUD_LOKI_API_KEY:-}" ]]; then
    return 0
  fi

  local timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  local nanoseconds=$(date +%s)000000000

  local event_payload=$(jq -n \
    --arg ns "$nanoseconds" \
    --arg event "$event" \
    --arg status "$status" \
    --arg msg "$message" \
    --arg env "${DEPLOY_ENVIRONMENT:-unknown}" \
    --arg commit "${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo 'unknown')}" \
    --arg actor "${GITHUB_ACTOR:-$(whoami)}" \
    --arg timestamp "$timestamp" \
    '{
      streams: [{
        stream: {
          app: "cogni-template",
          env: $env,
          service: "infra-deployment",
          stream: "stdout"
        },
        values: [[$ns, ({
          level: "info",
          event: $event,
          status: $status,
          msg: $msg,
          commit: $commit,
          actor: $actor,
          time: $timestamp
        } | tostring)]]
      }]
    }')

  curl -s -X POST "$GRAFANA_CLOUD_LOKI_URL" \
    -u "${GRAFANA_CLOUD_LOKI_USER}:${GRAFANA_CLOUD_LOKI_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$event_payload" &>/dev/null || true
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SSH setup
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/deploy_key}"

if [[ -f "$SSH_KEY_PATH" ]]; then
    log_info "SSH key validated: $SSH_KEY_PATH"
    SSH_OPTS="-i $SSH_KEY_PATH -o StrictHostKeyChecking=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=12"

    if [[ "$(stat -c %a "$SSH_KEY_PATH" 2>/dev/null || stat -f %A "$SSH_KEY_PATH" 2>/dev/null)" != "600" ]]; then
        log_error "SSH key has incorrect permissions. Expected 600, got: $(stat -c %a "$SSH_KEY_PATH" 2>/dev/null || stat -f %A "$SSH_KEY_PATH" 2>/dev/null)"
        exit 1
    fi
else
    log_info "No deploy key found, using default SSH configuration"
    SSH_OPTS="-o StrictHostKeyChecking=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=12"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Validate environment
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if [[ -z "${DEPLOY_ENVIRONMENT:-}" ]]; then
    log_error "DEPLOY_ENVIRONMENT must be explicitly set to candidate-*, preview, or production"
    exit 1
fi

ENVIRONMENT="$DEPLOY_ENVIRONMENT"
# 'canary' retained as a legacy alias during bug.0312 rename. Drop once no caller sends it.
case "$ENVIRONMENT" in
    candidate-*|canary|preview|production) : ;;
    *)
        log_error "DEPLOY_ENVIRONMENT must be candidate-*, preview, or production"
        log_error "Current value: $ENVIRONMENT"
        exit 1
        ;;
esac

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Receipt-validated installed-runtime recovery (bug.5462)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# This mode intentionally exits before required secret validation, git fetch,
# rsync, image pulls, or the full remote reconciler. It trusts neither file
# presence nor Docker restart policy: every installed input and local image must
# byte-match the receipt written LAST by a successful full deploy.
if [[ "$RECOVER_INSTALLED_RUNTIME" == "true" || "$ENVIRONMENT" == candidate-* ]]; then
  [[ -n "${VM_HOST:-}" ]] || log_fatal "VM_HOST is required for installed-runtime recovery"
  recovery_output="$(ssh $SSH_OPTS root@"$VM_HOST" 'bash -s' <<'RECOVER_REMOTE'
set -euo pipefail

RUNTIME_DIR="${COGNI_RUNTIME_DIR:-/opt/cogni-template-runtime}"
COMPOSE_FILE="$RUNTIME_DIR/docker-compose.yml"
ENV_FILE="$RUNTIME_DIR/.env"
LITELLM_CONFIG="$RUNTIME_DIR/configs/litellm.config.yaml"
RECEIPT="${COGNI_RECOVERY_RECEIPT:-/var/lib/cogni/runtime-recovery-receipt.json}"
RUNTIME_COMPOSE=(docker compose --project-name cogni-runtime --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

custody_required() {
  printf 'recovery_state=custody_required\n'
  printf 'recovery_reason=%s\n' "$1"
  exit 0
}

command -v jq >/dev/null 2>&1 || custody_required jq_missing
[[ -s "$RECEIPT" ]] || custody_required receipt_missing
jq -e '.version == 2 and (.declarationDigest | type == "string")' "$RECEIPT" >/dev/null 2>&1 \
  || custody_required receipt_invalid
for file in "$COMPOSE_FILE" "$ENV_FILE" "$LITELLM_CONFIG"; do
  [[ -s "$file" ]] || custody_required installed_file_missing
done

compose_sha="$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')"
litellm_config_sha="$(sha256sum "$LITELLM_CONFIG" | awk '{print $1}')"
[[ "$compose_sha" == "$(jq -r '.composeSha256' "$RECEIPT")" ]] || custody_required compose_mismatch
[[ "$litellm_config_sha" == "$(jq -r '.litellmConfigSha256' "$RECEIPT")" ]] || custody_required litellm_config_mismatch

receipt_core="$(jq -cS 'del(.declarationDigest)' "$RECEIPT")"
receipt_digest="$(printf '%s' "$receipt_core" | sha256sum | awk '{print $1}')"
[[ "$receipt_digest" == "$(jq -r '.declarationDigest' "$RECEIPT")" ]] \
  || custody_required receipt_digest_mismatch

resolved_config="$("${RUNTIME_COMPOSE[@]}" config --format json 2>/dev/null)" \
  || custody_required compose_config_invalid
recovery_service_config="$(jq -cS \
  '{services: {postgres: .services.postgres, litellm: .services.litellm, autoheal: .services.autoheal}}' \
  <<<"$resolved_config")" || custody_required compose_config_invalid
jq -e '.services | [.postgres, .litellm, .autoheal] | all(. != null)' \
  <<<"$recovery_service_config" >/dev/null 2>&1 || custody_required recovery_service_missing
recovery_service_config_sha="$(printf '%s' "$recovery_service_config" | sha256sum | awk '{print $1}')"
[[ "$recovery_service_config_sha" == "$(jq -r '.recoveryServiceConfigSha256' "$RECEIPT")" ]] \
  || custody_required recovery_service_config_mismatch
for service in postgres litellm autoheal; do
  expected_ref="$(jq -r --arg service "$service" '.images[$service].ref // empty' "$RECEIPT")"
  expected_id="$(jq -r --arg service "$service" '.images[$service].id // empty' "$RECEIPT")"
  resolved_ref="$(jq -r --arg service "$service" '.services[$service].image // empty' <<<"$resolved_config")"
  [[ -n "$expected_ref" && -n "$expected_id" ]] || custody_required image_receipt_incomplete
  [[ "$resolved_ref" == "$expected_ref" ]] || custody_required image_ref_mismatch
  current_id="$(docker image inspect --format '{{.Id}}' "$expected_ref" 2>/dev/null)" \
    || custody_required image_missing
  [[ "$current_id" == "$expected_id" ]] || custody_required image_id_mismatch
done

wait_healthy() {
  local service="$1" timeout_seconds="$2" elapsed=0 cid status
  while (( elapsed < timeout_seconds )); do
    cid="$("${RUNTIME_COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    status=""
    [[ -n "$cid" ]] && status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
    # Services with a healthcheck return healthy; autoheal intentionally has no
    # healthcheck and therefore proves only the Docker running state.
    [[ "$status" == "healthy" || "$status" == "running" ]] && return 0
    [[ "$status" == "exited" || "$status" == "dead" ]] && return 1
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

"${RUNTIME_COMPOSE[@]}" up -d --no-deps --pull never postgres
wait_healthy postgres 120 || { echo 'recovery_error=postgres_not_healthy' >&2; exit 1; }
"${RUNTIME_COMPOSE[@]}" up -d --no-deps --pull never litellm
wait_healthy litellm 180 || { echo 'recovery_error=litellm_not_healthy' >&2; exit 1; }
"${RUNTIME_COMPOSE[@]}" up -d --no-deps --pull never autoheal
wait_healthy autoheal 60 || { echo 'recovery_error=autoheal_not_healthy' >&2; exit 1; }

state=recovered
if ! timeout 20 kubectl exec -n openbao openbao-0 -- \
    env BAO_ADDR=http://127.0.0.1:8200 bao status -format=json 2>/dev/null \
    | jq -e '.sealed == false' >/dev/null 2>&1; then
  state=recovered_degraded
fi
printf 'recovery_state=%s\n' "$state"
printf 'recovery_receipt=%s\n' "$(jq -r '.declarationDigest' "$RECEIPT")"
RECOVER_REMOTE
)"
  printf '%s\n' "$recovery_output"
  recovery_state="$(printf '%s\n' "$recovery_output" | sed -n 's/^recovery_state=//p' | tail -1)"
  [[ -n "$recovery_state" ]] || log_fatal "installed-runtime recovery returned no state"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'recovery_state=%s\n' "$recovery_state" >> "$GITHUB_OUTPUT"
  fi
  case "$recovery_state" in
    recovered) log_info "Installed runtime recovered from the last-good receipt" ;;
    recovered_degraded) log_warn "Installed runtime recovered, but OpenBao is sealed or unreachable" ;;
    custody_required) log_warn "Installed runtime not mutated: full custody reconcile is required" ;;
    *) log_fatal "Unknown installed-runtime recovery state: $recovery_state" ;;
  esac
  if [[ "$RECOVER_INSTALLED_RUNTIME" == "true" ]]; then
    exit 0
  fi
  log_info "Candidate full reconcile continuing after installed-runtime recovery preflight"
fi

# Runtime inputs are validated on the VM after the existing custody reader.
# The runner needs only transport and source/config inputs at this boundary.
for key in DOMAIN VM_HOST APP_ENV COGNI_REPO_URL COGNI_REPO_REF; do
    [[ -n "${!key:-}" ]] || log_fatal "Missing required deploy input: $key"
done

# Check optional secrets (warn if missing)
OPTIONAL_SECRETS=(
    "GRAFANA_CLOUD_LOKI_URL"
    "GRAFANA_CLOUD_LOKI_USER"
    "GRAFANA_CLOUD_LOKI_API_KEY"
    "METRICS_TOKEN"
    "PROMETHEUS_REMOTE_WRITE_URL"
    "PROMETHEUS_USERNAME"
    "PROMETHEUS_PASSWORD"
    "PROMETHEUS_QUERY_URL"
    "PROMETHEUS_READ_USERNAME"
    "PROMETHEUS_READ_PASSWORD"
    "LANGFUSE_PUBLIC_KEY"
    "LANGFUSE_SECRET_KEY"
    "LANGFUSE_BASE_URL"
    "DISCORD_BOT_TOKEN"
    "GH_OAUTH_CLIENT_ID"
    "GH_OAUTH_CLIENT_SECRET"
    "DISCORD_OAUTH_CLIENT_ID"
    "DISCORD_OAUTH_CLIENT_SECRET"
    "GOOGLE_OAUTH_CLIENT_ID"
    "GOOGLE_OAUTH_CLIENT_SECRET"
    "DOLTHUB_OWNER"
    "DOLT_CREDS_JWK"
    "DOLT_CREDS_KEYID"
    "DOLTHUB_API_TOKEN"
    "DOLTHUB_OAUTH_CLIENT_ID"
    "DOLTHUB_OAUTH_CLIENT_SECRET"
    "GH_REVIEW_APP_ID"
    "GH_REVIEW_APP_PRIVATE_KEY_BASE64"
    "NODE_MINT_OWNER"
    "NODE_TEMPLATE_OWNER"
    "GH_REPOS"
    "GH_WEBHOOK_SECRET"
    "TAVILY_API_KEY"
    "PRIVY_APP_ID"
    "PRIVY_APP_SECRET"
    "PRIVY_SIGNING_KEY"
    "PRIVY_USER_WALLETS_APP_ID"
    "PRIVY_USER_WALLETS_APP_SECRET"
    "PRIVY_USER_WALLETS_SIGNING_KEY"
    "POLY_WALLET_AEAD_KEY_HEX"
    "POLY_WALLET_AEAD_KEY_ID"
    "POLY_CLOB_GEO_BLOCK_TOKEN"
    "CONNECTIONS_ENCRYPTION_KEY"
    # bug.0344: required for Argo CD Image Updater git write-back to main.
    # Optional (warn-only) during rollout — Step 7b skips gracefully if unset so
    # legacy callers (e.g. promote-and-deploy.yml preview/prod legs that have
    # not yet wired this through) don't break. Flip to REQUIRED_SECRETS once
    # every caller passes it (tracked in bug.0344 § "Deployment impact").
    "ACTIONS_AUTOMATION_BOT_PAT"
)

for secret in "${OPTIONAL_SECRETS[@]}"; do
    if [[ -z "${!secret:-}" ]]; then
        log_warn "Optional secret not set: $secret"
    fi
done

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SSH connection multiplexing (bug.5159)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ONE TRANSPORT PER DEPLOY. The tail of this script opens TWELVE separate SSH
# handshakes to the same VM back to back (1 mkdir ssh, 3 rsync, 6 scp, 1 verify
# ssh, 1 exec ssh), and `on_fail` opens seven more while dumping diagnostics.
# sshd's admission control (`MaxStartups`, default 10:30:100, plus the
# per-source penalties newer OpenSSH applies) sheds new connections DURING the
# banner exchange once that burst forms, which surfaces as
#   kex_exchange_identification: read: Connection reset by peer
#   scp: Connection closed
# on a random early leg — never on the long-running remote command, and never
# as an auth or VM-down error. Measured on two production deploys on 2026-10-09
# (runs 37868061021, 37868723855) while the app itself served 200s.
#
# `ControlMaster=auto` collapses all of it to one authenticated transport: the
# first call authenticates and becomes the master, every later ssh/scp/rsync
# rides it as a channel and performs NO handshake. That is the structural fix —
# it removes the burst rather than retrying into it. deploy-infra was the last
# SSH-heavy CI path still unconverted; reconcile-node-substrate.sh and
# secret-materialize.sh already multiplex for this same bug.
#
# COLLISION SAFETY. The socket lives in a `mktemp -d` directory, so two deploys
# can never share one: concurrent runs for DIFFERENT environments (a candidate-a
# infra flight during a production promote) each get their own directory, and so
# do two runs for the SAME environment. The socket is additionally named
# `<env>-%h` so a human reading `lsof` can tell which lane and which VM a live
# master belongs to, and `%h` keeps it correct-by-construction if this script
# ever addresses a second host. A fixed `/tmp/...` path would have done neither.
#
# `ControlMaster=auto` (not `=yes`) also means a dead or stale master is not
# fatal: ssh falls back to opening its own connection. rsync gets the same opts
# through `-e "ssh $SSH_OPTS"`, so its legs are channels too.
SSH_MUX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cogni-mux-XXXXXX")"
SSH_MUX_CONTROL_PATH="$SSH_MUX_DIR/${ENVIRONMENT}-%h"
# A unix socket path is capped (~104 bytes). The components are fixed-length in
# CI, so this guard never fires there; it exists so an unusual TMPDIR fails with
# a cause instead of ssh's bare "ControlPath too long" on every leg.
if (( ${#SSH_MUX_DIR} + ${#ENVIRONMENT} + ${#VM_HOST} + 2 > 100 )); then
    log_error "SSH ControlPath would exceed the unix-socket limit: ${SSH_MUX_DIR}/${ENVIRONMENT}-${VM_HOST}"
    log_error "Set TMPDIR to a shorter directory and re-run."
    exit 1
fi
SSH_OPTS="$SSH_OPTS -o ControlMaster=auto -o ControlPath=$SSH_MUX_CONTROL_PATH -o ControlPersist=120"
log_info "SSH multiplexing enabled (ControlPath: $SSH_MUX_CONTROL_PATH)"

# Tear the master down rather than leaving it to ControlPersist. Installed into
# the existing EXIT trap below, next to cleanup_worktree.
cleanup_ssh_mux() {
    [[ -n "${SSH_MUX_DIR:-}" ]] || return 0
    ssh -o "ControlPath=$SSH_MUX_CONTROL_PATH" -O exit root@"$VM_HOST" >/dev/null 2>&1 || true
    rm -rf "$SSH_MUX_DIR"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Artifact directory
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARTIFACT_DIR="${RUNNER_TEMP:-/tmp}/deploy-infra-${GITHUB_RUN_ID:-$$}"
mkdir -p "$ARTIFACT_DIR"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Source worktree at --ref (the INFRA_REF_IS_EXPLICIT invariant)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# The VM rsync source is a clean, detached worktree of --ref — NOT the caller's
# checkout. This eliminates the "stale PR checkout rsync" class of failure that
# motivated task.0314 (see PR #879 flight loop on 2026-04-16).
SRC_WORKTREE="$ARTIFACT_DIR/src-worktree"
cleanup_worktree() {
    if [[ -d "$SRC_WORKTREE" ]]; then
        git -C "$CALLER_REPO" worktree remove --force "$SRC_WORKTREE" 2>/dev/null || rm -rf "$SRC_WORKTREE"
    fi
}
trap 'cleanup_worktree; cleanup_ssh_mux' EXIT

log_info "Resolving source worktree at ref: $REF"
# Fetch the ref to handle shallow clones (GHA typically checks out with fetch-depth=1)
FETCH_STDERR=$(git -C "$CALLER_REPO" fetch origin "$REF" --depth=1 2>&1 >/dev/null) || \
    log_warn "git fetch origin $REF failed: $FETCH_STDERR (will try local ref)"
if git -C "$CALLER_REPO" rev-parse --verify "origin/$REF" >/dev/null 2>&1; then
    git -C "$CALLER_REPO" worktree add --detach --quiet "$SRC_WORKTREE" "origin/$REF"
elif git -C "$CALLER_REPO" rev-parse --verify "$REF" >/dev/null 2>&1; then
    git -C "$CALLER_REPO" worktree add --detach --quiet "$SRC_WORKTREE" "$REF"
else
    log_fatal "Cannot resolve ref '$REF' — neither origin/$REF nor $REF exists locally (fetch stderr was: ${FETCH_STDERR:-<empty>})"
fi
REF_SHA=$(git -C "$SRC_WORKTREE" rev-parse HEAD)
log_info "Source worktree at $REF_SHA ($SRC_WORKTREE)"

# Assign REPO_ROOT to the detached worktree so all rsync/scp source paths
# below come from the clean --ref tree, not the caller's checkout.
REPO_ROOT="$SRC_WORKTREE"

log_info "Deploying infrastructure to $ENVIRONMENT..."
log_info "Domain: $DOMAIN"
log_info "VM Host: $VM_HOST"
log_info "Artifact directory: $ARTIFACT_DIR"

emit_deployment_event "infra_deployment.started" "in_progress" "Deploying infrastructure to $ENVIRONMENT"

# bug.5086 — catalog-driven node-app list (CATALOG_IS_SSOT). Computed locally
# (the runner has the repo + yq) and threaded into the remote heredoc via the
# env block so the per-node secret + rollout loops below stop hardcoding nodes —
# a new type:node (e.g. canary) auto-provisions. Fail loud, never empty.
# shellcheck source=scripts/ci/lib/image-tags.sh
source "$REPO_ROOT/scripts/ci/lib/image-tags.sh"
# shellcheck source=scripts/ci/lib/appset-paths.sh
source "$REPO_ROOT/scripts/ci/lib/appset-paths.sh"
# shellcheck source=scripts/setup/lib/cogni-deployment-identity.sh
source "$REPO_ROOT/scripts/setup/lib/cogni-deployment-identity.sh"
NODE_APP_TARGETS="${NODE_TARGETS[*]}"
[ -n "$NODE_APP_TARGETS" ] || log_fatal "deploy-infra: no type:node targets from infra/catalog — refusing to deploy with an empty node list"
log_info "Node-app targets (catalog-driven): ${NODE_APP_TARGETS}"

# Resolve only this environment's shared Postgres inputs from the reviewed
# source tree. Dedicated cells have their own provisioner and must never be
# reconciled against this VM's shared Postgres.
render_shared_db_provision_config() {
  local node owner tier profile budget config='{}'
  for node in "${NODE_TARGETS[@]}"; do
    target_in_env "$node" "$DEPLOY_ENVIRONMENT" || continue
    # LANE_IS_NOT_CONTROL: a lane reconciled by another control env (akash rows) keeps its
    # role passwords in THAT env's vault, and its reconcile-node-substrate is the one writer
    # of this lane's roles. Provisioning it here from this VM's bank re-ALTERs the same roles
    # to a foreign copy → the runtime 28P01s (task.5301, node-template candidate-a 10-23).
    owner="$(CATALOG_DIR="$REPO_ROOT/infra/catalog" control_env_for "$DEPLOY_ENVIRONMENT" "$node")" || return 1
    [ "$owner" = "$DEPLOY_ENVIRONMENT" ] || continue
    tier="$(yq -er ".database.\"${DEPLOY_ENVIRONMENT}\".tier" "$REPO_ROOT/infra/catalog/$node.yaml")" || return 1
    case "$tier" in
      dedicated) continue ;;
      shared) ;;
      *) log_error "Unsupported database tier for ${node}/${DEPLOY_ENVIRONMENT}"; return 1 ;;
    esac
    profile="$(yq -er ".database.\"${DEPLOY_ENVIRONMENT}\".budget_profile" "$REPO_ROOT/infra/catalog/$node.yaml")" || return 1
    [[ "$profile" =~ ^[a-z0-9-]+$ ]] || return 1
    budget="$(yq -o=json ".\"${profile}\"" "$REPO_ROOT/infra/database-budget-profiles.yaml" | jq -ce --arg profile "$profile" '{
      DB_BUDGET_PROFILE: $profile,
      DB_APP_CONNECTION_LIMIT: .roles.app.connection_limit,
      DB_APP_STATEMENT_TIMEOUT_MS: .roles.app.statement_timeout_ms,
      DB_SERVICE_CONNECTION_LIMIT: .roles.service.connection_limit,
      DB_SERVICE_STATEMENT_TIMEOUT_MS: .roles.service.statement_timeout_ms,
      DB_LOCK_TIMEOUT_MS: .common.lock_timeout_ms,
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: .common.idle_in_transaction_session_timeout_ms,
      DB_TEMP_FILE_LIMIT_MIB: .common.temp_file_limit_mib,
      DB_WORK_MEM_MIB: .common.work_mem_mib
    } | select(all(to_entries[]; .key == "DB_BUDGET_PROFILE" or
      (.value | type == "number" and . > 0 and floor == .)))')" || return 1
    config="$(jq -cn --argjson config "$config" --arg node "$node" --argjson budget "$budget" '$config + {($node): $budget}')" || return 1
  done
  printf '%s\n' "$config"
}
NODE_DB_PROVISION_CONFIG="$(render_shared_db_provision_config)" || log_fatal "Invalid shared database catalog/budget inputs; refusing infra reconcile"

# G-tier derived inventory: database names are a pure function of the catalog
# node list. Do not trust the GitHub env secret here; it can lag a new node and
# leave the pod with a DATABASE_URL for a DB that db-provision never created.
COGNI_NODE_DBS="$(node_database_csv)"
export COGNI_NODE_DBS
log_info "Node databases (catalog-driven): ${COGNI_NODE_DBS}"

# task.5078 — catalog-driven edge routing. The generated Caddyfile
# (scripts/ci/render-caddyfile.sh) resolves {$<SLUG>_DOMAIN} per non-primary
# node and bakes upstream ports from catalog node_port. Here we compute only the
# env-variant overrides the VM needs: each non-primary node's per-env host
# (host_for_node) and the primary's k3s NodePort upstream (the Caddyfile default
# is the docker-DNS app:3000). Space-separated KEY=VALUE tokens (no spaces in
# values) thread cleanly through the SSH env block into the remote heredoc — the
# same pattern as NODE_APP_TARGETS. A new type:node auto-routes, no edit here.
EDGE_ENV_LINES=""
for _edge_node in "${NODE_TARGETS[@]}"; do
  _edge_slug=$(printf '%s' "$_edge_node" | tr '[:lower:]-' '[:upper:]_')
  if is_primary_host "$_edge_node"; then
    EDGE_ENV_LINES+="${_edge_slug}_UPSTREAM=host.docker.internal:$(node_port_for_target "$_edge_node") "
  else
    EDGE_ENV_LINES+="${_edge_slug}_DOMAIN=$(host_for_node "$_edge_node" "$DOMAIN") "
  fi
done
unset _edge_node _edge_slug
log_info "Edge routing (catalog-driven): ${EDGE_ENV_LINES}"

# LiteLLM runs in Compose while node apps run in k3s. Its callback map must
# target each node's VM NodePort and include both slug + UUID aliases. Compute
# from catalog on the runner; the remote VM script consumes only the rendered
# string and does not need catalog helper functions.
#
# bug.5094 — LiteLLM is Cherry-resident, so it is a node-addressing consumer like
# any other: a node whose catalog row places it on akash for THIS env has no
# NodePort on this VM, and is reached at its public URL instead. Placement comes
# from the row (deployment_provider.<env>), never a second list of nodes.
# This host addresses the k3s app in the workload lane, not a dependency owned
# by its control env. Resolving the control env here would misroute callbacks
# from a non-production lane; Akash destinations remain public URLs below.
LITELLM_NODE_HOST="$(cogni_vm_host_for_env "$DEPLOY_ENVIRONMENT" "${FORK_DOMAIN_ROOT:-$(cogni_domain_root)}" "$(cogni_deployment_slug)")"
LITELLM_NODE_ENDPOINTS="$(node_billing_endpoint_csv "$LITELLM_NODE_HOST" "$DEPLOY_ENVIRONMENT" "$DOMAIN")"
log_info "LiteLLM callback routing (catalog-driven): ${LITELLM_NODE_ENDPOINTS}"
# LiteLLM image is a type:infra catalog target — content-hash tagged + built in
# CI (no manual docker build / hand-pin). Resolve the same tag CI pushed.
LITELLM_IMAGE="$(infra_image_tag litellm)"
log_info "LiteLLM image (catalog content-hash): ${LITELLM_IMAGE}"
OPENFGA_IMAGE="$(infra_image_tag openfga)"
log_info "OpenFGA image (catalog content-hash): ${OPENFGA_IMAGE}"
# Default node for unattributed spend — primary-host node_id from repo-spec
# (REPO_SPEC_IS_IDENTITY_SSOT). The LiteLLM callback carries no hardcoded UUID.
COGNI_DEFAULT_NODE_ID="$(default_node_id)"
log_info "LiteLLM default node (repo-spec primary-host): ${COGNI_DEFAULT_NODE_ID}"

# task.5052 — compute-egress allowlist is catalog-rendered (CATALOG_IS_SSOT):
# harden-docker-public-ports.sh installs the staged render (even when empty, so
# catalog removal converges) before rebuilding the DOCKER-USER rules.
"$REPO_ROOT/scripts/ci/render-compute-egress-allowlist.sh" "$DEPLOY_ENVIRONMENT" > "$ARTIFACT_DIR/compute-egress-allowlist"
log_info "Compute-egress allowlist (catalog-driven): $(grep -cv '^#' "$ARTIFACT_DIR/compute-egress-allowlist" || true) CIDR rule(s) for ${DEPLOY_ENVIRONMENT}"
REMOTE_STAGE_ID="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
REMOTE_COMPUTE_EGRESS_ALLOWLIST="/tmp/cogni-compute-egress-${REMOTE_STAGE_ID}.allowlist"
REMOTE_HARDEN_SCRIPT="/tmp/cogni-compute-egress-${REMOTE_STAGE_ID}.hardener.sh"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Create remote deployment script (heredoc — no variable expansion)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
cat > "$ARTIFACT_DIR/deploy-infra-remote.sh" << 'EOF'
#!/bin/bash
# Remote infrastructure deployment script (generated by deploy-infra.sh)
# Purpose: Start/update Compose infra services on VM. App containers managed by k8s.
# Architecture:
#   - Edge stack (Caddy): Always-on TLS termination, rarely touched
#   - Runtime stack (postgres, litellm, alloy, temporal, redis, etc.): Updated on each deploy
#   - App pods (operator, poly, resy): NOT managed here — k8s/Argo handles those

set -euo pipefail

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Error capture: Show exactly what failed (line number + command)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
trap 'rm -f "${RUNTIME_ENV_NEXT:-}" 2>/dev/null || true; echo -e "\033[0;31m[FATAL]\033[0m Script failed at line $LINENO: $BASH_COMMAND" >&2' ERR

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Docker prerequisite gate (fail fast if VM not bootstrapped)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
prereq_failed() {
  echo -e "\033[0;31m[ERROR]\033[0m Docker prerequisites not met. VM bootstrap may have failed."
  echo ""
  echo "=== Bootstrap marker files ==="
  cat /var/lib/cogni/bootstrap.ok 2>/dev/null || echo "(bootstrap.ok not found)"
  cat /var/lib/cogni/bootstrap.fail 2>/dev/null || echo "(bootstrap.fail not found)"
  echo ""
  echo "=== cloud-init-output.log (last 200 lines) ==="
  tail -n 200 /var/log/cloud-init-output.log 2>/dev/null || echo "(not found)"
  echo ""
  echo "=== cogni-bootstrap.log (last 200 lines) ==="
  tail -n 200 /var/log/cogni-bootstrap.log 2>/dev/null || echo "(not found)"
  exit 1
}

if ! command -v docker &>/dev/null; then
  echo -e "\033[0;31m[ERROR]\033[0m docker binary not found"
  prereq_failed
fi

if ! docker version &>/dev/null; then
  echo -e "\033[0;31m[ERROR]\033[0m docker daemon not reachable"
  prereq_failed
fi

if ! docker compose version &>/dev/null; then
  echo -e "\033[0;31m[ERROR]\033[0m docker compose plugin not found"
  prereq_failed
fi

if command -v systemctl &>/dev/null && ! systemctl is-active --quiet docker; then
  echo -e "\033[0;31m[ERROR]\033[0m docker service not active"
  prereq_failed
fi

echo -e "\033[0;32m[INFO]\033[0m Docker prerequisites verified"

# Stop the owned watchdog BEFORE datastore/custody preflight. Its old policy can
# repeatedly restart a dependency while that dependency is recovering. Full
# Compose convergence below alone resumes it with the reviewed desired policy;
# a failed preflight intentionally leaves the unsafe watchdog stopped.
stop_runtime_watchdog() {
  local container metadata
  container="$(docker ps --filter label=com.docker.compose.project=cogni-runtime \
    --filter label=com.docker.compose.service=autoheal --format '{{.ID}}')"
  [[ -n "$container" ]] || return 0 # Fresh bootstrap has no owned watchdog.
  [[ "$container" =~ ^[0-9a-f]+$ ]] || { echo 'watchdog_container_identity_ambiguous' >&2; return 1; }
  metadata="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")"
  [[ "$metadata" == 'cogni-runtime|autoheal|/opt/cogni-template-runtime' ]] \
    || { echo 'watchdog_container_identity_mismatch' >&2; return 1; }
  timeout 30 docker stop --time 15 "$container" >/dev/null
  echo '[deploy-infra] Owned runtime watchdog stopped before dependency preflight'
}
if [[ "${K8S_SECRETS_ONLY:-false}" != "true" ]]; then
  stop_runtime_watchdog
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Firewall: close Docker-published internal ports to public internet
# (idempotent; also (re)installs its boot replay unit). bug.5167, story.5084.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if [ -n "${REMOTE_HARDEN_SCRIPT:-}" ] && [ -f "$REMOTE_HARDEN_SCRIPT" ]; then
  echo -e "\033[0;32m[INFO]\033[0m Hardening Docker-published ports (DOCKER-USER chain)..."
  STAGED_ALLOWLIST="$REMOTE_COMPUTE_EGRESS_ALLOWLIST" bash "$REMOTE_HARDEN_SCRIPT"
  rm -f "$REMOTE_COMPUTE_EGRESS_ALLOWLIST" "$REMOTE_HARDEN_SCRIPT"
else
  echo -e "\033[1;33m[WARN]\033[0m harden-docker-public-ports.sh missing — skipping firewall hardening"
fi

# Compose shortcuts (explicit project names, no global export)
EDGE_COMPOSE="docker compose --project-name cogni-edge -f /opt/cogni-template-edge/docker-compose.yml"
RUNTIME_COMPOSE="docker compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml"
RUNTIME_COMPOSE_FILE="/opt/cogni-template-runtime/docker-compose.yml"

# Resolve only native Docker-owned collector inputs. Core-only deployment and
# DB provisioning never depend on this observer topology or its override.
verify_cadvisor_topology() {
  local native root driver address containers plugins
  native="$(docker info --format '{{.DockerRootDir}}|{{.Driver}}|{{.Containerd.Address}}|{{.Containerd.Namespaces.Containers}}|{{.Containerd.Namespaces.Plugins}}')" || return 1
  IFS='|' read -r root driver address containers plugins <<NATIVE_DOCKER
$native
NATIVE_DOCKER
  printf '[deploy-infra] cAdvisor native DockerRootDir|Driver|Containerd.Address|Namespaces=%s\n' "$native"
  [ "$containers|$plugins" = 'moby|plugins.moby' ] \
    || { echo 'cadvisor_native_namespace_unsupported' >&2; return 1; }
  case "$root|$driver" in
    '/var/lib/docker|overlay2')
      CADVISOR_BIND_SOURCE=/var/lib/docker/image/overlay2/layerdb/mounts
      CADVISOR_BIND_TARGET="$CADVISOR_BIND_SOURCE"
      [ -d "$CADVISOR_BIND_SOURCE" ] \
        || { echo 'cadvisor_metadata_path_missing' >&2; return 1; }
      ;;
    '/var/lib/docker|overlayfs')
      case "$address" in
        /run/containerd/containerd.sock|/var/run/docker/containerd/containerd.sock) ;;
        *) echo 'cadvisor_native_socket_unsupported' >&2; return 1 ;;
      esac
      [ -S "$address" ] \
        || { echo 'cadvisor_native_socket_missing' >&2; return 1; }
      CADVISOR_BIND_SOURCE="$address"
      CADVISOR_BIND_TARGET=/run/cogni-docker-containerd.sock
      ;;
    *) echo 'cadvisor_topology_unsupported' >&2; return 1 ;;
  esac
  export CADVISOR_BIND_SOURCE CADVISOR_BIND_TARGET
  printf '[deploy-infra] cAdvisor native binding source=%s target=%s\n' "$CADVISOR_BIND_SOURCE" "$CADVISOR_BIND_TARGET"
}
install_cadvisor_binding() {
  verify_cadvisor_topology || return 1
  local next
  next="$(mktemp "${CADVISOR_OVERRIDE_FILE}.next.XXXXXX")" || return 1
  if ! cat > "$next" <<CADVISOR_COMPOSE
services:
  alloy:
    volumes:
      - type: bind
        source: ${CADVISOR_BIND_SOURCE}
        target: ${CADVISOR_BIND_TARGET}
        read_only: true
        bind:
          create_host_path: false
CADVISOR_COMPOSE
  then
    rm -f "$next"
    return 1
  fi
  chmod 644 "$next"
  mv -f "$next" "$CADVISOR_OVERRIDE_FILE"
}
CADVISOR_OVERRIDE_FILE=/opt/cogni-template-runtime/docker-compose.observability.yml
RUNTIME_OBSERVABILITY_ARGS=""
if [[ "${K8S_SECRETS_ONLY:-false}" != "true" ]]; then
  # Stable config path avoids config_files label churn on subsequent full deploys.
  # A refused native identity leaves the prior override and base Compose intact.
  install_cadvisor_binding
  RUNTIME_OBSERVABILITY_ARGS="-f $CADVISOR_OVERRIDE_FILE"
  RUNTIME_COMPOSE="$RUNTIME_COMPOSE $RUNTIME_OBSERVABILITY_ARGS"
fi
# doltgres presence must be read from the STATIC compose file, not `compose config
# --services` (which fully validates env interpolation → flakes empty on any unset var
# → doltgres false-reads "absent" → knowledge plane silently skipped). Fail LOUD if the
# file is missing — a missing compose file must never silently mean "doltgres off".
doltgres_in_compose() {
  [[ -f "$RUNTIME_COMPOSE_FILE" ]] || log_fatal "runtime compose file missing at $RUNTIME_COMPOSE_FILE — cannot determine doltgres presence"
  grep -qE '^  doltgres:[[:space:]]*$' "$RUNTIME_COMPOSE_FILE"
}

log_info() {
    echo -e "\033[0;32m[INFO]\033[0m $1"
}

log_warn() {
    echo -e "\033[1;33m[WARN]\033[0m $1"
}

log_error() {
    echo -e "\033[0;31m[ERROR]\033[0m $1"
}

log_fatal() {
    echo -e "\033[0;31m[FATAL]\033[0m $1" >&2
    exit 1
}

# Emit deployment event to Grafana Cloud Loki (remote script)
emit_deployment_event() {
  local event="$1"
  local status="$2"
  local message="$3"

  command -v jq >/dev/null 2>&1 || { echo "[deploy-infra] jq missing; skipping deployment event" >&2; return 0; }
  if [[ -z "${GRAFANA_CLOUD_LOKI_URL:-}" ]] || [[ -z "${GRAFANA_CLOUD_LOKI_USER:-}" ]] || [[ -z "${GRAFANA_CLOUD_LOKI_API_KEY:-}" ]]; then
    return 0
  fi

  local timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  local nanoseconds=$(date +%s)000000000

  local event_payload=$(jq -n \
    --arg ns "$nanoseconds" \
    --arg event "$event" \
    --arg status "$status" \
    --arg msg "$message" \
    --arg env "${DEPLOY_ENVIRONMENT:-unknown}" \
    --arg commit "${COMMIT_SHA:-unknown}" \
    --arg actor "${DEPLOY_ACTOR:-unknown}" \
    --arg timestamp "$timestamp" \
    '{
      streams: [{
        stream: {
          app: "cogni-template",
          env: $env,
          service: "infra-deployment",
          stream: "stdout"
        },
        values: [[$ns, ({
          level: "info",
          event: $event,
          status: $status,
          msg: $msg,
          commit: $commit,
          actor: $actor,
          time: $timestamp
        } | tostring)]]
      }]
    }')

  curl -s -X POST "$GRAFANA_CLOUD_LOKI_URL" \
    -u "${GRAFANA_CLOUD_LOKI_USER}:${GRAFANA_CLOUD_LOKI_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$event_payload" &>/dev/null || true
}

# Portable hash function (sha256sum on Linux, shasum on macOS)
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    log_warn "No sha256 tool available, skipping config hash check"
    echo "no-hash-tool"
  fi
}

# Append env var to file only if value is non-empty
append_env_if_set() {
    local file="${1:?file required}" key="${2:?key required}" val="${3-}"
    if [[ -n "$val" ]]; then printf '%s=%s\n' "$key" "$val" >> "$file"; fi
}

missing_or_placeholder() {
  [[ -z "${1:-}" || "$1" == *"<"* || "$1" == *">"* || "$1" == *" "* ]]
}

base64url_decode() {
  local value="${1//-/+}"
  value="${value//_/\/}"
  while (( ${#value} % 4 != 0 )); do
    value="${value}="
  done
  if ! printf '%s' "$value" | base64 -d 2>/dev/null; then
    printf '%s' "$value" | base64 -D
  fi
}

json_string_field() {
  local json="$1" field="$2"
  printf '%s' "$json" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p"
}

derive_pdc_defaults_from_token() {
  [[ -n "${GRAFANA_PDC_SIGNING_TOKEN:-}" ]] || return 0
  [[ "$GRAFANA_PDC_SIGNING_TOKEN" == glc_* ]] || return 0

  local decoded
  decoded="$(base64url_decode "${GRAFANA_PDC_SIGNING_TOKEN#glc_}" 2>/dev/null || true)"
  [[ -n "$decoded" ]] || return 0

  local network_id cluster
  network_id="$(json_string_field "$decoded" n)"
  cluster="$(printf '%s' "$decoded" | sed -n 's/.*"m"[[:space:]]*:[[:space:]]*{[^}]*"r"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

  if missing_or_placeholder "${GRAFANA_PDC_NETWORK_ID:-}" && [[ -n "$network_id" ]]; then
    GRAFANA_PDC_NETWORK_ID="$network_id"
  fi
  if missing_or_placeholder "${GRAFANA_PDC_CLUSTER:-}" && [[ -n "$cluster" ]]; then
    GRAFANA_PDC_CLUSTER="$cluster"
  fi
}

log_info "Setting up infrastructure deployment on VM..."

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 0: Create shared network (idempotent, must exist before any compose up)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "Ensuring cogni-edge network exists..."
docker network create cogni-edge 2>/dev/null || true

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 1: Write environment files
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "Creating environment files..."

# Edge env — the generated Caddyfile (scripts/ci/render-caddyfile.sh) resolves
# {$<SLUG>_DOMAIN} per non-primary node and {$<SLUG>_UPSTREAM} per primary.
# task.5078 — these lines are catalog-driven: EDGE_ENV_LINES (computed on the
# runner from NODE_TARGETS, threaded in) carries one KEY=VALUE token per node so
# a new type:node auto-routes with no edit here. Concrete values (not empty
# {$VAR}) avoid the anonymous-server-block crash (bug.5070). DOMAIN drives the
# operator primary block + the www→non-www redirect.
cat > /opt/cogni-template-edge/.env << ENV_EOF
DOMAIN=${DOMAIN}
ENV_EOF
for _edge_kv in ${EDGE_ENV_LINES}; do
  echo "$_edge_kv" >> /opt/cogni-template-edge/.env
done
unset _edge_kv

# LiteLLM is a type:infra catalog target — built + pushed by CI like every other
# image (content-hash tagged: litellm-<hash>). The runner resolves the tag via
# image-tags.sh:infra_image_tag and passes it in; no manual docker build, no pin.
LITELLM_IMAGE=${LITELLM_IMAGE:?LITELLM_IMAGE required (resolved on the runner from infra/catalog/litellm.yaml content-hash)}

# Runtime env (full config — compose validates all vars even for services we don't start).
# Render to a root-only sibling, then atomically rename only after every required
# and optional field has been written. Recovery never trusts a partial file.
INSTALLED_RUNTIME_ENV=/opt/cogni-template-runtime/.env
umask 077
RUNTIME_ENV_NEXT="${INSTALLED_RUNTIME_ENV}.next.$$"
rm -f "$RUNTIME_ENV_NEXT"
RUNTIME_ENV="$RUNTIME_ENV_NEXT"
previous_runtime_env_value() {
  local key="$1"
  [[ -f "$INSTALLED_RUNTIME_ENV" ]] || return 0
  awk -v key="$key" '
    index($0, key "=") == 1 { value = substr($0, length(key) + 2) }
    END { print value }
  ' "$INSTALLED_RUNTIME_ENV"
}

postgres_bootstrap_identity() {
  local container="$1" host="$2" user="$3"
  timeout 20 docker exec -i "$container" sh -c '
    IFS= read -r PGPASSWORD; export PGPASSWORD PGCONNECT_TIMEOUT=5
    exec psql -XwAt -h "$1" -U "$2" -d postgres -v ON_ERROR_STOP=1 -c \
      "SELECT system_identifier::text || '\''|'\'' || current_user || '\''|'\'' || rolsuper::text FROM pg_control_system(), pg_roles WHERE rolname=current_user"
  ' sh "$host" "$user"
}

preserve_postgres_bootstrap_identity() {
  local container metadata host user password data_identity tcp_identity rejected
  container="$(docker ps --filter label=com.docker.compose.project=cogni-runtime \
    --filter label=com.docker.compose.service=postgres --format '{{.ID}}')"
  [[ "$container" =~ ^[0-9a-f]+$ ]] || log_fatal "bootstrap_root_container_identity_unavailable"
  metadata="$(docker inspect --format '{{.State.Running}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$container")"
  [[ "$metadata" == 'true|cogni-runtime|postgres|postgres_data' ]] \
    || log_fatal "bootstrap_root_container_identity_mismatch"
  host="$(docker inspect --format '{{with index .NetworkSettings.Networks "cogni-runtime_internal"}}{{.IPAddress}}{{end}}' "$container")"
  [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || log_fatal "bootstrap_root_tcp_target_unavailable"
  user="$(previous_runtime_env_value POSTGRES_ROOT_USER)"
  password="$(previous_runtime_env_value POSTGRES_ROOT_PASSWORD)"
  [[ -n "$user" && -n "$password" ]] || log_fatal "bootstrap_root_preservation_source_missing"
  [[ -z "${POSTGRES_ROOT_USER:-}" || "$POSTGRES_ROOT_USER" == "$user" ]] \
    || log_fatal "bootstrap_root_explicit_user_mismatch"
  [[ -z "${POSTGRES_ROOT_PASSWORD:-}" || "$POSTGRES_ROOT_PASSWORD" == "$password" ]] \
    || log_fatal "bootstrap_root_explicit_password_mismatch"
  data_identity="$(timeout 20 docker exec --user postgres "$container" sh -c \
    'LC_ALL=C pg_controldata "${PGDATA:-/var/lib/postgresql/data}"' | awk -F: '/^Database system identifier:/ {gsub(/ /,"",$2); print $2}')"
  [[ "$data_identity" =~ ^[0-9]+$ ]] || log_fatal "bootstrap_root_data_identity_unavailable"
  if rejected="$(printf '%s\n' 'cogni-deliberately-invalid-bootstrap-proof' | postgres_bootstrap_identity "$container" "$host" "$user" 2>&1)"; then
    log_fatal "bootstrap_root_tcp_did_not_require_password"
  fi
  [[ "$rejected" == *'password authentication failed'* ]] || log_fatal "bootstrap_root_tcp_auth_unproven"
  tcp_identity="$(printf '%s\n' "$password" | postgres_bootstrap_identity "$container" "$host" "$user" 2>/dev/null)" \
    || log_fatal "bootstrap_root_tcp_auth_failed"
  [[ "$tcp_identity" == "${data_identity}|${user}|true" ]] || log_fatal "bootstrap_root_native_identity_mismatch"
  POSTGRES_ROOT_USER="$user" POSTGRES_ROOT_PASSWORD="$password"
  log_info "Preserved existing shared PostgreSQL bootstrap identity after native TCP authentication"
}

PREVIOUS_OPENFGA_AUTHORIZATION_MODEL_ID="$(previous_runtime_env_value OPENFGA_AUTHORIZATION_MODEL_ID)"
PREVIOUS_OPENFGA_AUTHORIZATION_MODEL_HASH="$(previous_runtime_env_value OPENFGA_AUTHORIZATION_MODEL_HASH)"

# ── OpenBao reads: FILE-cached token + per-path JSON (bug.5081 / bug.5011) ──
# The prod box (bug.5011) starves openbao, so any single `kubectl exec … bao` can
# stall. deploy-infra makes ~12 per-field reads, and each `openbao_get_field` runs
# inside a `$()` subshell — so the old in-memory `DB_READER_TOKEN` cache never
# persisted and EVERY read re-minted (2 extra round-trips), then read one field.
# ~36 round-trips → any one stall failed the whole deploy (whack-a-mole; retry alone
# couldn't beat the count). Fix: cache the reader token AND each path's whole JSON to
# FILES (survive subshells) → 1 mint + ~3 path reads total, each retried. Field
# extraction is then local (jq). Caches are cleared once at definition so a prior
# deploy's /tmp can never serve a stale secret.
BAO_CACHE_DIR="/tmp/.deploy-infra-bao-cache"
BAO_TOKEN_FILE="${BAO_CACHE_DIR}/reader-token"
rm -rf "$BAO_CACHE_DIR" 2>/dev/null || true
(umask 077; mkdir -p "$BAO_CACHE_DIR")
chmod 700 "$BAO_CACHE_DIR"
umask 077

# The reader talks to the same in-cluster HTTP API as ESO; kubelet exec is
# not a prerequisite for repairing shared runtime services under host pressure.
openbao_reader_address() {
  local cache="${BAO_CACHE_DIR}/service-address" service_file="${BAO_CACHE_DIR}/service.json" ip rc lookup_limit="${1:-15}"
  [[ "$lookup_limit" == 10 || "$lookup_limit" == 15 ]] || return 1
  if [[ -s "$cache" ]]; then cat "$cache"; return 0; fi
  if timeout "$lookup_limit" kubectl -n openbao get service openbao -o json > "$service_file" 2>"${BAO_CACHE_DIR}/service.stderr"; then :; else
    rc=$?; printf '[openbao-reader] phase=service_discovery native_rc=%s reason=unavailable\n' "$rc" >&2; return "$rc"
  fi
  jq -e '.metadata.name == "openbao" and .metadata.namespace == "openbao" and .spec.type == "ClusterIP"
    and .spec.selector == {"app.kubernetes.io/name":"openbao","app.kubernetes.io/instance":"openbao","component":"server"}
    and ([.spec.ports[] | select(.port == 8200 and (.protocol // "TCP") == "TCP" and .targetPort == 8200)] | length) == 1' \
    "$service_file" >/dev/null 2>&1 \
    || { printf '[openbao-reader] phase=service_discovery native_rc=1 reason=identity_unproven\n' >&2; return 1; }
  ip="$(jq -r '.spec.clusterIP // empty' "$service_file")"
  # Parse an actual IP; no hostname, credential, path or external endpoint input.
  ip="$(printf '%s' "$ip" | python3 -c 'import ipaddress,sys; a=ipaddress.ip_address(sys.stdin.read()); print("["+str(a)+"]" if a.version==6 else str(a))' 2>/dev/null)" \
    || { printf '[openbao-reader] phase=service_discovery native_rc=1 reason=address_unproven\n' >&2; return 1; }
  printf 'http://%s:8200' "$ip" > "$cache"
  cat "$cache"
}

# Response and request material remain in the private per-deploy cache. Only
# numeric HTTP status reaches stdout; JWT/token values never enter curl argv.
openbao_reader_request() {
  local method="$1" path="$2" body_file="$3" token="$4" response_file="$5" limit="$6"
  local address config="${BAO_CACHE_DIR}/http-request.conf" status rc=0 started=$SECONDS remaining discovery_limit
  case "$method:$path:$limit" in
    POST:auth/kubernetes/login:20 | GET:cogni/data/"${DEPLOY_ENVIRONMENT}"/*:30 | GET:cogni/data/"${DEPLOY_ENVIRONMENT}"/*:10) : ;;
    *) printf '[openbao-reader] phase=http_request reason=scope_unproven\n' >&2; return 1 ;;
  esac
  discovery_limit=15
  [[ "$limit" -ge 15 ]] || discovery_limit="$limit"
  if address="$(openbao_reader_address "$discovery_limit")"; then :; else rc=$?; return "$rc"; fi
  # Discovery consumes the existing phase budget; it never adds a second timeout.
  remaining=$((limit - (SECONDS - started)))
  [[ "$remaining" -gt 0 ]] || return 124
  : > "$config"
  if [[ -n "$token" ]]; then
    [[ "$token" =~ ^[a-zA-Z0-9._-]+$ ]] || return 1
    printf 'header = "X-Vault-Token: %s"\n' "$token" >> "$config"
  fi
  local args=(--disable --silent --show-error --noproxy '*' --proto '=http' --max-redirs 0
    --connect-timeout "$remaining" --max-time "$remaining" --request "$method" --config "$config"
    --output "$response_file" --write-out '%{http_code}')
  [[ -z "$body_file" ]] || args+=(--header 'Content-Type: application/json' --data-binary "@$body_file")
  if status="$(timeout "$remaining" curl "${args[@]}" "${address}/v1/${path}" 2>"${BAO_CACHE_DIR}/http.stderr")"; then :; else rc=$?; fi
  rm -f "$config"
  printf '%s' "$status"
  return "$rc"
}

mint_db_reader_token() {
  local expires_file="${BAO_TOKEN_FILE}.expires-at" now expires="" ttl="" minted_at
  now="$(date +%s)" || return 1
  [[ "$now" =~ ^[1-9][0-9]{0,9}$ ]] || return 1
  if [[ -s "$BAO_TOKEN_FILE" && -s "$expires_file" ]]; then
    expires="$(cat "$expires_file")"
    if [[ "$expires" =~ ^[1-9][0-9]{0,9}$ ]] && (( expires > now )); then
      printf '%s\n' '[openbao-reader-token] phase=cache native_rc=0 reason=reused' >&2
      cat "$BAO_TOKEN_FILE"
      return 0
    fi
  fi
  # A token without proven remaining server lease is never reused. Expiry is
  # measured before native mint/login, with a further 35s conservative margin.
  rm -f "$BAO_TOKEN_FILE" "$expires_file"
  local jwt="" tok="" attempt phase rc reason status error_file body response
  error_file="${BAO_CACHE_DIR}/reader-mint.stderr"
  body="${BAO_CACHE_DIR}/reader-login.json" response="${BAO_CACHE_DIR}/reader-login-response.json"
  for attempt in 1 2 3; do
    phase=token_request rc=0 status=000
    minted_at="$(date +%s)" || return 1
    [[ "$minted_at" =~ ^[1-9][0-9]{0,9}$ ]] || return 1
    if jwt="$(timeout 15 kubectl create token db-provisioner -n default 2>"$error_file")"; then
      if [[ -n "$jwt" ]]; then
        phase=reader_login
        # jq reads the JWT from stdin; no secret request material in argv.
        printf '%s' "$jwt" | jq -Rs --arg role "${DEPLOY_ENVIRONMENT}-db-reader" '{role:$role,jwt:.}' > "$body"
        if status="$(openbao_reader_request POST auth/kubernetes/login "$body" '' "$response" 20)"; then
          if [[ "$status" == 200 ]]; then
            tok="$(jq -er '.auth.client_token | select(type == "string" and length > 0)' "$response" 2>/dev/null)" || tok=""
            ttl="$(jq -er '.auth.lease_duration | select(type == "number" and floor == . and . > 35 and . <= 2147483647)' "$response" 2>/dev/null)" || ttl=""
            if [[ -n "$tok" && "$ttl" =~ ^[1-9][0-9]{0,9}$ ]]; then
              expires=$((minted_at + ttl - 35))
              now="$(date +%s)" || return 1
              if [[ "$now" =~ ^[1-9][0-9]{0,9}$ ]] && (( expires > now )); then
                rm -f "$body" "$response" "$error_file"
                (umask 077; printf '%s' "$expires" > "$expires_file"; printf '%s' "$tok" > "$BAO_TOKEN_FILE")
                printf '%s' "$tok"
                return 0
              fi
            fi
          else rc=22; fi
        else rc=$?; fi
        rm -f "$body" "$response"
      fi
    else rc=$?; fi
    reason=permanent
    if [[ "$rc" -eq 124 || "$rc" -eq 28 || "$rc" -eq 7 || "$rc" -eq 52 || "$rc" -eq 56 || "$status" == 429 || "$status" =~ ^5[0-9][0-9]$ ]] \
      || grep -qiE 'context deadline exceeded|i/o timeout|TLS handshake timeout|connection (refused|reset)|unable to connect to the server|the server is currently unable to handle the request|Code: (429|500|502|503|504)' "$error_file"; then
      reason=server_transient
    elif [[ "$status" == 401 || "$status" == 403 ]] || grep -qiE 'Code: 403|permission denied|Forbidden' "$error_file"; then
      reason=permission_denied
    elif [[ "$rc" -eq 0 ]]; then reason=empty_output; fi
    rm -f "$error_file"
    printf '[openbao-reader-token] phase=%s native_rc=%s http_status=%s reason=%s attempt=%s/3\n' \
      "$phase" "$rc" "$status" "$reason" "$attempt" >&2
    [[ "$reason" == server_transient ]] || { [[ "$rc" -ne 0 ]] && return "$rc"; return 1; }
    [[ "$attempt" -lt 3 ]] && sleep 3
  done
  return 1
}

openbao_get_field() {
  local svc="$1" key="$2" read_limit="${3:-30}" max_attempts="${4:-3}" tok="" attempt cache="" status=000 rc=0
  [[ "$read_limit" == 10 || "$read_limit" == 30 ]] || return 1
  [[ "$max_attempts" == 1 || "$max_attempts" == 3 ]] || return 1
  [[ "$svc" =~ ^[a-zA-Z0-9_-]+$ ]] || return 1
  cache="${BAO_CACHE_DIR}/path-${svc}.json"
  if [[ ! -s "$cache" ]]; then
    for ((attempt=1; attempt<=max_attempts; attempt++)); do
      tok="$(mint_db_reader_token)" || return 1
      rc=0 status=000
      if status="$(openbao_reader_request GET "cogni/data/${DEPLOY_ENVIRONMENT}/${svc}" '' "$tok" "${cache}.tmp" "$read_limit")"; then
        if [[ "$status" == 200 ]] && jq -e '.data.data | type == "object"' "${cache}.tmp" >/dev/null 2>&1; then
          mv -f "${cache}.tmp" "$cache"; break
        fi
        # Positive HTTP404 is a known missing path; no unavailable read becomes absence.
        if [[ "$status" == 404 ]] && jq -e 'type == "object" and .errors == []' "${cache}.tmp" >/dev/null 2>&1; then rm -f "${cache}.tmp"; return 0; fi
        rc=22
      else rc=$?; fi
      rm -f "${cache}.tmp"
      printf '[openbao-reader] phase=kv_read native_rc=%s http_status=%s attempt=%s/%s\n' "$rc" "$status" "$attempt" "$max_attempts" >&2
      if [[ "$rc" -eq 124 || "$rc" -eq 28 || "$rc" -eq 7 || "$rc" -eq 52 || "$rc" -eq 56 || "$status" == 429 || "$status" =~ ^5[0-9][0-9]$ ]]; then
        rm -f "$BAO_TOKEN_FILE"
        [[ "$attempt" -lt "$max_attempts" ]] && sleep 3
      else return 1; fi
    done
  fi
  [[ -s "$cache" ]] || return 1
  jq -r --arg k "$key" '.data.data[$k] // empty' "$cache" 2>/dev/null
}

OPENBAO_RUNTIME_SSOT=false
ESO_TARGET="$(timeout 15 kubectl -n "cogni-${DEPLOY_ENVIRONMENT}" get secret operator-env-secrets --ignore-not-found -o name)" \
  || log_fatal "Cannot determine existing runtime custody; refusing bootstrap fallback"
if [[ -n "$ESO_TARGET" ]]; then
  OPENBAO_RUNTIME_SSOT=true
  log_info "operator-env-secrets exists; rendering runtime secrets from OpenBao SSoT"
else
  log_warn "operator-env-secrets not present; using workflow env values for fresh-env compatibility"
fi

source_openbao_runtime_key() {
  local mode="$1" key="$2" svc value
  shift 2
  "$OPENBAO_RUNTIME_SSOT" || return 0
  unset "$key" # An absent Bao value must never retain a legacy workflow value.
  for svc in "$@"; do
    value="$(openbao_get_field "$svc" "$key")" \
      || log_fatal "OpenBao runtime SSoT ${key} unavailable from expected owner path; see value-free reader diagnostics"
    if [[ -n "$value" ]]; then
      export "${key}=${value}"
      log_info "  sourced ${key} from OpenBao cogni/${DEPLOY_ENVIRONMENT}/${svc}"
      return 0
    fi
  done
  if [[ "$mode" == "required" ]]; then
    log_fatal "OpenBao runtime SSoT is active, but ${key} is absent from expected path(s): $*"
  fi
  return 0
}

source_operator_database_service_url() {
  OPERATOR_DATABASE_SERVICE_URL="$(openbao_get_field operator DATABASE_SERVICE_URL)" \
    || log_fatal "Canonical operator DATABASE_SERVICE_URL unavailable from OpenBao; see value-free reader diagnostics"
  [[ -n "$OPERATOR_DATABASE_SERVICE_URL" ]] \
    || log_fatal "Canonical operator DATABASE_SERVICE_URL is absent from OpenBao"
  export OPERATOR_DATABASE_SERVICE_URL
  log_info "  sourced scheduler-worker ledger DATABASE_URL from operator OpenBao SSoT"
}

# Established ESO environments render Compose .env, bridge Secrets, and the
# GitHub App webhook sync from OpenBao, not GitHub Environment secret input.
for key in DATABASE_URL DATABASE_SERVICE_URL APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD; do
  source_openbao_runtime_key required "$key" operator
done
for key in \
  AUTH_SECRET \
  LITELLM_MASTER_KEY \
  OPENROUTER_API_KEY \
  SCHEDULER_API_TOKEN \
  BILLING_INGEST_TOKEN \
  INTERNAL_OPS_TOKEN \
  GH_WEBHOOK_SECRET; do
  source_openbao_runtime_key required "$key" operator node-template _shared
done
source_operator_database_service_url
if "$OPENBAO_RUNTIME_SSOT"; then
  preserve_postgres_bootstrap_identity
  [[ "$DATABASE_URL" =~ ^postgres(ql)?://app_operator:[^@]+@[^/]+/cogni_operator(\?|$) &&
     "$DATABASE_SERVICE_URL" =~ ^postgres(ql)?://service_operator:[^@]+@[^/]+/cogni_operator(\?|$) ]] \
    || log_fatal "Canonical operator database identity mismatch"
  APP_DB_USER=app_operator APP_DB_SERVICE_USER=service_operator APP_DB_NAME=cogni_operator
  TEMPORAL_DB_USER="${TEMPORAL_DB_USER:-temporal}"
else
  # Positive ESO absence retains the original fresh-provision input contract.
  for key in DATABASE_URL DATABASE_SERVICE_URL LITELLM_MASTER_KEY OPENROUTER_API_KEY AUTH_SECRET \
    POSTGRES_ROOT_USER POSTGRES_ROOT_PASSWORD APP_DB_USER APP_DB_PASSWORD APP_DB_SERVICE_USER \
    APP_DB_SERVICE_PASSWORD APP_DB_NAME EVM_RPC_URL POLYGON_RPC_URL TEMPORAL_DB_USER \
    INTERNAL_OPS_TOKEN POSTHOG_API_KEY POSTHOG_HOST; do
    [[ -n "${!key:-}" ]] || log_fatal "Missing fresh-bootstrap input: $key"
  done
fi
# OPENFGA_DB_PASSWORD is a shared-infra DB-ROLE credential (OpenBao custody, Invariant
# 15) — read it via the env-wide ${env}-db-reader seam (openbao_get_field), which is
# available at infra-pass time on EVERY env. It must NOT go through
# source_openbao_runtime_key: that reader is gated on operator-env-secrets
# (OPENBAO_RUNTIME_SSOT), which does not exist on a fresh provision, so the required
# read silently skipped → `OPENFGA_DB_PASSWORD: unbound variable` under set -u aborted
# deploy-infra before the app layer. Provision Phase 5c seeds cogni/<env>/openfga/*.
OPENFGA_DB_PASSWORD="$(openbao_get_field openfga OPENFGA_DB_PASSWORD)"
[[ -n "$OPENFGA_DB_PASSWORD" ]] || log_fatal "OPENFGA_DB_PASSWORD absent from OpenBao cogni/${DEPLOY_ENVIRONMENT}/openfga — provision Phase 5c must seed it (never fall back to a divergent .env value)"
export OPENFGA_DB_PASSWORD
# TEMPORAL_DB_PASSWORD — same shared-infra DB-cred class as OPENFGA (dedicated
# temporal-postgres superuser). Read via the ungated ${env}-db-reader seam, not the
# operator-env-secrets-gated reader, so a fresh provision (SSOT off) binds it instead
# of aborting on set -u at the .env render. Provision Phase 5c seeds cogni/<env>/_shared.
TEMPORAL_DB_PASSWORD="$(openbao_get_field _shared TEMPORAL_DB_PASSWORD)"
[[ -n "$TEMPORAL_DB_PASSWORD" ]] || log_fatal "TEMPORAL_DB_PASSWORD absent from OpenBao cogni/${DEPLOY_ENVIRONMENT}/_shared — provision Phase 5c must seed it (never fall back to a divergent .env value)"
export TEMPORAL_DB_PASSWORD

for key in \
  METRICS_TOKEN \
  CONNECTIONS_ENCRYPTION_KEY \
  POSTHOG_API_KEY \
  POSTHOG_HOST \
  EVM_RPC_URL \
  POLYGON_RPC_URL \
  TAVILY_API_KEY \
  LANGFUSE_PUBLIC_KEY \
  LANGFUSE_SECRET_KEY \
  LANGFUSE_BASE_URL \
  GH_REVIEW_APP_ID \
  GH_REVIEW_APP_PRIVATE_KEY_BASE64 \
  GH_OAUTH_CLIENT_ID \
  GH_OAUTH_CLIENT_SECRET \
  DISCORD_OAUTH_CLIENT_ID \
  DISCORD_OAUTH_CLIENT_SECRET \
  GOOGLE_OAUTH_CLIENT_ID \
  GOOGLE_OAUTH_CLIENT_SECRET \
  DOLTHUB_OWNER \
  DOLT_CREDS_JWK \
  DOLT_CREDS_KEYID \
  DOLTHUB_API_TOKEN \
  DOLTHUB_OAUTH_CLIENT_ID \
  DOLTHUB_OAUTH_CLIENT_SECRET \
  PRIVY_APP_ID \
  PRIVY_APP_SECRET \
  PRIVY_SIGNING_KEY \
  PRIVY_USER_WALLETS_APP_ID \
  PRIVY_USER_WALLETS_APP_SECRET \
  PRIVY_USER_WALLETS_SIGNING_KEY \
  POLY_WALLET_AEAD_KEY_HEX \
  POLY_WALLET_AEAD_KEY_ID \
  POLY_CLOB_GEO_BLOCK_TOKEN; do
  source_openbao_runtime_key optional "$key" operator node-template _shared
done

# OpenFGA and Temporal DB passwords are OpenBao-custodied (Invariant 15). In
# established ESO mode the required source_openbao_runtime_key calls above render
# them from OpenBao and fail before Compose if OpenBao is sealed or unseeded. In
# fresh/plain-Secret bootstrap mode, keep the workflow env values until the ESO
# target exists.

cat > "$RUNTIME_ENV" << ENV_EOF
# Required vars
DOMAIN=${DOMAIN}
APP_ENV=${APP_ENV}
APP_BASE_URL=https://${DOMAIN}
NEXTAUTH_URL=https://${DOMAIN}
DATABASE_URL=${DATABASE_URL}
DATABASE_SERVICE_URL=${DATABASE_SERVICE_URL}
LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
AUTH_SECRET=${AUTH_SECRET}
POSTGRES_ROOT_USER=${POSTGRES_ROOT_USER}
POSTGRES_ROOT_PASSWORD=${POSTGRES_ROOT_PASSWORD}
APP_DB_USER=${APP_DB_USER}
APP_DB_PASSWORD=${APP_DB_PASSWORD}
APP_DB_SERVICE_USER=${APP_DB_SERVICE_USER}
APP_DB_SERVICE_PASSWORD=${APP_DB_SERVICE_PASSWORD}
APP_DB_NAME=${APP_DB_NAME}
OPENFGA_DB_PASSWORD=${OPENFGA_DB_PASSWORD}
DEPLOY_ENVIRONMENT=${DEPLOY_ENVIRONMENT}
EVM_RPC_URL=${EVM_RPC_URL:-}
POLYGON_RPC_URL=${POLYGON_RPC_URL:-}
TEMPORAL_DB_USER=${TEMPORAL_DB_USER}
TEMPORAL_DB_PASSWORD=${TEMPORAL_DB_PASSWORD}
COGNI_REPO_URL=${COGNI_REPO_URL}
COGNI_REPO_REF=${COGNI_REPO_REF}
GIT_READ_USERNAME=${GIT_READ_USERNAME}
GIT_READ_TOKEN=${GIT_READ_TOKEN}
POSTHOG_API_KEY=${POSTHOG_API_KEY:-}
POSTHOG_HOST=${POSTHOG_HOST:-}
# App/worker images — not started by infra deploy, but compose validates all vars.
# Use placeholder values; k8s/Argo manages the real images.
APP_IMAGE=${APP_IMAGE:-cogni-template-local}
MIGRATOR_IMAGE=${MIGRATOR_IMAGE:-unused-by-infra-deploy}
SCHEDULER_WORKER_IMAGE=${SCHEDULER_WORKER_IMAGE:-unused-by-infra-deploy}
# LiteLLM image — set above from GHCR content-hash tag.
LITELLM_IMAGE=${LITELLM_IMAGE}
# OpenFGA image — set above from GHCR content-hash tag.
OPENFGA_IMAGE=${OPENFGA_IMAGE}
ENV_EOF

# Verify .env was written
if ! test -s "$RUNTIME_ENV"; then
  log_error ".env write failed: $RUNTIME_ENV is empty or missing"
  exit 1
fi
log_info ".env base staged: $(wc -c < "$RUNTIME_ENV") bytes, $(wc -l < "$RUNTIME_ENV") lines"

# Optional observability vars — only written if set (empty string breaks Zod validation)
append_env_if_set "$RUNTIME_ENV" LOKI_WRITE_URL "${GRAFANA_CLOUD_LOKI_URL-}"
append_env_if_set "$RUNTIME_ENV" LOKI_USERNAME "${GRAFANA_CLOUD_LOKI_USER-}"
append_env_if_set "$RUNTIME_ENV" LOKI_PASSWORD "${GRAFANA_CLOUD_LOKI_API_KEY-}"
append_env_if_set "$RUNTIME_ENV" METRICS_TOKEN "${METRICS_TOKEN-}"
append_env_if_set "$RUNTIME_ENV" SCHEDULER_API_TOKEN "${SCHEDULER_API_TOKEN-}"
append_env_if_set "$RUNTIME_ENV" BILLING_INGEST_TOKEN "${BILLING_INGEST_TOKEN-}"
append_env_if_set "$RUNTIME_ENV" INTERNAL_OPS_TOKEN "${INTERNAL_OPS_TOKEN-}"
# Prometheus write path (Alloy)
append_env_if_set "$RUNTIME_ENV" PROMETHEUS_REMOTE_WRITE_URL "${PROMETHEUS_REMOTE_WRITE_URL-}"
append_env_if_set "$RUNTIME_ENV" PROMETHEUS_USERNAME "${PROMETHEUS_USERNAME-}"
append_env_if_set "$RUNTIME_ENV" PROMETHEUS_PASSWORD "${PROMETHEUS_PASSWORD-}"
# Prometheus read path (app queries)
append_env_if_set "$RUNTIME_ENV" PROMETHEUS_QUERY_URL "${PROMETHEUS_QUERY_URL-}"
append_env_if_set "$RUNTIME_ENV" PROMETHEUS_READ_USERNAME "${PROMETHEUS_READ_USERNAME-}"
append_env_if_set "$RUNTIME_ENV" PROMETHEUS_READ_PASSWORD "${PROMETHEUS_READ_PASSWORD-}"
append_env_if_set "$RUNTIME_ENV" LANGFUSE_PUBLIC_KEY "${LANGFUSE_PUBLIC_KEY-}"
append_env_if_set "$RUNTIME_ENV" LANGFUSE_SECRET_KEY "${LANGFUSE_SECRET_KEY-}"
append_env_if_set "$RUNTIME_ENV" LANGFUSE_BASE_URL "${LANGFUSE_BASE_URL-}"
# Discord bot
append_env_if_set "$RUNTIME_ENV" DISCORD_BOT_TOKEN "${DISCORD_BOT_TOKEN-}"
# OAuth providers (optional)
append_env_if_set "$RUNTIME_ENV" GH_OAUTH_CLIENT_ID "${GH_OAUTH_CLIENT_ID-}"
append_env_if_set "$RUNTIME_ENV" GH_OAUTH_CLIENT_SECRET "${GH_OAUTH_CLIENT_SECRET-}"
append_env_if_set "$RUNTIME_ENV" DISCORD_OAUTH_CLIENT_ID "${DISCORD_OAUTH_CLIENT_ID-}"
append_env_if_set "$RUNTIME_ENV" DISCORD_OAUTH_CLIENT_SECRET "${DISCORD_OAUTH_CLIENT_SECRET-}"
append_env_if_set "$RUNTIME_ENV" GOOGLE_OAUTH_CLIENT_ID "${GOOGLE_OAUTH_CLIENT_ID-}"
append_env_if_set "$RUNTIME_ENV" GOOGLE_OAUTH_CLIENT_SECRET "${GOOGLE_OAUTH_CLIENT_SECRET-}"
append_env_if_set "$RUNTIME_ENV" DOLTHUB_OWNER "${DOLTHUB_OWNER-}"
append_env_if_set "$RUNTIME_ENV" DOLT_CREDS_JWK "${DOLT_CREDS_JWK-}"
append_env_if_set "$RUNTIME_ENV" DOLT_CREDS_KEYID "${DOLT_CREDS_KEYID-}"
append_env_if_set "$RUNTIME_ENV" DOLTHUB_API_TOKEN "${DOLTHUB_API_TOKEN-}"
append_env_if_set "$RUNTIME_ENV" DOLTHUB_OAUTH_CLIENT_ID "${DOLTHUB_OAUTH_CLIENT_ID-}"
append_env_if_set "$RUNTIME_ENV" DOLTHUB_OAUTH_CLIENT_SECRET "${DOLTHUB_OAUTH_CLIENT_SECRET-}"
# GitHub App credentials (scheduler-worker ingestion)
append_env_if_set "$RUNTIME_ENV" GH_REVIEW_APP_ID "${GH_REVIEW_APP_ID-}"
append_env_if_set "$RUNTIME_ENV" GH_REVIEW_APP_PRIVATE_KEY_BASE64 "${GH_REVIEW_APP_PRIVATE_KEY_BASE64-}"
append_env_if_set "$RUNTIME_ENV" GH_REPOS "${GH_REPOS-}"
append_env_if_set "$RUNTIME_ENV" GH_WEBHOOK_SECRET "${GH_WEBHOOK_SECRET-}"
# Privy (Operator Wallet)
append_env_if_set "$RUNTIME_ENV" PRIVY_APP_ID "${PRIVY_APP_ID-}"
append_env_if_set "$RUNTIME_ENV" PRIVY_APP_SECRET "${PRIVY_APP_SECRET-}"
append_env_if_set "$RUNTIME_ENV" PRIVY_SIGNING_KEY "${PRIVY_SIGNING_KEY-}"
# Privy (Per-tenant Poly Trading Wallets)
append_env_if_set "$RUNTIME_ENV" PRIVY_USER_WALLETS_APP_ID "${PRIVY_USER_WALLETS_APP_ID-}"
append_env_if_set "$RUNTIME_ENV" PRIVY_USER_WALLETS_APP_SECRET "${PRIVY_USER_WALLETS_APP_SECRET-}"
append_env_if_set "$RUNTIME_ENV" PRIVY_USER_WALLETS_SIGNING_KEY "${PRIVY_USER_WALLETS_SIGNING_KEY-}"
append_env_if_set "$RUNTIME_ENV" POLY_WALLET_AEAD_KEY_HEX "${POLY_WALLET_AEAD_KEY_HEX-}"
append_env_if_set "$RUNTIME_ENV" POLY_WALLET_AEAD_KEY_ID "${POLY_WALLET_AEAD_KEY_ID-}"
append_env_if_set "$RUNTIME_ENV" POLY_CLOB_GEO_BLOCK_TOKEN "${POLY_CLOB_GEO_BLOCK_TOKEN-}"
# BYO-AI: Connection encryption
append_env_if_set "$RUNTIME_ENV" CONNECTIONS_ENCRYPTION_KEY "${CONNECTIONS_ENCRYPTION_KEY-}"
# OpenFGA authn is disabled by default for the VM-internal service. When
# enabled, seed OPENFGA_API_TOKEN through the environment/OpenBao path; never
# commit it in manifests.
append_env_if_set "$RUNTIME_ENV" OPENFGA_AUTHN_METHOD "${OPENFGA_AUTHN_METHOD-}"
append_env_if_set "$RUNTIME_ENV" OPENFGA_API_TOKEN "${OPENFGA_API_TOKEN-}"
# Grafana observability
derive_pdc_defaults_from_token
append_env_if_set "$RUNTIME_ENV" GRAFANA_URL "${GRAFANA_URL-}"
append_env_if_set "$RUNTIME_ENV" GRAFANA_SERVICE_ACCOUNT_TOKEN "${GRAFANA_SERVICE_ACCOUNT_TOKEN-}"
append_env_if_set "$RUNTIME_ENV" GRAFANA_PDC_SIGNING_TOKEN "${GRAFANA_PDC_SIGNING_TOKEN-}"
append_env_if_set "$RUNTIME_ENV" GRAFANA_PDC_HOSTED_GRAFANA_ID "${GRAFANA_PDC_HOSTED_GRAFANA_ID-}"
append_env_if_set "$RUNTIME_ENV" GRAFANA_PDC_CLUSTER "${GRAFANA_PDC_CLUSTER-}"
append_env_if_set "$RUNTIME_ENV" GRAFANA_PDC_NETWORK_ID "${GRAFANA_PDC_NETWORK_ID-}"
# LiteLLM (Compose) → node apps (k3s NodePorts) via bug.0295 VM DNS.
# Derived from NODE_TARGETS so node-local metering gets slug + UUID aliases
# for every catalog node without a deploy-script edit.
printf '%s=%s\n' COGNI_NODE_ENDPOINTS "${LITELLM_NODE_ENDPOINTS:?LITELLM_NODE_ENDPOINTS required}" >> "$RUNTIME_ENV"
printf '%s=%s\n' COGNI_DEFAULT_NODE_ID "${COGNI_DEFAULT_NODE_ID:?COGNI_DEFAULT_NODE_ID required}" >> "$RUNTIME_ENV"
# Multi-node DB provisioning
append_env_if_set "$RUNTIME_ENV" COGNI_NODE_DBS "${COGNI_NODE_DBS-}"
# Database backup cadence. A systemd timer runs the Compose db-backup profile as
# a one-shot container; defaults avoid requiring new GitHub Environment secrets.
printf '%s=%s\n' DB_BACKUP_INTERVAL_SECONDS "${DB_BACKUP_INTERVAL_SECONDS:-86400}" >> "$RUNTIME_ENV"
printf '%s=%s\n' DB_BACKUP_RETENTION_DAYS "${DB_BACKUP_RETENTION_DAYS:-14}" >> "$RUNTIME_ENV"
printf '%s=%s\n' DB_BACKUP_OBSERVABILITY_GRACE_SECONDS "${DB_BACKUP_OBSERVABILITY_GRACE_SECONDS:-90}" >> "$RUNTIME_ENV"

# ── Derived database credentials ─────────────────────────────────────────
# Derived deterministically from POSTGRES_ROOT_PASSWORD + salt so no new GitHub
# Environment secrets are required. Rotating POSTGRES_ROOT_PASSWORD rotates them.
derive_secret() {
  local salt="$1"
  if command -v openssl >/dev/null 2>&1; then
    printf '%s:%s' "$salt" "${POSTGRES_ROOT_PASSWORD:-doltgres}" | openssl dgst -sha256 -hex | awk '{print $NF}' | cut -c1-32
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s:%s' "$salt" "${POSTGRES_ROOT_PASSWORD:-doltgres}" | sha256sum | cut -c1-32
  else
    echo "dev-${salt}"
  fi
}
APP_DB_READONLY_USER="${APP_DB_READONLY_USER:-app_readonly}"
APP_DB_READONLY_PASSWORD="${APP_DB_READONLY_PASSWORD:-$(derive_secret postgres-readonly)}"
printf '%s=%s\n' APP_DB_READONLY_USER "$APP_DB_READONLY_USER" >> "$RUNTIME_ENV"
printf '%s=%s\n' APP_DB_READONLY_PASSWORD "$APP_DB_READONLY_PASSWORD" >> "$RUNTIME_ENV"

# Doltgres superuser password — OpenBao-custodied SSOT at the canonical operator
# path (cogni/<env>/operator/DOLTGRES_PASSWORD). Shared env-wide (one server, every
# node's knowledge_<node> DB), immutable post-init (Doltgres 0.56.3 can't ALTER it;
# databases.md §5.2). Source it via the same ${DEPLOY_ENVIRONMENT}-db-reader seam as
# OPENFGA_DB_PASSWORD above so the rendered VM .env carries the LIVE value, not a
# re-derived one that drifts after a volume restore / root-cred rotation (the
# 2026-06-10 prod node-substrate 28P01). A drifted volume is reconciled via
# `pnpm secrets:set <env> operator DOLTGRES_PASSWORD` (secrets-rotate.md), never
# re-derived. derive_secret survives ONLY as the genesis default for a fresh volume
# OpenBao has not seeded yet (first provision, pre-materialize). The reader/writer
# roles are CREATEd fresh each provision (ALTERable, not the superuser) — left derived.
DOLTGRES_PASSWORD_SSOT="$(openbao_get_field operator DOLTGRES_PASSWORD)" \
  || log_fatal "Canonical DOLTGRES_PASSWORD unavailable from OpenBao; refusing genesis fallback after a failed read"
if [ -n "$DOLTGRES_PASSWORD_SSOT" ]; then
  DOLTGRES_PASSWORD="$DOLTGRES_PASSWORD_SSOT"
else
  "$OPENBAO_RUNTIME_SSOT" && log_fatal "Canonical DOLTGRES_PASSWORD absent from OpenBao; refusing genesis fallback on an established environment"
  log_warn "Doltgres superuser SSOT empty at cogni/${DEPLOY_ENVIRONMENT}/operator/DOLTGRES_PASSWORD — using genesis derive (valid only for a fresh volume; reconcile via 'pnpm secrets:set ${DEPLOY_ENVIRONMENT} operator DOLTGRES_PASSWORD' if the volume already exists)"
  DOLTGRES_PASSWORD="${DOLTGRES_PASSWORD:-$(derive_secret doltgres-root)}"
fi
DOLTGRES_READER_PASSWORD="${DOLTGRES_READER_PASSWORD:-$(derive_secret doltgres-reader)}"
DOLTGRES_WRITER_PASSWORD="${DOLTGRES_WRITER_PASSWORD:-$(derive_secret doltgres-writer)}"
printf '%s=%s\n' DOLTGRES_PASSWORD "$DOLTGRES_PASSWORD" >> "$RUNTIME_ENV"
printf '%s=%s\n' DOLTGRES_READER_PASSWORD "$DOLTGRES_READER_PASSWORD" >> "$RUNTIME_ENV"
printf '%s=%s\n' DOLTGRES_WRITER_PASSWORD "$DOLTGRES_WRITER_PASSWORD" >> "$RUNTIME_ENV"

# Publish the complete projection atomically. A failed render leaves the prior
# installed generation untouched; the last-good receipt therefore continues to
# describe either the exact installed bytes or a detectable mismatch.
docker compose --project-name cogni-runtime --env-file "$RUNTIME_ENV" -f "$RUNTIME_COMPOSE_FILE" ${RUNTIME_OBSERVABILITY_ARGS:-} --profile bootstrap config --quiet 2>/dev/null \
  || log_fatal "Resolved runtime consumer configuration is invalid; installed environment retained"
chmod 600 "$RUNTIME_ENV"
mv -f "$RUNTIME_ENV" "$INSTALLED_RUNTIME_ENV"
RUNTIME_ENV="$INSTALLED_RUNTIME_ENV"
RUNTIME_ENV_NEXT=""
log_info ".env atomically installed: $(wc -c < "$RUNTIME_ENV") bytes, $(wc -l < "$RUNTIME_ENV") lines"

if [[ "${K8S_SECRETS_ONLY:-false}" != "true" ]]; then

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 2: Start edge stack (idempotent - only starts if not running)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Edge-Caddy reconcile (start-if-down + hash-gated force-recreate) lives in one
# shared VM-side helper that both deploy-infra and reconcile-node-substrate scp
# + invoke. CADDYFILE is the rendered template deploy-infra writes (see Step 1).
EDGE_COMPOSE_BIN="$EDGE_COMPOSE" \
CADDYFILE="/opt/cogni-template-edge/configs/Caddyfile.tmpl" \
EDGE_ENV_FILE="/opt/cogni-template-edge/.env" \
HASH_DIR="/var/lib/cogni" \
  bash /tmp/reconcile-edge-caddy.remote.sh

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 2.5: Disk cleanup gate (before any image pulls)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AVAIL_GB=$(df -BG / | tail -1 | awk '{print $4}' | tr -d G)
USED_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d %)

log_info "Disk: ${AVAIL_GB}GB free, ${USED_PCT}% used"

if [ "$AVAIL_GB" -lt 7 ] || [ "$USED_PCT" -gt 70 ]; then
  log_warn "Low disk space (${AVAIL_GB}GB free, ${USED_PCT}% used). Running cleanup..."
  docker system prune -af || true
  journalctl --vacuum-time=3d || true

  AVAIL_GB=$(df -BG / | tail -1 | awk '{print $4}' | tr -d G)
  log_info "Free space after cleanup: ${AVAIL_GB}GB"

  if [ "$AVAIL_GB" -lt 5 ]; then
    log_error "Insufficient disk after cleanup (${AVAIL_GB}GB free)."
    exit 1
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 3: Authenticate to GHCR
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "Logging into GHCR for private image pulls..."
echo "${GHCR_DEPLOY_TOKEN}" | docker login ghcr.io -u "${GHCR_USERNAME}" --password-stdin

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 3.5: Pull images (may update on :latest)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Pull LiteLLM from GHCR (built in CI — bug.0298 / G12).
# LITELLM_IMAGE was self-resolved above from COGNI_REPO_REF to a GHCR tag,
# or remains "cogni-litellm:latest" for local dev/provision (no pull needed).
if [[ "$LITELLM_IMAGE" == ghcr.io/* ]]; then
  log_info "Pulling LiteLLM image: $LITELLM_IMAGE"
  docker pull "$LITELLM_IMAGE"
else
  log_info "LiteLLM image is local ($LITELLM_IMAGE) — skipping pull"
fi
if [[ "$OPENFGA_IMAGE" == ghcr.io/* ]]; then
  log_info "Pulling OpenFGA image: $OPENFGA_IMAGE"
  docker pull "$OPENFGA_IMAGE"
else
  log_info "OpenFGA image is local ($OPENFGA_IMAGE) — skipping pull"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 4: Assert profile services exist (guard against silent compose drift)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESOLVED_SERVICES=$($RUNTIME_COMPOSE --profile bootstrap config --services)
log_info "Profile guardrail passed"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 5: Start/update postgres (must be healthy before provisioning)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "Bringing up postgres..."
if ! output="$($RUNTIME_COMPOSE up -d postgres 2>&1)"; then
  printf '%s\n' "$output" >&2
  # bug.5133 — NEVER auto-teardown the shared runtime as "recovery": healthy
  # services may still be serving users. Fail red; a human/operator decides.
  log_error "Incremental postgres reconcile failed; refusing automatic runtime teardown."
  exit 1
else
  printf '%s\n' "$output"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6: Run DB provisioning (idempotent — creates users/DBs if missing)
# Note: DB migrations are NOT run here — k8s PreSync hook handles those.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "[$(date -u +%H:%M:%S)] Running DB provisioning..."
emit_deployment_event "infra_deployment.db_provision_started" "in_progress" "Provisioning database users and schemas"
# Shared infra DBs FIRST, decoupled from per-node creds. The litellm/openfga
# root-owned DBs depend only on the root Postgres creds (.env) — never OpenBao,
# never a node DB. On a fresh env the per-node loop below is fully fail-soft
# (every node skips until its OpenBao creds materialize), so coupling infra-DB
# creation to that loop left openfga uncreated → openfga-migrate hard-fails with
# `database "openfga" does not exist`. This dedicated INFRA_ONLY pass guarantees
# openfga + litellm exist before openfga-migrate regardless of node-cred state.
log_info "  Provisioning shared infra DBs (litellm, openfga) — decoupled from per-node creds..."
$RUNTIME_COMPOSE --profile bootstrap run --rm \
  -e "PROVISION_INFRA_ONLY=1" \
  -e "OPENFGA_DB_PASSWORD=${OPENFGA_DB_PASSWORD}" \
  db-provision
# Per-node db-provision (#1584): provision.sh now reconciles per-node roles
# app_<node>/service_<node> to the per-node passwords OpenBao holds at
# cogni/<env>/<node>, and refuses a multi-node COGNI_NODE_DBS so one shared
# password can never leak across nodes. So loop the catalog node list (the same
# NODE_TARGETS that drives node_database_csv) and invoke db-provision ONCE per
# node, overriding COGNI_NODE_DBS to that single DB and injecting its OpenBao
# passwords via -e — the same contract reconcile-node-substrate.sh uses. The
# litellm/openfga root-owned DBs are (re)created idempotently each pass; harmless.
# Per-node OpenBao read uses the same least-privilege ${DEPLOY_ENVIRONMENT}-db-reader
# k8s-auth role proven above. Values are never echoed; only key names appear in logs.
# Reuse the earlier file-cached SAME-role reader; do not shadow its login/cache policy.
DB_READER_TOKEN=""
read_node_db_secret() {
  openbao_get_field "$1" "$2" 10 1
}
DB_READER_TOKEN="$(mint_db_reader_token)" \
  || log_fatal "db-provision: ${DEPLOY_ENVIRONMENT}-db-reader token unavailable; see value-free mint phase diagnostics"
[ -n "$DB_READER_TOKEN" ] || log_fatal "db-provision: ${DEPLOY_ENVIRONMENT}-db-reader token unavailable; empty reader result"
# The runner forwards the exact-source shared-node budget map through the same
# SSH environment file as NODE_APP_TARGETS (bash arrays do not cross that boundary).
# Keep the full node roster for Doltgres, secrets and routing; only Postgres is
# narrowed to active shared-tier declarations.
[[ -n "${NODE_APP_TARGETS// /}" ]] || log_fatal "NODE_APP_TARGETS empty in the remote script — per-node db-provision would create ZERO app_<node> roles and every node app would 28P01 (bug.5090 silent-skip class). Refusing to continue."
provision_shared_node_databases() {
  local node node_db app_pw svc_pw migration_pw budget_entry shared_nodes
  local -a provision_env
  printf '%s' "${NODE_DB_PROVISION_CONFIG:-}" | jq -e 'type == "object"' >/dev/null \
    || log_fatal "Shared database budget map missing or invalid after SSH transport"
  shared_nodes="$(printf '%s' "$NODE_DB_PROVISION_CONFIG" | jq -r 'keys[]')" \
    || log_fatal "Could not read shared database node inventory"
  for node in $shared_nodes; do
    node_db="cogni_${node//-/_}"
    app_pw="$(read_node_db_secret "$node" APP_DB_PASSWORD)"
    svc_pw="$(read_node_db_secret "$node" APP_DB_SERVICE_PASSWORD)"
    migration_pw="$(read_node_db_secret "${node}-database-migration" APP_DB_MIGRATION_PASSWORD)"
    if [ -z "$app_pw" ] || [ -z "$svc_pw" ] || [ -z "$migration_pw" ]; then
      # fail-soft per node (parity with bug.5086 *-node-app-secrets): a dead/un-materialized
      # catalog node must not wedge the whole env. Require the complete credential
      # set before invoking the provisioner; never invent a migration password.
      log_warn "  Skipped ${node_db}: incomplete runtime/isolated migration credentials in cogni/${DEPLOY_ENVIRONMENT} — run secret-materialize first"
      continue
    fi
    provision_env=()
    while IFS= read -r budget_entry; do
      provision_env+=(-e "$budget_entry")
    done < <(printf '%s' "$NODE_DB_PROVISION_CONFIG" | jq -r --arg node "$node" '.[$node] | to_entries[] | "\(.key)=\(.value)"')
    log_info "  Provisioning ${node_db} (per-node OpenBao creds)..."
    $RUNTIME_COMPOSE --profile bootstrap run --rm \
      -e "COGNI_NODE_DBS=${node_db}" \
      -e "APP_DB_PASSWORD=${app_pw}" \
      -e "APP_DB_SERVICE_PASSWORD=${svc_pw}" \
      -e "APP_DB_MIGRATION_PASSWORD=${migration_pw}" \
      "${provision_env[@]}" \
      db-provision
  done
}
provision_shared_node_databases
$RUNTIME_COMPOSE --profile bootstrap run --rm openfga-migrate

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6a: Bring up Doltgres + provision DBs + roles
# Parallel to postgres/db-provision above, but for the knowledge data plane.
# Schema migration itself is NOT run here — it's a k8s PreSync Job
# (infra/k8s/base/poly-doltgres/doltgres-migration-job.yaml) that Argo CD
# runs before the poly Deployment syncs. Same pattern as the Postgres
# migrator Job (infra/k8s/base/node-app/migration-job.yaml).
# Guarded on compose presence — tolerates envs where doltgres is not in the compose file.
# DOLTGRES_PASSWORD was resolved from the operator-canonical OpenBao SSOT above (the
# same value rendered into RUNTIME_ENV), so the provisioner connects as the live
# superuser — no late sed-parse of DOLTGRES_URL, no derived-vs-live reconciliation here.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if doltgres_in_compose; then
  log_info "[$(date -u +%H:%M:%S)] Bringing up doltgres..."
  $RUNTIME_COMPOSE up -d doltgres

  log_info "[$(date -u +%H:%M:%S)] Provisioning Doltgres DBs + roles..."
  # --no-deps is load-bearing: `compose run` otherwise RECREATES the doltgres dependency
  # mid-fresh-init, interrupting default-database creation → `database "postgres" does not
  # exist` on a FRESH volume (every clean prod/preview reprovision, 2026-08-05). doltgres is
  # already up (line ~1197); the provision run must attach to it, never recreate it.
  $RUNTIME_COMPOSE --profile bootstrap run --rm --no-deps \
    -e DOLTGRES_PASSWORD="$DOLTGRES_PASSWORD" \
    doltgres-provision

  log_info "[$(date -u +%H:%M:%S)] Doltgres up + DBs provisioned. Schema migration runs as k8s PreSync Job."
else
  log_info "Doltgres not present in compose config — skipping knowledge plane bootstrap"
fi
log_info "[$(date -u +%H:%M:%S)] DB provisioning complete"
emit_deployment_event "infra_deployment.db_provision_complete" "success" "Database provisioned successfully"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6.5: Reconcile temporal-postgres superuser (idempotent; closes 28P01 trap)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Temporal runs on a DEDICATED postgres (compose service `temporal-postgres`) whose
# `temporal` role is the SUPERUSER. That password is baked into the volume only at
# first-init from TEMPORAL_DB_PASSWORD; nothing reconciles it afterward. When the env
# value drifts from the frozen volume value (rotation / re-seed), the next deploy
# restarts `temporal` against a password the volume superuser never adopted →
# `pq: password authentication failed for user "temporal"` → temporal never binds
# :7233 → every node's readiness fail-closes → all nodes 503 (prod + preview,
# 2026-06-11). Reconcile the volume superuser to the OpenBao value BEFORE temporal
# starts, idempotently every run, via the local-trust socket (no old password needed —
# the manual heal both incidents). #1625 ALTERed a `temporal` role on the MAIN shared
# postgres (the wrong DB) and never touched this volume; this is the real fix.
if [[ -n "${TEMPORAL_DB_PASSWORD:-}" ]]; then
  # TEMPORAL_DB_PASSWORD is catalog hex (generate: hex, bytes:24 → 48 hex chars);
  # validate the shape so we never inject a malformed/quoted value into SQL.
  if [[ "$TEMPORAL_DB_PASSWORD" =~ ^[0-9a-fA-F]+$ ]]; then
    _tp_user="${TEMPORAL_DB_USER:-temporal}"
    log_info "Bringing up temporal-postgres (dedicated) and reconciling its superuser..."
    $RUNTIME_COMPOSE up -d temporal-postgres
    # Wait for the dedicated postgres to accept local connections (pg_isready over
    # the local-trust socket, no password) before ALTER — bounded, fail-loud.
    _tp_elapsed=0
    until $RUNTIME_COMPOSE exec -T temporal-postgres pg_isready -U "$_tp_user" -q; do
      if [ "$_tp_elapsed" -ge 60 ]; then
        log_fatal "temporal-postgres not ready after 60s — cannot reconcile superuser."
      fi
      sleep 2
      _tp_elapsed=$((_tp_elapsed + 2))
    done
    # Local-trust socket: psql -U temporal -d postgres authenticates without the old
    # password. Value embedded directly (NOT psql -v :'pw' — that interpolation form
    # errored "syntax error at or near :" through the compose/exec layer during the
    # 2026-06-11 manual converge); TEMPORAL_DB_PASSWORD is hex-validated above, so the
    # single-quoted literal is injection-safe. SCRAM rehash every run is cheap + idempotent.
    if $RUNTIME_COMPOSE exec -T temporal-postgres \
        psql -U "$_tp_user" -d postgres -v ON_ERROR_STOP=1 \
        -c "ALTER USER \"$_tp_user\" WITH PASSWORD '$TEMPORAL_DB_PASSWORD';" >/dev/null; then
      log_info "temporal-postgres superuser reconciled to OpenBao value."
    else
      log_fatal "temporal-postgres superuser reconcile failed — refusing to start temporal against a drifted password (would 28P01)."
    fi
    unset _tp_user _tp_elapsed
  else
    log_fatal "TEMPORAL_DB_PASSWORD is not hex — refusing to reconcile temporal-postgres (malformed/unseeded value)."
  fi
else
  log_warn "TEMPORAL_DB_PASSWORD unset (OpenBao sealed / unseeded) — skipping temporal-postgres reconcile; temporal will use the volume-init value."
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6.6: Start/update infra services (rolling update, no down)
# Compose infra (Temporal, LiteLLM, Redis) must be up BEFORE k8s pods restart,
# because k8s pods depend on these via EndpointSlice bridges.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "[$(date -u +%H:%M:%S)] Starting infra services (rolling update)..."
emit_deployment_event "infra_deployment.stack_up_started" "in_progress" "Starting infrastructure services"

# Infra services only — excludes app, scheduler-worker, db-migrate, and one-shot backup jobs
INFRA_SERVICES="postgres litellm openfga redis alloy temporal-postgres temporal temporal-ui autoheal repo-init git-sync"
# Doltgres is optional — only include if it's in the compose file for this env.
if doltgres_in_compose; then
  INFRA_SERVICES="$INFRA_SERVICES doltgres"
fi
# alloy-k8s-events is optional — only include if defined in this compose file.
if $RUNTIME_COMPOSE config --services 2>/dev/null | grep -q '^alloy-k8s-events$'; then
  INFRA_SERVICES="$INFRA_SERVICES alloy-k8s-events"
fi

pdc_enabled=false
if [[ -n "${GRAFANA_PDC_SIGNING_TOKEN:-}" && -n "${GRAFANA_PDC_HOSTED_GRAFANA_ID:-}" && -n "${GRAFANA_PDC_CLUSTER:-}" ]]; then
  INFRA_SERVICES="$INFRA_SERVICES pdc-agent"
  pdc_enabled=true
else
  log_warn "Grafana PDC agent not started: GRAFANA_PDC_SIGNING_TOKEN, GRAFANA_PDC_HOSTED_GRAFANA_ID, or GRAFANA_PDC_CLUSTER is unset"
fi

runtime_compose_up_with_retry() {
  local profile="$1"
  shift
  local max_attempts=3
  local attempt output
  for attempt in $(seq 1 "$max_attempts"); do
    if [[ -n "$profile" ]]; then
      if output="$(COMPOSE_PROFILES="$profile" $RUNTIME_COMPOSE up -d --remove-orphans "$@" 2>&1)"; then
        printf '%s\n' "$output"
        return 0
      fi
    elif output="$($RUNTIME_COMPOSE up -d --remove-orphans "$@" 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    fi

    printf '%s\n' "$output" >&2
    if [[ "$attempt" == "$max_attempts" ]]; then
      return 1
    fi
    log_warn "Runtime compose up failed on attempt ${attempt}/${max_attempts}; waiting for health state to settle before retry"
    $RUNTIME_COMPOSE ps 2>&1 || true
    sleep 20
  done
}

if $pdc_enabled; then
  runtime_compose_up_with_retry pdc $INFRA_SERVICES
  sleep 5
  if ! $RUNTIME_COMPOSE ps --status running pdc-agent 2>/dev/null | grep -q 'pdc-agent'; then
    log_warn "Grafana PDC agent is not running after compose up; recent logs follow"
    $RUNTIME_COMPOSE logs --tail=80 pdc-agent || true
    exit 1
  fi
  # Always tail recent pdc-agent logs so SSH-tunnel failures are visible even
  # when the container itself is "Up". The SSH cert exchange happens at startup;
  # success looks like "level=info msg=... connected" and any "invalid
  # credentials" / "key signing request failed" surfaces here.
  log_info "Grafana pdc-agent recent logs:"
  $RUNTIME_COMPOSE logs --tail=40 pdc-agent || true
else
  runtime_compose_up_with_retry "" $INFRA_SERVICES
fi

log_info "[$(date -u +%H:%M:%S)] Infra stack up complete"
emit_deployment_event "infra_deployment.stack_up_complete" "success" "Infrastructure services started"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6.6a: Bootstrap OpenFGA store/model and publish operator runtime IDs
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "[$(date -u +%H:%M:%S)] Bootstrapping OpenFGA RBAC store/model..."
if ! command -v jq >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    log_info "jq not found on VM; installing jq for OpenFGA bootstrap..."
    DEBIAN_FRONTEND=noninteractive apt-get update >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y jq >/dev/null
  else
    log_fatal "jq is required for OpenFGA bootstrap and apt-get is unavailable"
  fi
fi
OPENFGA_BOOTSTRAP_ENV=$(OPENFGA_API_URL=http://127.0.0.1:8080 \
  OPENFGA_STORE_NAME="cogni-${DEPLOY_ENVIRONMENT}-rbac" \
  OPENFGA_MODEL_FILE=/tmp/rbac-model.json \
  OPENFGA_API_TOKEN="${OPENFGA_API_TOKEN:-}" \
  OPENFGA_AUTHORIZATION_MODEL_ID="$PREVIOUS_OPENFGA_AUTHORIZATION_MODEL_ID" \
  OPENFGA_AUTHORIZATION_MODEL_HASH="$PREVIOUS_OPENFGA_AUTHORIZATION_MODEL_HASH" \
  bash /tmp/bootstrap-openfga.sh)
eval "$OPENFGA_BOOTSTRAP_ENV"
printf '%s\n' "$OPENFGA_BOOTSTRAP_ENV" >> "$RUNTIME_ENV"
log_info "OpenFGA RBAC config resolved: store=${OPENFGA_STORE_ID} model=${OPENFGA_AUTHORIZATION_MODEL_ID}"

classify_openbao_writer_login_failure() {
  local rc="$1" output="$2"
  if [[ $rc -eq 124 ]] || grep -qiE 'context deadline exceeded|Internal error occurred: Timeout occurred|i/o timeout|TLS handshake timeout|connection (refused|reset)|Code: (429|500|502|503|504)' <<<"$output"; then
    printf '%s\n' server_transient
  elif grep -qiE 'Code: 403|permission denied' <<<"$output"; then
    printf '%s\n' permission_denied_recheck
  else
    printf '%s\n' permanent
  fi
}

classify_kubectl_resource_lookup_failure() {
  local rc="$1" output="$2"
  if [[ $rc -eq 124 ]] || grep -qiE 'context deadline exceeded|Internal error occurred: Timeout occurred|i/o timeout|TLS handshake timeout|connection (refused|reset)|unable to connect to the server|the server is currently unable to handle the request|Code: (429|500|502|503|504)' <<<"$output"; then
    printf '%s\n' server_transient
  elif grep -qiE '\(NotFound\)|not found' <<<"$output"; then
    printf '%s\n' absent
  else
    printf '%s\n' permanent
  fi
}

patch_operator_openfga_config() {
  if ! command -v kubectl >/dev/null 2>&1; then
    log_warn "kubectl not found — cannot patch OpenBao operator OpenFGA config"
    return 1
  fi

  local jwt tok path patch_out patch_rc login_out login_rc login_reason max_attempts attempt sleep_seconds
  local sa_out sa_rc sa_reason
  for attempt in 1 2 3; do
    set +e
    sa_out=$(timeout 10 kubectl get sa openbao-operator -n default -o name 2>&1)
    sa_rc=$?
    set -e
    if [[ $sa_rc -eq 0 ]]; then
      break
    fi

    sa_reason="$(classify_kubectl_resource_lookup_failure "$sa_rc" "$sa_out")"
    case "$sa_reason" in
      absent)
        log_warn "openbao-operator SA is absent — cannot patch OpenBao operator OpenFGA config"
        return 1
        ;;
      server_transient)
        if [[ $attempt -lt 3 ]]; then
          sleep_seconds=$((attempt * 5))
          log_warn "OpenBao writer SA lookup hit a control-plane timeout/transient (attempt ${attempt}/3); retrying in ${sleep_seconds}s"
          sleep "$sleep_seconds"
          continue
        fi
        log_warn "OpenBao writer SA lookup remained unavailable after 3 attempts"
        return 1
        ;;
      *)
        log_warn "OpenBao writer SA lookup failed permanently; refusing to claim the SA is absent"
        return 1
        ;;
    esac
  done

  tok=""
  max_attempts=1
  for attempt in 1 2 3; do
    if ! jwt=$(timeout 10 kubectl create token openbao-operator -n default 2>&1); then
      login_reason="service_account_token_mint"
      max_attempts=3
    else
      set +e
      login_out=$(timeout 10 kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \
        bao write -field=token auth/kubernetes/login \
        "role=${DEPLOY_ENVIRONMENT}-writer" "jwt=${jwt}" 2>&1)
      login_rc=$?
      set -e
      if [[ $login_rc -eq 0 ]]; then
        tok="$login_out"
        break
      fi

      # Match the bounded policy used by every node-substrate login: server/control-plane
      # transients get three attempts; a 403 gets exactly one fresh-JWT recheck. Unknown
      # failures remain permanent. Never print login_out: a successful response is a token.
      # GNU timeout exits 124 and may emit no text at all. The live candidate
      # proof for bug.5462 hit exactly that shape: the 10-second kubectl/bao
      # login deadline was misclassified as a permanent auth failure because
      # there was no stderr for the regex to inspect. Exit status is the
      # authoritative timeout signal; retry it like the textual server
      # transient spellings, still bounded to three fresh-JWT attempts.
      login_reason="$(classify_openbao_writer_login_failure "$login_rc" "$login_out")"
      case "$login_reason" in
        server_transient) max_attempts=3 ;;
        permission_denied_recheck) max_attempts=2 ;;
        *)
          log_warn "OpenBao writer login failed permanently for ${DEPLOY_ENVIRONMENT}-writer"
          return 1
          ;;
      esac
    fi

    if [[ $attempt -ge $max_attempts ]]; then
      log_warn "OpenBao writer login exhausted ${max_attempts} attempt(s) for ${DEPLOY_ENVIRONMENT}-writer (${login_reason})"
      return 1
    fi
    sleep_seconds=$((attempt * 5 + RANDOM % 5))
    log_warn "OpenBao writer login ${login_reason} (attempt ${attempt}/${max_attempts}); retrying with a fresh JWT in ${sleep_seconds}s"
    sleep "$sleep_seconds"
  done
  if [[ -z "$tok" ]]; then
    log_warn "OpenBao writer login returned an empty token for ${DEPLOY_ENVIRONMENT}-writer"
    return 1
  fi

  # bug.5068 (prod outage 2026-07-02): `cogni/<env>/operator` is a SHARED bucket
  # holding ~35 keys (DATABASE_URL, AUTH_SECRET, LITELLM_MASTER_KEY, …). `bao kv put`
  # REPLACES the whole bucket, so a `put` here must only ever run when the bucket is
  # genuinely absent. The old guard (`kv metadata get` fails → put) conflated a
  # TRANSIENT failure (docker network recreation, exec flake) with "absent" and
  # clobbered all 35 keys → ESO synced the emptied bucket → operator crashloop →
  # ~1h prod 502.
  #
  # Fix: `patch` FIRST (merges siblings; the writer role has patch on this path).
  # Only fall back to a destructive `put` on a POSITIVE "does not exist" signal in
  # patch's OWN output. Any other (transient) failure returns 1 without touching the
  # bucket — the caller hard-fails and deploy-infra retries next run against an
  # intact bucket. `put` is now unreachable except on proven absence.
  path="cogni/${DEPLOY_ENVIRONMENT}/operator"
  set +e
  patch_out=$(timeout 20 kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN="${tok}" \
    bao kv patch "$path" \
      "OPENFGA_STORE_ID=${OPENFGA_STORE_ID}" \
      "OPENFGA_AUTHORIZATION_MODEL_ID=${OPENFGA_AUTHORIZATION_MODEL_ID}" \
      "OPENFGA_AUTHORIZATION_MODEL_HASH=${OPENFGA_AUTHORIZATION_MODEL_HASH}" 2>&1)
  patch_rc=$?
  set -e
  if [[ $patch_rc -eq 0 ]]; then
    return 0
  fi

  # Positive "the secret does not exist" is the ONLY case where a `put` (create) is
  # safe: there are no sibling keys to clobber. Match the phrasings OpenBao/Vault
  # `kv patch` emits for a missing path. Anything else is treated as transient.
  # A kv patch on a never-written KV v2 path returns `Code: 404` with an EMPTY raw
  # message (no "not found" text) — unambiguous absence on a FRESH node/env, so put
  # cannot clobber siblings (mirrors provision seed_kv fix a54f24809b).
  if printf '%s' "$patch_out" | grep -qiE 'no value found|does not exist|not found|code: 404'; then
    log_warn "operator bucket ${path} absent — creating it with a fresh put"
    timeout 20 kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN="${tok}" \
      bao kv put "$path" \
        "OPENFGA_STORE_ID=${OPENFGA_STORE_ID}" \
        "OPENFGA_AUTHORIZATION_MODEL_ID=${OPENFGA_AUTHORIZATION_MODEL_ID}" \
        "OPENFGA_AUTHORIZATION_MODEL_HASH=${OPENFGA_AUTHORIZATION_MODEL_HASH}" >/dev/null || return 1
    return 0
  fi

  # Transient/unknown failure — NEVER `put` (would wipe ~35 sibling keys). Fail
  # closed; deploy-infra retries on the next run against an intact bucket.
  log_warn "bao kv patch on ${path} failed (rc=${patch_rc}) without a positive 'absent' signal; refusing to put (would clobber siblings): ${patch_out}"
  return 1
}

refresh_operator_openfga_secret() {
  local k8s_ns="cogni-${DEPLOY_ENVIRONMENT}" es_name="" candidate synced_store_id synced_model_id
  for candidate in operator-env-secrets env-secrets; do
    if kubectl -n "$k8s_ns" get externalsecret "$candidate" >/dev/null 2>&1; then
      es_name="$candidate"
      break
    fi
  done
  if [[ -z "$es_name" ]]; then
    # Fresh-env benign case: no operator app has synced yet, so its ExternalSecret
    # does not exist. The runtime IDs are already durably in OpenBao (patch above,
    # the SSOT) — ESO will pull them into the secret on the operator's FIRST rollout.
    # This force-refresh is only an ACCELERATION for an already-running operator, so
    # its absence is not a failure. Returning 1 here under set -e wrongly hard-fails
    # the whole fresh-env provision (same fresh-env coupling class as the infra-DB gap).
    log_warn "No operator ExternalSecret in ${k8s_ns} yet (fresh env); OpenFGA runtime IDs are in OpenBao — ESO will sync them on the operator's first rollout"
    return 0
  fi

  kubectl -n "$k8s_ns" annotate externalsecret "$es_name" \
    force-sync="$(date +%s)" --overwrite >/dev/null 2>&1 || return 1
  log_info "Requested ESO refresh for ${es_name}"
  kubectl -n "$k8s_ns" wait --for=condition=Ready "externalsecret/${es_name}" --timeout=120s >/dev/null 2>&1 || return 1

  for _ in $(seq 1 30); do
    synced_store_id=$(kubectl -n "$k8s_ns" get secret operator-env-secrets \
      -o jsonpath='{.data.OPENFGA_STORE_ID}' 2>/dev/null | base64 -d 2>/dev/null || true)
    synced_model_id=$(kubectl -n "$k8s_ns" get secret operator-env-secrets \
      -o jsonpath='{.data.OPENFGA_AUTHORIZATION_MODEL_ID}' 2>/dev/null | base64 -d 2>/dev/null || true)
    if [[ "$synced_store_id" == "$OPENFGA_STORE_ID" && "$synced_model_id" == "$OPENFGA_AUTHORIZATION_MODEL_ID" ]]; then
      log_info "operator-env-secrets contains current OpenFGA runtime IDs"
      return 0
    fi
    sleep 2
  done

  log_error "operator-env-secrets did not sync current OpenFGA runtime IDs"
  return 1
}

if patch_operator_openfga_config; then
  log_info "OpenBao operator path patched with OpenFGA runtime IDs"
  # Best-effort acceleration ONLY. patch_operator_openfga_config above already wrote
  # the runtime IDs to OpenBao (the SSOT, hard-gated). The ESO force-refresh just pulls
  # them into the operator Secret sooner; ESO syncs them on its normal cycle regardless.
  # On a fresh/rebuilding env the operator ExternalSecret may be absent OR present-but-
  # not-yet-Ready (ESO/app still converging when deploy-infra runs in Phase 5f) — neither
  # is a deploy failure. Never let this acceleration fail the whole provision (it did:
  # the 120s wait timed out → return 1 → FATAL). Operator secret/pod health is proven by
  # the readyz/promote lane, not by force-refresh convergence here.
  refresh_operator_openfga_secret || log_warn "operator ExternalSecret force-refresh did not converge (absent or not-Ready yet); IDs are in OpenBao and ESO will sync them on its normal cycle — non-fatal"
else
  log_error "OpenFGA store/model exist, but operator OpenBao config was not patched"
  exit 1
fi

# RESTART_WHAT_ACTUALLY_CHANGED: `up -d` does NOT recreate a container when only the
# CONTENT of a bind-mounted config changes — compose compares the service SPEC, so an
# unchanged spec means no recreate. Every Alloy service therefore needs its own content
# hash and its own restart.
#
# This gate used to hash one file (alloy-config.metrics.alloy) and restart one service
# (alloy), while the runtime compose defines TWO: `alloy` consumes the metrics config and
# `alloy-k8s-events` consumes alloy-config.k8s-events.alloy. An edit to the k8s-events
# config was never hashed and its container never restarted, so the change shipped,
# deployed green, and stayed inert — #2648's namespace allowlist sat on the VM unloaded
# while {service="kubernetes-events",namespace="default"} read a flat zero, which looks
# exactly like "no events occurred" (bug.5420).
#
# alloy-config.alloy is deliberately absent: it is logs-only for local dev and is mounted
# by no runtime service (see infra/compose/runtime/configs/AGENTS.md).
restart_alloy_service_if_config_changed() {
  local config="$1" service="$2" hash_path="$3"
  if [[ ! -f "$config" ]]; then
    log_warn "Alloy config missing at $config, skipping restart check for $service"
    return 0
  fi
  mkdir -p "$(dirname "$hash_path")"
  local new_hash old_hash
  new_hash="$(hash_file "$config")"
  old_hash="$(cat "$hash_path" 2>/dev/null || echo "none")"
  if [[ "$new_hash" != "$old_hash" && "$new_hash" != "no-hash-tool" ]]; then
    log_info "Alloy config $(basename "$config") changed (hash: ${new_hash:0:12}...), restarting ${service}..."
    $RUNTIME_COMPOSE restart "$service"
    echo "$new_hash" > "$hash_path"
    log_info "${service} restarted with new config"
  else
    log_info "Alloy config $(basename "$config") unchanged (hash: ${new_hash:0:12}...), ${service} not restarted"
  fi
}

# The metrics config keeps its original hash path, so this change does not manufacture a
# restart of a healthy collector on first run.
restart_alloy_service_if_config_changed \
  /opt/cogni-template-runtime/configs/alloy-config.metrics.alloy \
  alloy \
  /var/lib/cogni/alloy-config.sha256
restart_alloy_service_if_config_changed \
  /opt/cogni-template-runtime/configs/alloy-config.k8s-events.alloy \
  alloy-k8s-events \
  /var/lib/cogni/alloy-config.k8s-events.sha256

log_info "[$(date -u +%H:%M:%S)] Installing db-backup systemd timer..."
# Pause future triggers while replacing the unit, but never kill an in-progress
# backup. The previous implementation stopped/remade the Compose container on
# every reconcile and then launched another full dump inline. On production's
# 17GB shared database that backup coincided exactly with the backend SIGKILL and
# crash-recovery outage (bug.5252). One systemd service is now the sole executor.
systemctl stop cogni-db-backup.timer 2>/dev/null || true
backup_was_running=0
if systemctl is-active --quiet cogni-db-backup.service; then
  backup_was_running=1
  log_info "db-backup service already active; preserving the in-progress backup"
else
  $RUNTIME_COMPOSE --profile backup rm -f db-backup 2>/dev/null || true
fi
DOCKER_BIN=$(command -v docker)
BACKUP_INTERVAL_SECONDS="${DB_BACKUP_INTERVAL_SECONDS:-86400}"
cat >/etc/systemd/system/cogni-db-backup.service <<SYSTEMD_SERVICE_EOF
[Unit]
Description=Cogni runtime Postgres logical backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/cogni-template-runtime
ExecStart=${DOCKER_BIN} compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml --profile backup up --force-recreate --no-deps --abort-on-container-exit --exit-code-from db-backup db-backup
ExecStartPost=-${DOCKER_BIN} compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml --profile backup rm -f db-backup
TimeoutStartSec=2h
SYSTEMD_SERVICE_EOF

cat >/etc/systemd/system/cogni-db-backup.timer <<SYSTEMD_TIMER_EOF
[Unit]
Description=Run Cogni runtime Postgres logical backup

[Timer]
# Relative to timer activation/completion, not machine boot. Reinstalling this
# timer on a long-running VM must not turn an ordinary infra reconcile into an
# immediate full-database read, and a slow backup must never compress the next
# interval or overlap itself.
OnActiveSec=${BACKUP_INTERVAL_SECONDS}s
OnUnitInactiveSec=${BACKUP_INTERVAL_SECONDS}s
AccuracySec=5min
RandomizedDelaySec=5min
Unit=cogni-db-backup.service

[Install]
WantedBy=timers.target
SYSTEMD_TIMER_EOF

systemctl daemon-reload
systemctl enable cogni-db-backup.timer
systemctl reset-failed cogni-db-backup.service 2>/dev/null || true
log_info "db-backup timer installed with interval ${BACKUP_INTERVAL_SECONDS}s"

# A full dump is behavioral validation, so run it only in candidate. Preview and
# production reconciles install the exact same unit/config but do not exercise a
# 17GB data-plane workload as a side effect of control-plane convergence.
backup_validated=1
if [[ "$DEPLOY_ENVIRONMENT" == candidate-* ]]; then
  log_info "Running candidate db-backup validation through the singleton systemd service..."
  if [[ "$backup_was_running" == 1 ]]; then
    log_warn "db-backup already running; skipped duplicate candidate validation"
    backup_validated=0
  elif systemctl start cogni-db-backup.service; then
    $RUNTIME_COMPOSE --profile backup run --rm --no-deps --entrypoint bash db-backup -lc '
    set -euo pipefail
    for cluster in app temporal; do
      latest=$(find "/backups/${cluster}" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
      test -n "$latest"
      test -s "${latest}/MANIFEST.sha256"
      echo "db-backup manifest verified: ${latest}/MANIFEST.sha256"
    done
    ' || { log_warn "db-backup manifest verification failed (non-fatal)"; backup_validated=0; }
  else
    log_warn "candidate db-backup validation failed — NON-FATAL; the scheduled timer will retry"
    backup_validated=0
  fi
else
  log_info "Skipping inline full backup in ${DEPLOY_ENVIRONMENT}; scheduled singleton owns production backups"
fi
systemctl start cogni-db-backup.timer
# Only prepare the cell timer when the sole-writer kit has been projected by
# read-only reconciliation. First enable waits for capacity and restore proof.
if compgen -G '/opt/cogni-template-runtime/database-cell-backup/*/targets.tsv' >/dev/null; then
  bash /opt/cogni-template-runtime/db-backup/install-cell-timer.sh
fi
if [[ "$backup_validated" == 1 ]]; then
  emit_deployment_event "infra_deployment.db_backup_scheduled" "success" "db-backup timer installed; candidate validation completed when applicable"
else
  emit_deployment_event "infra_deployment.db_backup_scheduled" "warning" "db-backup timer installed; candidate validation did not fully verify (non-fatal — timer retries)"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6.6b: Checksum-gated restart for LiteLLM config changes
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HASH_DIR="/var/lib/cogni"
LITELLM_CONFIG="/opt/cogni-template-runtime/configs/litellm.config.yaml"
LITELLM_HASH_FILE="$HASH_DIR/litellm-config.sha256"

if [[ ! -f "$LITELLM_CONFIG" ]]; then
  log_warn "LiteLLM config missing at $LITELLM_CONFIG, skipping restart check"
else
  mkdir -p "$HASH_DIR"
  NEW_HASH=$(hash_file "$LITELLM_CONFIG")
  OLD_HASH=$(cat "$LITELLM_HASH_FILE" 2>/dev/null || echo "none")

  if [[ "$NEW_HASH" != "$OLD_HASH" && "$NEW_HASH" != "no-hash-tool" ]]; then
    log_info "LiteLLM config changed (hash: ${NEW_HASH:0:12}...), restarting container..."
    emit_deployment_event "infra_deployment.litellm_restart" "in_progress" "Restarting LiteLLM due to config change"
    $RUNTIME_COMPOSE restart litellm
    echo "$NEW_HASH" > "$LITELLM_HASH_FILE"
    log_info "LiteLLM restarted with new config"
    emit_deployment_event "infra_deployment.litellm_restart_complete" "success" "LiteLLM restarted successfully"
  else
    log_info "LiteLLM config unchanged (hash: ${NEW_HASH:0:12}...), no restart needed"
  fi
fi

# Step 6.6d (alloy checksum-restart) lives near the litellm block above; main
# already added it at 88e67cdd4 (bug.5169) so this branch's earlier copy is dropped.

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6.7: Ensure Temporal namespace exists (idempotent)
# App pods need cogni-${env} namespace registered in Temporal before /readyz passes.
# Same script used by provision-test-vm.sh — one shared primitive.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEMPORAL_NAMESPACE="cogni-${DEPLOY_ENVIRONMENT}" \
TEMPORAL_CONTAINER="cogni-runtime-temporal-1" \
TEMPORAL_TIMEOUT=60 \
  bash /tmp/ensure-temporal-namespace.sh

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6.8: Dependency reachability probes
# Verify Compose services are reachable from k8s pods before restarting them.
# These use the same EndpointSlice bridges the app pods will use.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if command -v kubectl &>/dev/null; then
  K8S_NS="cogni-${DEPLOY_ENVIRONMENT}"
  log_info "[$(date -u +%H:%M:%S)] Probing dependency reachability from k8s..."

  probe_dependency() {
    local name="$1" host="$2" port="$3"
    local pod_name="probe-${name}-$(date +%s)"
    kubectl -n "${K8S_NS}" delete pod "$pod_name" --ignore-not-found 2>/dev/null || true
    if kubectl -n "${K8S_NS}" run --rm -i --restart=Never \
      --image=busybox:1.36 "$pod_name" \
      --timeout=30s -- nc -zw10 "$host" "$port" 2>/dev/null; then
      log_info "  ✅ ${name} reachable at ${host}:${port}"
    else
      log_warn "  ⚠️  ${name} not reachable at ${host}:${port} from k8s (may recover after sync)"
    fi
  }

  probe_dependency "temporal" "temporal" "7233"
  probe_dependency "litellm" "$(hostname -I | awk '{print $1}')" "4000"
  probe_dependency "redis" "$(hostname -I | awk '{print $1}')" "6379"
fi

else
  log_info "K8s-secrets-only mode: skipping Compose infra reconcile"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 7: Create/update k8s secrets + rolling restart (bridge — task.0284 replaces)
# k3s is on the same VM; kubectl is available. deploy-infra has ALL secrets
# from GitHub Environment — unlike provision which only has agent-generated ones.
# Uses --from-env-file for cleaner secret definitions.
# NOTE: This runs AFTER compose infra is up (Step 6.6) and dependency
# reachability is confirmed (Step 6.8). Long-term, secrets move to Git/Argo.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if command -v kubectl &>/dev/null; then
  log_info "[$(date -u +%H:%M:%S)] Creating/updating k8s secrets..."
  emit_deployment_event "infra_deployment.k8s_secrets_started" "in_progress" "Creating k8s secrets"

  K8S_NS="cogni-${DEPLOY_ENVIRONMENT}"
  kubectl create namespace "${K8S_NS}" 2>/dev/null || true
  HOST_IP=$(hostname -I | awk '{print $1}')
  log_info "  k8s namespace: ${K8S_NS}, host IP: ${HOST_IP}"

  # ── Per-node secrets (catalog-driven: every type:node in NODE_APP_TARGETS) ──
  # bug.5086 — node list comes from infra/catalog (CATALOG_IS_SSOT), threaded in
  # from the local context, so a new node (e.g. canary) auto-provisions its
  # secret. poly is absent (own VM, not in catalog); scheduler-worker is a
  # service (own secret below). Hyphenated names map to underscored DB names.
  #   node="node-template" → DB="cogni_node_template" / "knowledge_node_template".
  # Defense-in-depth: the local context already asserts non-empty before
  # threading; refuse here too so a future threading regression can never
  # silently create ZERO node-app-secrets and starve every node.
  if [ -z "${NODE_APP_TARGETS}" ]; then
    echo "[FATAL] NODE_APP_TARGETS empty — refusing to (re)create node-app-secrets" >&2
    exit 1
  fi
  for node in ${NODE_APP_TARGETS}; do
    db_node="${node//-/_}"
    # Doltgres URL points to this node's own DB (knowledge_<node>).
    # Poly reads DOLTGRES_URL_POLY in its Zod schema; operator / resy /
    # node-template read generic DOLTGRES_URL.
    # Ships as `postgres` (superuser) because Doltgres 0.56 RBAC is non-functional —
    # GRANTs report success but even `SELECT current_user` is denied for the
    # knowledge_writer role, making the drizzle migrator and app unusable as a
    # non-superuser. See task.0311 follow-up — revisit when Doltgres implements
    # GRANT properly (tracking: dolthub/doltgresql#XXXX).
    DOLTGRES_URL_NODE="postgresql://postgres:${DOLTGRES_PASSWORD}@${HOST_IP}:5435/knowledge_${db_node}?sslmode=disable"
    if [ "$node" = "poly" ]; then
      DOLTGRES_ENV_LINE="DOLTGRES_URL_POLY=${DOLTGRES_URL_NODE}"
    else
      DOLTGRES_ENV_LINE="DOLTGRES_URL=${DOLTGRES_URL_NODE}"
    fi
    NODE_DATABASE_URL="$(openbao_get_field "$node" DATABASE_URL)"
    NODE_DATABASE_SERVICE_URL="$(openbao_get_field "$node" DATABASE_SERVICE_URL)"
    if [[ -z "$NODE_DATABASE_URL" || -z "$NODE_DATABASE_SERVICE_URL" ]]; then
      log_warn "Skipped ${node}-node-app-secrets: canonical OpenBao database URLs are absent"
      continue
    fi
    SECRET_FILE=$(mktemp)
    cat > "$SECRET_FILE" <<SECEOF
DATABASE_URL=${NODE_DATABASE_URL}
DATABASE_SERVICE_URL=${NODE_DATABASE_SERVICE_URL}
${DOLTGRES_ENV_LINE}
AUTH_SECRET=${AUTH_SECRET}
LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
EVM_RPC_URL=${EVM_RPC_URL:-}
POLYGON_RPC_URL=${POLYGON_RPC_URL:-}
POSTHOG_API_KEY=${POSTHOG_API_KEY:-}
POSTHOG_HOST=${POSTHOG_HOST:-}
TAVILY_API_KEY=${TAVILY_API_KEY:-}
SCHEDULER_API_TOKEN=${SCHEDULER_API_TOKEN:-}
BILLING_INGEST_TOKEN=${BILLING_INGEST_TOKEN:-}
INTERNAL_OPS_TOKEN=${INTERNAL_OPS_TOKEN:-}
METRICS_TOKEN=${METRICS_TOKEN:-}
CONNECTIONS_ENCRYPTION_KEY=${CONNECTIONS_ENCRYPTION_KEY:-}
GH_OAUTH_CLIENT_ID=${GH_OAUTH_CLIENT_ID:-}
GH_OAUTH_CLIENT_SECRET=${GH_OAUTH_CLIENT_SECRET:-}
DISCORD_OAUTH_CLIENT_ID=${DISCORD_OAUTH_CLIENT_ID:-}
DISCORD_OAUTH_CLIENT_SECRET=${DISCORD_OAUTH_CLIENT_SECRET:-}
GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID:-}
GOOGLE_OAUTH_CLIENT_SECRET=${GOOGLE_OAUTH_CLIENT_SECRET:-}
DOLTHUB_OWNER=${DOLTHUB_OWNER:-}
DOLT_CREDS_JWK=${DOLT_CREDS_JWK:-}
DOLT_CREDS_KEYID=${DOLT_CREDS_KEYID:-}
DOLTHUB_API_TOKEN=${DOLTHUB_API_TOKEN:-}
DOLTHUB_OAUTH_CLIENT_ID=${DOLTHUB_OAUTH_CLIENT_ID:-}
DOLTHUB_OAUTH_CLIENT_SECRET=${DOLTHUB_OAUTH_CLIENT_SECRET:-}
PRIVY_APP_ID=${PRIVY_APP_ID:-}
PRIVY_APP_SECRET=${PRIVY_APP_SECRET:-}
PRIVY_SIGNING_KEY=${PRIVY_SIGNING_KEY:-}
# task.0318 Phase B — per-user trading wallets (SEPARATE_PRIVY_APP invariant).
# Single-operator POLY_PROTO_* / POLY_CLOB_* prototype secrets were purged in
# Stage 4; user wallets live in a dedicated Privy app + CLOB L2 creds are
# derived server-side at provision time.
PRIVY_USER_WALLETS_APP_ID=${PRIVY_USER_WALLETS_APP_ID:-}
PRIVY_USER_WALLETS_APP_SECRET=${PRIVY_USER_WALLETS_APP_SECRET:-}
PRIVY_USER_WALLETS_SIGNING_KEY=${PRIVY_USER_WALLETS_SIGNING_KEY:-}
POLY_WALLET_AEAD_KEY_HEX=${POLY_WALLET_AEAD_KEY_HEX:-}
POLY_WALLET_AEAD_KEY_ID=${POLY_WALLET_AEAD_KEY_ID:-}
POLY_CLOB_GEO_BLOCK_TOKEN=${POLY_CLOB_GEO_BLOCK_TOKEN:-}
GH_WEBHOOK_SECRET=${GH_WEBHOOK_SECRET:-}
GH_REVIEW_APP_ID=${GH_REVIEW_APP_ID:-}
GH_REVIEW_APP_PRIVATE_KEY_BASE64=${GH_REVIEW_APP_PRIVATE_KEY_BASE64:-}
NODE_MINT_OWNER=${NODE_MINT_OWNER:-}
NODE_TEMPLATE_OWNER=${NODE_TEMPLATE_OWNER:-}
GH_REPOS=${GH_REPOS:-}
LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY:-}
LANGFUSE_SECRET_KEY=${LANGFUSE_SECRET_KEY:-}
LANGFUSE_BASE_URL=${LANGFUSE_BASE_URL:-}
SECEOF
    # bug.5086 — fail-soft per node: a broken/new node can't abort the run and
    # leave operator/resy/node-template without their secrets.
    if kubectl -n "${K8S_NS}" create secret generic "${node}-node-app-secrets" \
      --from-env-file="$SECRET_FILE" --dry-run=client -o yaml | kubectl apply -f -; then
      log_info "  Applied ${node}-node-app-secrets"
    else
      log_warn "  Skipped ${node}-node-app-secrets (apply failed; deploy continues)"
    fi
    rm -f "$SECRET_FILE"
  done

  # ── Scheduler-worker secret ────────────────────────────────────────────────
  # Non-secret routing (COGNI_NODE_ENDPOINTS) belongs in the overlay ConfigMap —
  # see docs/spec/services-architecture.md → "Configuration source of truth".
  # bug.5000/bug.5012: GH_REVIEW_APP_* + GH_WEBHOOK_SECRET are NOT injected —
  # the worker HTTP-delegates GitHub I/O to the operator and holds no GitHub
  # credential. (Parity: SCHEDULER_WORKER_KEYS in scripts/setup/lib/reconcile-secrets.sh.)
  SECRET_FILE=$(mktemp)
  cat > "$SECRET_FILE" <<SECEOF
DATABASE_URL=${OPERATOR_DATABASE_SERVICE_URL:?operator OpenBao service URL required}
SCHEDULER_API_TOKEN=${SCHEDULER_API_TOKEN:-}
INTERNAL_OPS_TOKEN=${INTERNAL_OPS_TOKEN:-}
COGNI_NODE_DBS=${COGNI_NODE_DBS:-}
SECEOF
  kubectl -n "${K8S_NS}" create secret generic scheduler-worker-secrets \
    --from-env-file="$SECRET_FILE" --dry-run=client -o yaml | kubectl apply -f -
  rm -f "$SECRET_FILE"
  log_info "  Applied scheduler-worker-secrets"

  log_info "[$(date -u +%H:%M:%S)] k8s secrets applied"
  emit_deployment_event "infra_deployment.k8s_secrets_complete" "success" "k8s secrets applied"

  # ── Sync GitHub App webhook secret (single App plane — bug.5012) ────────────
  # ONE GitHub App signs all webhooks for ONE receiver: the operator pod, which
  # verifies with cogni/<env>/operator/GH_WEBHOOK_SECRET (ESO). The App PATCH
  # must push THAT copy — never the ambient env value, which the flat .env
  # reconcile can point at another service's stale copy. Empty operator read in
  # SSoT mode fails closed — a wrong-copy sync 401s every webhook silently.
  # Fresh/plain-Secret bootstrap falls back to the workflow env value. Runs ON
  # THE VM — REPO_ROOT is runner-only and UNBOUND here under `set -u`; invoke
  # the scp'd /tmp copy, never $REPO_ROOT (regression #1482).
  APP_SYNC_WEBHOOK_SECRET="$(openbao_get_field operator GH_WEBHOOK_SECRET)" \
    || log_fatal "Canonical GH_WEBHOOK_SECRET unavailable from OpenBao; refusing webhook fallback after a failed read"
  if [[ -z "$APP_SYNC_WEBHOOK_SECRET" && "${OPENBAO_RUNTIME_SSOT:-false}" == "true" ]]; then
    log_error "  GH_WEBHOOK_SECRET absent from OpenBao cogni/${DEPLOY_ENVIRONMENT}/operator — refusing to sync a non-operator copy to the App"
    exit 1
  fi
  if GH_REVIEW_APP_ID="${GH_REVIEW_APP_ID:-}" \
     GH_REVIEW_APP_PRIVATE_KEY_BASE64="${GH_REVIEW_APP_PRIVATE_KEY_BASE64:-}" \
     GH_WEBHOOK_SECRET="${APP_SYNC_WEBHOOK_SECRET:-${GH_WEBHOOK_SECRET:-}}" \
     EXPECTED_WEBHOOK_HOST="${DOMAIN:-}" \
     bash /tmp/sync-app-webhook-secret.sh; then
    log_info "  GitHub App webhook secret synced (operator OpenBao ↔ App)"
  elif [[ "${OPENBAO_RUNTIME_SSOT:-false}" == "true" ]]; then
    log_error "  GitHub App webhook secret sync FAILED in OpenBao SSoT mode — refusing a silent webhook mismatch"
    exit 1
  else
    log_warn "  GitHub App webhook secret sync FAILED — webhooks will fail verification until resolved"
  fi

  # ── Rolling restart — pods must restart to pick up changed secrets ──────────
  # This happens AFTER compose infra is up (Step 6.6) and dependency reachability
  # is confirmed (Step 6.8), so pods boot into a healthy environment.
  #
  # Per task.0280: node-apps MUST roll before scheduler-worker. The worker
  # delegates graph_runs/grants persistence to each node's internal API; a
  # post-deploy worker hitting a pre-deploy node app would 404 on the new
  # /api/internal/graph-runs and /api/internal/grants/*/validate routes.
  # Rolling the node-apps first, waiting, then rolling the worker guarantees
  # the new endpoints exist before the worker can call them.
  # bug.5086 — catalog-driven node-app set (CATALOG_IS_SSOT); restart args built
  # from NODE_APP_TARGETS so a new node rolls without editing this list.
  NODE_APP_DEPLOYMENTS=""
  for node in ${NODE_APP_TARGETS}; do
    NODE_APP_DEPLOYMENTS="${NODE_APP_DEPLOYMENTS} deployment/${node}-node-app"
  done
  # shellcheck disable=SC2086
  kubectl -n "${K8S_NS}" rollout restart ${NODE_APP_DEPLOYMENTS} 2>/dev/null || true
  log_info "[$(date -u +%H:%M:%S)] Node-app pods restarting (scheduler-worker waits)..."

  int_or_zero() {
    case "${1:-}" in
      ""|*[!0-9]*) printf '0\n' ;;
      *) printf '%s\n' "$1" ;;
    esac
  }

  deployment_updated_available() {
    local deployment="$1"
    local spec updated available observed generation revision new_available deployment_name
    deployment_name="${deployment#deployment/}"
    spec=$(int_or_zero "$(kubectl -n "${K8S_NS}" get "$deployment" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)")
    updated=$(int_or_zero "$(kubectl -n "${K8S_NS}" get "$deployment" -o jsonpath='{.status.updatedReplicas}' 2>/dev/null || true)")
    available=$(int_or_zero "$(kubectl -n "${K8S_NS}" get "$deployment" -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true)")
    observed=$(int_or_zero "$(kubectl -n "${K8S_NS}" get "$deployment" -o jsonpath='{.status.observedGeneration}' 2>/dev/null || true)")
    generation=$(int_or_zero "$(kubectl -n "${K8S_NS}" get "$deployment" -o jsonpath='{.metadata.generation}' 2>/dev/null || true)")
    revision="$(kubectl -n "${K8S_NS}" get "$deployment" -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}' 2>/dev/null || true)"
    new_available=$(int_or_zero "$(kubectl -n "${K8S_NS}" get rs -o json 2>/dev/null | jq -r \
      --arg deployment "${deployment_name}" \
      --arg revision "${revision:-}" \
      '[.items[]
        | select(any(.metadata.ownerReferences[]?; .kind == "Deployment" and .name == $deployment))
        | select(.metadata.annotations["deployment.kubernetes.io/revision"] == $revision)
        | (.status.availableReplicas // 0)
      ] | max // 0' 2>/dev/null || true)")
    [[ "$spec" -eq 0 ]] && spec=1
    [[ "$observed" -ge "$generation" && "$updated" -ge "$spec" && "$new_available" -ge "$spec" ]]
  }

  wait_rollout_or_updated_available() {
    local deployment="$1" timeout="$2"
    if kubectl -n "${K8S_NS}" rollout status "$deployment" --timeout="$timeout" 2>/dev/null; then
      return 0
    fi
    if deployment_updated_available "$deployment"; then
      log_warn "$deployment rollout status timed out, but updated replicas are available; continuing"
      return 0
    fi
    return 1
  }

  operator_openfga_process_env_ready() {
    local pod pods
    for _ in $(seq 1 60); do
      pods=$(kubectl -n "${K8S_NS}" get pods \
        --field-selector=status.phase=Running \
        -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null \
        | grep '^operator-node-app-' || true)
      while IFS= read -r pod; do
        [[ -n "$pod" ]] || continue
        if kubectl -n "${K8S_NS}" wait "pod/${pod}" --for=condition=Ready --timeout=5s >/dev/null 2>&1 \
          && kubectl -n "${K8S_NS}" exec "$pod" -c app -- /bin/sh -c \
            'test -n "${OPENFGA_API_URL:-}" && test -n "${OPENFGA_STORE_ID:-}" && test -n "${OPENFGA_AUTHORIZATION_MODEL_ID:-}"' 2>/dev/null; then
          return 0
        fi
      done <<< "$pods"
      sleep 2
    done
    return 1
  }

  operator_deployment_declares_openfga_config() {
    local api_url secret_refs
    api_url="$(kubectl -n "${K8S_NS}" get configmap operator-node-app-config \
      -o jsonpath='{.data.OPENFGA_API_URL}' 2>/dev/null || true)"
    secret_refs="$(kubectl -n "${K8S_NS}" get deployment operator-node-app \
      -o jsonpath='{range .spec.template.spec.containers[*].envFrom[*]}{.secretRef.name}{"\n"}{end}' 2>/dev/null || true)"
    [[ -n "$api_url" ]] && grep -qx 'operator-env-secrets' <<< "$secret_refs"
  }

  log_operator_openfga_env_diagnostics() {
    local secret_refs pod pods
    log_warn "operator OpenFGA process-env diagnostics follow (key presence only)"
    kubectl -n "${K8S_NS}" get configmap operator-node-app-config \
      -o jsonpath='operator-node-app-config.OPENFGA_API_URL={.data.OPENFGA_API_URL}{"\n"}' 2>/dev/null || true
    secret_refs="$(kubectl -n "${K8S_NS}" get deployment operator-node-app \
      -o jsonpath='{range .spec.template.spec.containers[*].envFrom[*]}{.secretRef.name}{"\n"}{end}' 2>/dev/null || true)"
    printf 'operator-node-app container secretRefs:\n%s\n' "${secret_refs:-<none>}"
    kubectl -n "${K8S_NS}" get pods -o wide | grep '^operator-node-app-' || true
    pods=$(kubectl -n "${K8S_NS}" get pods \
      --field-selector=status.phase=Running \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null \
      | grep '^operator-node-app-' || true)
    while IFS= read -r pod; do
      [[ -n "$pod" ]] || continue
      printf 'operator pod %s env key presence:\n' "$pod"
      kubectl -n "${K8S_NS}" exec "$pod" -c app -- /bin/sh -c '
        for key in OPENFGA_API_URL OPENFGA_STORE_ID OPENFGA_AUTHORIZATION_MODEL_ID; do
          eval "value=\${$key:-}"
          if [ -n "$value" ]; then
            printf "%s=present\n" "$key"
          else
            printf "%s=missing\n" "$key"
          fi
        done
      ' 2>/dev/null || true
    done <<< "$pods"
  }

  # ── Wait for node-app rollouts first ───────────────────────────────────────
  ROLLOUT_PIDS=""
  for node in ${NODE_APP_TARGETS}; do
    wait_rollout_or_updated_available "deployment/${node}-node-app" 300s &
    ROLLOUT_PIDS="$ROLLOUT_PIDS $!"
  done
  NODE_APP_ROLLOUT_FAILED=0
  for pid in $ROLLOUT_PIDS; do
    if ! wait "$pid"; then
      NODE_APP_ROLLOUT_FAILED=1
    fi
  done
  if [ $NODE_APP_ROLLOUT_FAILED -ne 0 ]; then
    log_warn "One or more node-app rollouts did not complete within 300s"
  fi
  log_info "[$(date -u +%H:%M:%S)] Node-apps ready — rolling scheduler-worker"

  # ── Roll scheduler-worker only after node-apps are ready ───────────────────
  # Fresh-env ordering: deploy-infra runs in provision-env-vm.sh Phase 5f, BEFORE
  # Phase 7 applies the ApplicationSets that create the Argo Apps → Deployments. So
  # on a fresh provision this Deployment legitimately does not exist yet. Tolerate
  # that (the AppSet sync + the deploy/flight verify lane own app-tier health); stay
  # fatal only when the Deployment EXISTS but fails to roll out (established-env
  # regression). Same benign-on-absent / fatal-on-real-failure shape as the OpenFGA
  # ExternalSecret refresh above.
  ROLLOUT_FAILED=0
  if ! kubectl -n "${K8S_NS}" get deployment/scheduler-worker >/dev/null 2>&1; then
    log_warn "scheduler-worker Deployment not present yet (fresh env; ApplicationSets apply in Phase 7, after this) — skipping rollout verification; the AppSet sync + deploy/flight lane own app-tier health"
  else
    kubectl -n "${K8S_NS}" rollout restart deployment/scheduler-worker 2>/dev/null || true
    if ! wait_rollout_or_updated_available deployment/scheduler-worker 300s; then
      log_warn "scheduler-worker rollout did not complete within 300s"
      ROLLOUT_FAILED=1
    fi
  fi
  if [[ " ${NODE_APP_TARGETS} " == *" operator "* ]]; then
    if ! operator_deployment_declares_openfga_config; then
      log_warn "operator deployment does not yet declare OpenFGA config; skipping process-env proof until the app flight applies the OpenFGA-aware overlay"
    elif operator_openfga_process_env_ready; then
      log_info "operator pod process env contains OpenFGA URL, store ID, and model ID"
    else
      # Non-fatal (same fresh-env class as the ExternalSecret refresh): on a fresh/
      # rebuilding env the operator pod env may not have the OpenFGA IDs YET because
      # ESO/the app are still converging when deploy-infra runs in Phase 5f. The IDs are
      # in OpenBao (SSOT); ESO syncs them; operator RBAC readiness is proven by the
      # readyz/promote lane, not by deploy-infra. Diagnostics only — do not abort.
      log_operator_openfga_env_diagnostics
      log_warn "operator pod process env not yet showing OpenFGA URL/store/model IDs (ESO still converging) — non-fatal; readyz/promote lane proves operator readiness"
    fi
  fi
  log_info "[$(date -u +%H:%M:%S)] All rollouts complete"
  if [ $ROLLOUT_FAILED -ne 0 ]; then
    exit 1
  fi
  emit_deployment_event "infra_deployment.rollouts_complete" "success" "All k8s deployments rolled out"
else
  log_warn "kubectl not found — skipping k8s secret creation (k3s may not be installed)"
fi

if [[ "${K8S_SECRETS_ONLY:-false}" == "true" ]]; then
  log_info "K8s-secrets-only mode complete"
  exit 0
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 7b: Argo CD Image Updater — secrets + controller reconcile (bug.0344)
#
# Idempotent upsert of the two imperative Secrets in the `argocd` namespace
# (`argocd-image-updater-ghcr`, `argocd-image-updater-git-creds`) and kustomize
# apply of the pinned v0.15.2 controller. Same `create --dry-run=client -o yaml
# | apply -f -` pattern as Step 7's per-node secrets — ksops is retired (task.0284).
#
# The Argo CD Image Updater kustomize tree was rsynced to
# /opt/cogni-template-argocd-updater/ by the caller. The full Argo CD tree
# (ApplicationSets etc.) is still reconciled by promote-and-deploy.yml /
# candidate-flight.yml via SCP + `kubectl apply -f`; this step is scoped to
# the image-updater subtree only — the bootstrap that bug.0344 owns.
#
# Gracefully skips when:
#   - argocd namespace is not present (Argo CD not yet installed — early boot),
#   - kustomize tree is not on the VM (caller didn't rsync — legacy caller path),
#   - ACTIONS_AUTOMATION_BOT_PAT is unset (legacy caller path during rollout).
# This invariant — "deploy-infra bootstraps the image updater so the carve-out
# stays in git, not in a runbook" — is bug.0344's
# ARGO_CD_IMAGE_UPDATER_BOOTSTRAP_IN_DEPLOY_INFRA.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if command -v kubectl &>/dev/null; then
  log_info "[$(date -u +%H:%M:%S)] Reconciling Argo CD Image Updater (bug.0344)..."

  if ! kubectl get namespace argocd &>/dev/null; then
    log_warn "argocd namespace not present — skipping image-updater bootstrap (Argo CD not yet installed on this VM)"
  elif [[ -z "${ACTIONS_AUTOMATION_BOT_PAT:-}" ]] || [[ -z "${GHCR_DEPLOY_TOKEN:-}" ]] || [[ -z "${GHCR_USERNAME:-}" ]]; then
    log_warn "image-updater bootstrap skipped: ACTIONS_AUTOMATION_BOT_PAT, GHCR_DEPLOY_TOKEN, and GHCR_USERNAME must all be set (legacy caller path)"
  else
    emit_deployment_event "infra_deployment.image_updater_started" "in_progress" "Reconciling image-updater secrets + controller"

    # GHCR credentials — consumed by registries.conf entry
    #   credentials: secret:argocd/argocd-image-updater-ghcr#token
    # in infra/k8s/argocd/image-updater/config-patch.yaml.
    kubectl -n argocd create secret generic argocd-image-updater-ghcr \
      --from-literal=token="${GHCR_USERNAME}:${GHCR_DEPLOY_TOKEN}" \
      --dry-run=client -o yaml | kubectl apply -f -

    # Git write-back credentials — consumed by
    #   write-back-method: git:secret:argocd/argocd-image-updater-git-creds
    # on preview + candidate-a ApplicationSets. Pusher is Cogni-1729 (admin +
    # enforce_admins: false carve-out on main); authorship is github-actions[bot]
    # via the ConfigMap git.user/git.email in config-patch.yaml.
    kubectl -n argocd create secret generic argocd-image-updater-git-creds \
      --from-literal=username="${GHCR_USERNAME}" \
      --from-literal=password="${ACTIONS_AUTOMATION_BOT_PAT}" \
      --dry-run=client -o yaml | kubectl apply -f -

    log_info "  argocd-image-updater-ghcr + argocd-image-updater-git-creds applied"

    if [[ -d /opt/cogni-template-argocd-updater ]]; then
      # `kubectl kustomize | apply` matches the one-shot pattern used to
      # bootstrap Argo CD itself in infra/k8s/argocd/kustomization.yaml —
      # resolves the https:// pin to the upstream v0.15.2 install manifest
      # and applies the config-patch overlay in one go.
      kubectl kustomize /opt/cogni-template-argocd-updater/ | kubectl apply -f -

      # Force controller reload so any rotated secret values are picked up
      # (the controller caches creds on startup per upstream v0.15.2 docs).
      kubectl -n argocd rollout restart deployment/argocd-image-updater 2>/dev/null || true
      if ! kubectl -n argocd rollout status deployment/argocd-image-updater --timeout=120s 2>/dev/null; then
        log_warn "argocd-image-updater rollout did not complete within 120s (not fatal — continues in background)"
      fi
      log_info "  argocd-image-updater controller reconciled (pinned v0.15.2)"
      emit_deployment_event "infra_deployment.image_updater_complete" "success" "Image updater bootstrap complete"
    else
      log_warn "/opt/cogni-template-argocd-updater missing on VM — skipping controller kustomize apply (secrets still upserted)"
    fi
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 8: Verify deployment
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "Waiting for containers to be ready..."
sleep 10

log_info "Checking container status..."
echo "=== Edge stack ==="
$EDGE_COMPOSE ps
echo "=== Runtime stack (infra) ==="
$RUNTIME_COMPOSE ps

# Write the non-secret recovery receipt LAST. It binds every installed input and
# local image that the custody-free recovery mode is allowed to use. A later
# partial deploy, hand edit, or image replacement invalidates the receipt before
# any Compose mutation can occur.
write_runtime_recovery_receipt() {
  local receipt=/var/lib/cogni/runtime-recovery-receipt.json
  local receipt_tmp="${receipt}.tmp.$$"
  local compose_sha litellm_config_sha recovery_service_config recovery_service_config_sha
  local service ref image_id core digest
  local images='{}'
  local resolved_config

  wait_receipt_service() {
    local service="$1" timeout_seconds="$2" elapsed=0 cid status
    while (( elapsed < timeout_seconds )); do
      cid="$($RUNTIME_COMPOSE ps -q "$service" 2>/dev/null || true)"
      status=""
      [[ -n "$cid" ]] && status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      [[ "$status" == "healthy" || "$status" == "running" ]] && return 0
      [[ "$status" == "exited" || "$status" == "dead" ]] && return 1
      sleep 2
      elapsed=$((elapsed + 2))
    done
    return 1
  }

  wait_receipt_service postgres 120 || log_fatal "recovery receipt: postgres is not healthy"
  wait_receipt_service litellm 180 || log_fatal "recovery receipt: LiteLLM is not healthy"
  wait_receipt_service autoheal 60 || log_fatal "recovery receipt: autoheal is not running"

  resolved_config="$($RUNTIME_COMPOSE config --format json)"
  compose_sha="$(sha256sum /opt/cogni-template-runtime/docker-compose.yml | awk '{print $1}')"
  litellm_config_sha="$(sha256sum /opt/cogni-template-runtime/configs/litellm.config.yaml | awk '{print $1}')"
  recovery_service_config="$(jq -cS \
    '{services: {postgres: .services.postgres, litellm: .services.litellm, autoheal: .services.autoheal}}' \
    <<<"$resolved_config")"
  jq -e '.services | [.postgres, .litellm, .autoheal] | all(. != null)' \
    <<<"$recovery_service_config" >/dev/null \
    || log_fatal "recovery receipt: recovery service declaration is incomplete"
  recovery_service_config_sha="$(printf '%s' "$recovery_service_config" | sha256sum | awk '{print $1}')"
  for service in postgres litellm autoheal; do
    ref="$(jq -r --arg service "$service" '.services[$service].image // empty' <<<"$resolved_config")"
    [[ -n "$ref" ]] || log_fatal "recovery receipt: ${service} image is unresolved"
    image_id="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null)" \
      || log_fatal "recovery receipt: ${service} image is not present locally"
    images="$(jq -c --arg service "$service" --arg ref "$ref" --arg id "$image_id" \
      '. + {($service): {ref: $ref, id: $id}}' <<<"$images")"
  done
  core="$(jq -cnS \
    --arg compose "$compose_sha" \
    --arg config "$litellm_config_sha" \
    --arg recoveryServiceConfig "$recovery_service_config_sha" \
    --arg sourceRef "${COGNI_REPO_REF:-${COMMIT_SHA:-unknown}}" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson images "$images" \
    '{version: 2, composeSha256: $compose, litellmConfigSha256: $config, recoveryServiceConfigSha256: $recoveryServiceConfig, images: $images, sourceRef: $sourceRef, completedAt: $completedAt}')"
  digest="$(printf '%s' "$core" | sha256sum | awk '{print $1}')"
  mkdir -p /var/lib/cogni
  jq -cS --arg digest "$digest" '. + {declarationDigest: $digest}' <<<"$core" > "$receipt_tmp"
  chmod 600 "$receipt_tmp"
  mv -f "$receipt_tmp" "$receipt"
  log_info "Runtime recovery receipt installed: ${digest}"
}

write_runtime_recovery_receipt
emit_deployment_event "infra_deployment.complete" "success" "Infrastructure deployment completed successfully"
log_info "Infrastructure deployment complete!"
EOF

# Make deployment script executable
chmod +x "$ARTIFACT_DIR/deploy-infra-remote.sh"

# Verify heredoc produced a valid file
if ! test -s "$ARTIFACT_DIR/deploy-infra-remote.sh"; then
  log_fatal "deploy-infra-remote.sh is empty or missing at $ARTIFACT_DIR/deploy-infra-remote.sh"
fi
LOCAL_SIZE=$(wc -c < "$ARTIFACT_DIR/deploy-infra-remote.sh")
LOCAL_SHA=$(sha256sum "$ARTIFACT_DIR/deploy-infra-remote.sh" | awk '{print $1}')
log_info "deploy-infra-remote.sh ready: ${LOCAL_SIZE} bytes, sha256=${LOCAL_SHA}"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Materialize catalog routes before rsync so running Caddy needs no fresh env.
bash "$REPO_ROOT/scripts/ci/render-caddyfile.sh" --domain "$DOMAIN" > "$REPO_ROOT/infra/compose/edge/configs/Caddyfile.tmpl"

# Dry-run exit (no SSH, no rsync, no compose up)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "DRY RUN — no remote actions will be executed"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Environment:        $ENVIRONMENT"
    echo "Ref:                $REF (SHA: $REF_SHA)"
    echo "Source worktree:    $SRC_WORKTREE"
    echo "Rsync targets:"
    echo "    $REPO_ROOT/infra/compose/edge/                → root@$VM_HOST:/opt/cogni-template-edge/"
    echo "    $REPO_ROOT/infra/compose/runtime/             → root@$VM_HOST:/opt/cogni-template-runtime/"
    echo "    $REPO_ROOT/infra/k8s/argocd/image-updater/    → root@$VM_HOST:/opt/cogni-template-argocd-updater/  (bug.0344)"
    echo "LiteLLM node routes: $LITELLM_NODE_ENDPOINTS"
    echo "Remote script:      $ARTIFACT_DIR/deploy-infra-remote.sh → /tmp/deploy-infra-remote.sh"
    echo "Infra services managed by remote script: postgres, litellm, temporal, alloy, caddy (plus db-backup timer and healthchecks)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_info "Dry run complete — exiting before any VM contact"
    exit 0
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Deploy bundles to VM via rsync
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "Deploying edge and runtime bundles to VM..."
ssh $SSH_OPTS root@"$VM_HOST" "mkdir -p /opt/cogni-template-edge /opt/cogni-template-runtime /opt/cogni-template-argocd-updater"

# Upload edge bundle (rarely changes - Caddy config only)
rsync -av -e "ssh $SSH_OPTS" \
  "$REPO_ROOT/infra/compose/edge/" \
  root@"$VM_HOST":/opt/cogni-template-edge/

# Upload runtime bundle (infra stack config)
rsync -av -e "ssh $SSH_OPTS" \
  "$REPO_ROOT/infra/compose/runtime/" \
  root@"$VM_HOST":/opt/cogni-template-runtime/

# Upload Argo CD Image Updater kustomize tree (bug.0344 — consumed by Step 7b
# in the remote script). Scoped to the image-updater subtree only; the rest
# of infra/k8s/argocd/ (ApplicationSets) is reconciled by promote-and-deploy.yml /
# candidate-flight.yml's own kubectl-apply step.
if [[ -d "$REPO_ROOT/infra/k8s/argocd/image-updater" ]]; then
  rsync -av --delete -e "ssh $SSH_OPTS" \
    "$REPO_ROOT/infra/k8s/argocd/image-updater/" \
    root@"$VM_HOST":/opt/cogni-template-argocd-updater/
fi

# Upload deployment script
scp $SSH_OPTS "$ARTIFACT_DIR/deploy-infra-remote.sh" root@"$VM_HOST":/tmp/deploy-infra-remote.sh

# Upload healthcheck and bootstrap scripts (called from deploy-infra-remote.sh)
scp $SSH_OPTS \
  "$REPO_ROOT/scripts/ci/ensure-temporal-namespace.sh" \
  "$REPO_ROOT/scripts/ci/bootstrap-openfga.sh" \
  "$REPO_ROOT/scripts/ci/reconcile-edge-caddy.remote.sh" \
  "$REPO_ROOT/scripts/secrets/sync-app-webhook-secret.sh" \
  root@"$VM_HOST":/tmp/

scp $SSH_OPTS \
  "$REPO_ROOT/infra/provision/cherry/harden-docker-public-ports.sh" \
  "root@${VM_HOST}:${REMOTE_HARDEN_SCRIPT}"
scp $SSH_OPTS \
  "$ARTIFACT_DIR/compute-egress-allowlist" \
  "root@${VM_HOST}:${REMOTE_COMPUTE_EGRESS_ALLOWLIST}"

scp $SSH_OPTS "$REPO_ROOT/infra/openfga/rbac-model.json" root@"$VM_HOST":/tmp/rbac-model.json

# Verify SCP landed correctly
REMOTE_CHECK=$(ssh $SSH_OPTS root@"$VM_HOST" "echo host=\$(hostname) date=\$(date -u +%Y-%m-%dT%H:%M:%SZ) && sha256sum /tmp/deploy-infra-remote.sh | awk '{print \$1}'" 2>&1) || {
  log_fatal "SSH to VM failed during SCP verify: $REMOTE_CHECK"
}
log_info "VM: ${REMOTE_CHECK%%$'\n'*}"
REMOTE_SHA=$(echo "$REMOTE_CHECK" | tail -1)
if [ -z "$REMOTE_SHA" ] || [ ${#REMOTE_SHA} -ne 64 ]; then
  log_fatal "/tmp/deploy-infra-remote.sh missing or unreadable on VM. SSH output: $REMOTE_CHECK"
fi
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  log_fatal "deploy-infra-remote.sh sha256 mismatch: local=${LOCAL_SHA} remote=${REMOTE_SHA}"
fi
log_info "deploy-infra-remote.sh verified on VM (sha256 match)"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Execute remote script with env vars
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Remote env is passed via a quote-safe file (printf %q) + scp + source, NOT a
# fragile inline `VAR='$VAR'` ssh command line. A single value containing a `'`
# (or newline) corrupted the remote's single-quote parsing and silently
# truncated every var AFTER it: COGNI_NODE_DBS / COGNI_DEFAULT_NODE_ID /
# LITELLM_IMAGE arrived EMPTY at the VM and deploy-infra aborted before
# db-provision ran (bug.5090 — preview node DBs never created). printf %q is
# injection-proof for arbitrary secret values. Required runner-computed vars
# still hard-fail HERE on the runner if unset.
: "${COGNI_DEFAULT_NODE_ID:?COGNI_DEFAULT_NODE_ID required (resolved on runner from repo-spec primary-host)}"
: "${LITELLM_IMAGE:?LITELLM_IMAGE required (resolved on runner from infra/catalog/litellm.yaml content-hash)}"
: "${OPENFGA_IMAGE:?OPENFGA_IMAGE required (resolved on runner from infra/catalog/openfga.yaml content-hash)}"
COMMIT_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
DEPLOY_ACTOR="${GITHUB_ACTOR:-$(whoami)}"

REMOTE_ENV_VARS=(
  DOMAIN APP_ENV DEPLOY_ENVIRONMENT DATABASE_URL DATABASE_SERVICE_URL
  LITELLM_MASTER_KEY OPENROUTER_API_KEY AUTH_SECRET
  POSTGRES_ROOT_USER POSTGRES_ROOT_PASSWORD APP_DB_USER APP_DB_PASSWORD
  APP_DB_SERVICE_USER APP_DB_SERVICE_PASSWORD APP_DB_READONLY_USER
  APP_DB_READONLY_PASSWORD APP_DB_NAME EVM_RPC_URL POLYGON_RPC_URL
  TEMPORAL_DB_USER GHCR_DEPLOY_TOKEN GHCR_USERNAME
  GRAFANA_CLOUD_LOKI_URL GRAFANA_CLOUD_LOKI_USER GRAFANA_CLOUD_LOKI_API_KEY
  METRICS_TOKEN SCHEDULER_API_TOKEN BILLING_INGEST_TOKEN INTERNAL_OPS_TOKEN
  WORK_ITEMS_NOTION_TOKEN WORK_ITEMS_NOTION_DATA_SOURCE_ID WORK_ITEMS_NOTION_VERSION
  PROMETHEUS_REMOTE_WRITE_URL PROMETHEUS_USERNAME PROMETHEUS_PASSWORD
  PROMETHEUS_QUERY_URL PROMETHEUS_READ_USERNAME PROMETHEUS_READ_PASSWORD
  LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_BASE_URL
  COGNI_REPO_URL COGNI_REPO_REF GIT_READ_USERNAME GIT_READ_TOKEN
  GRAFANA_URL
  GRAFANA_SERVICE_ACCOUNT_TOKEN GRAFANA_PDC_SIGNING_TOKEN
  GRAFANA_PDC_HOSTED_GRAFANA_ID GRAFANA_PDC_CLUSTER GRAFANA_PDC_NETWORK_ID
  GRAFANA_PDC_NETWORK_UUID POSTHOG_API_KEY POSTHOG_HOST TAVILY_API_KEY
  DISCORD_BOT_TOKEN GH_OAUTH_CLIENT_ID GH_OAUTH_CLIENT_SECRET
  DISCORD_OAUTH_CLIENT_ID DISCORD_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_OAUTH_CLIENT_SECRET DOLTHUB_OWNER
  DOLT_CREDS_JWK DOLT_CREDS_KEYID DOLTHUB_API_TOKEN
  DOLTHUB_OAUTH_CLIENT_ID DOLTHUB_OAUTH_CLIENT_SECRET
  GH_REVIEW_APP_ID GH_REVIEW_APP_PRIVATE_KEY_BASE64 GH_REPOS GH_WEBHOOK_SECRET
  NODE_MINT_OWNER NODE_TEMPLATE_OWNER
  PRIVY_APP_ID PRIVY_APP_SECRET PRIVY_SIGNING_KEY PRIVY_USER_WALLETS_APP_ID
  PRIVY_USER_WALLETS_APP_SECRET PRIVY_USER_WALLETS_SIGNING_KEY
  POLY_WALLET_AEAD_KEY_HEX POLY_WALLET_AEAD_KEY_ID POLY_CLOB_GEO_BLOCK_TOKEN
  CONNECTIONS_ENCRYPTION_KEY COGNI_NODE_DBS NODE_APP_TARGETS NODE_DB_PROVISION_CONFIG EDGE_ENV_LINES
  LITELLM_NODE_ENDPOINTS COGNI_DEFAULT_NODE_ID ACTIONS_AUTOMATION_BOT_PAT
  LITELLM_IMAGE OPENFGA_IMAGE COMMIT_SHA DEPLOY_ACTOR K8S_SECRETS_ONLY
  OPERATOR_DATABASE_SERVICE_URL REMOTE_HARDEN_SCRIPT REMOTE_COMPUTE_EGRESS_ALLOWLIST
)
REMOTE_ENV_FILE="$ARTIFACT_DIR/deploy-infra-env.sh"
: > "$REMOTE_ENV_FILE"
for _rv in "${REMOTE_ENV_VARS[@]}"; do
  # %q quotes any value safely (single quotes, spaces, newlines) so sourcing
  # reconstructs the exact value. `${!_rv-}` = indirect read, empty if unset.
  printf '%s=%q\n' "$_rv" "${!_rv-}" >> "$REMOTE_ENV_FILE"
done
unset _rv
scp $SSH_OPTS "$REMOTE_ENV_FILE" root@"$VM_HOST":/tmp/deploy-infra-env.sh
ssh $SSH_OPTS root@"$VM_HOST" \
    "set -a; . /tmp/deploy-infra-env.sh; set +a; rm -f /tmp/deploy-infra-env.sh; bash /tmp/deploy-infra-remote.sh"
rm -f "$REMOTE_ENV_FILE"

emit_deployment_event "infra_deployment.complete" "success" "Infrastructure deployment completed"
log_info "Infrastructure deployment complete!"
