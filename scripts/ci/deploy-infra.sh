#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Script: scripts/ci/deploy-infra.sh
# Purpose: Infra lever (task.0314) — deploy Compose infrastructure (postgres,
#          litellm, temporal, redis, alloy, caddy) to a remote VM via SSH. App
#          containers are managed by k8s/Argo CD; this script only handles
#          infra services.
# Usage:
#   deploy-infra.sh [--ref <git-ref>] [--dry-run]
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
# Invariants:
#   - DEPLOY_ENVIRONMENT must be set to 'candidate-a', 'preview', or 'production'
#     (legacy 'canary' value is still accepted for backward compatibility during
#     the bug.0312 rename; will be removed once no caller sends it)
#   - App/migrator/scheduler-worker containers are NOT started (k8s handles those)
#   - DB migrations are NOT run (k8s PreSync hook handles those)
#   - SSH_KEEPALIVE: All SSH connections use ServerAliveInterval to survive long operations.
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
usage() {
  echo "Usage: $0 [--ref <git-ref>] [--dry-run] [--k8s-secrets-only]" >&2
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

# Validate required secrets
REQUIRED_SECRETS=(
    "DOMAIN"
    "DATABASE_URL"
    "DATABASE_SERVICE_URL"
    "LITELLM_MASTER_KEY"
    "OPENROUTER_API_KEY"
    "AUTH_SECRET"
    "VM_HOST"
    "POSTGRES_ROOT_USER"
    "POSTGRES_ROOT_PASSWORD"
    "APP_DB_USER"
    "APP_DB_PASSWORD"
    "APP_DB_SERVICE_USER"
    "APP_DB_SERVICE_PASSWORD"
    "APP_DB_NAME"
    "EVM_RPC_URL"
    "POLYGON_RPC_URL"
    "TEMPORAL_DB_USER"
    "TEMPORAL_DB_PASSWORD"
    "INTERNAL_OPS_TOKEN"
    "POSTHOG_API_KEY"
    "POSTHOG_HOST"
)

REQUIRED_ENV_VARS=(
    "APP_ENV"
    "COGNI_REPO_URL"
    "COGNI_REPO_REF"
)

MISSING_SECRETS=()
for secret in "${REQUIRED_SECRETS[@]}"; do
    if [[ -z "${!secret:-}" ]]; then
        MISSING_SECRETS+=("$secret")
    fi
done

MISSING_ENV_VARS=()
for env_var in "${REQUIRED_ENV_VARS[@]}"; do
    if [[ -z "${!env_var:-}" ]]; then
        MISSING_ENV_VARS+=("$env_var")
    fi
done

if [[ ${#MISSING_SECRETS[@]} -gt 0 ]]; then
    log_error "Missing required secret environment variables:"
    for secret in "${MISSING_SECRETS[@]}"; do
        log_error "  - $secret"
    done
    exit 1
fi

if [[ ${#MISSING_ENV_VARS[@]} -gt 0 ]]; then
    log_error "Missing required environment variables:"
    for env_var in "${MISSING_ENV_VARS[@]}"; do
        log_error "  - $env_var"
    done
    exit 1
fi

log_info "All required secrets provided"

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
trap cleanup_worktree EXIT

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
NODE_APP_TARGETS="${NODE_TARGETS[*]}"
[ -n "$NODE_APP_TARGETS" ] || log_fatal "deploy-infra: no type:node targets from infra/catalog — refusing to deploy with an empty node list"
log_info "Node-app targets (catalog-driven): ${NODE_APP_TARGETS}"

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
LITELLM_NODE_HOST="${DEPLOY_ENVIRONMENT}.vm.cognidao.org"
LITELLM_NODE_ENDPOINTS="$(node_billing_endpoint_csv "$LITELLM_NODE_HOST")"
log_info "LiteLLM callback routing (catalog-driven): ${LITELLM_NODE_ENDPOINTS}"
# LiteLLM image is a type:infra catalog target — content-hash tagged + built in
# CI (no manual docker build / hand-pin). Resolve the same tag CI pushed.
LITELLM_IMAGE="$(infra_image_tag litellm)"
log_info "LiteLLM image (catalog content-hash): ${LITELLM_IMAGE}"
# Default node for unattributed spend — primary-host node_id from repo-spec
# (REPO_SPEC_IS_IDENTITY_SSOT). The LiteLLM callback carries no hardcoded UUID.
COGNI_DEFAULT_NODE_ID="$(default_node_id)"
log_info "LiteLLM default node (repo-spec primary-host): ${COGNI_DEFAULT_NODE_ID}"

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
trap 'echo -e "\033[0;31m[FATAL]\033[0m Script failed at line $LINENO: $BASH_COMMAND" >&2' ERR

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

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Firewall: close Docker-published internal ports to public internet
# (idempotent; safe to re-run on every deploy). See bug.5167.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if [ -f /tmp/harden-docker-public-ports.sh ]; then
  echo -e "\033[0;32m[INFO]\033[0m Hardening Docker-published ports (DOCKER-USER chain)..."
  bash /tmp/harden-docker-public-ports.sh
else
  echo -e "\033[1;33m[WARN]\033[0m harden-docker-public-ports.sh missing — skipping firewall hardening"
fi

# Compose shortcuts (explicit project names, no global export)
EDGE_COMPOSE="docker compose --project-name cogni-edge -f /opt/cogni-template-edge/docker-compose.yml"
RUNTIME_COMPOSE="docker compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml"

log_info() {
    echo -e "\033[0;32m[INFO]\033[0m $1"
}

log_warn() {
    echo -e "\033[1;33m[WARN]\033[0m $1"
}

log_error() {
    echo -e "\033[0;31m[ERROR]\033[0m $1"
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

# Runtime env (full config — compose validates all vars even for services we don't start)
RUNTIME_ENV=/opt/cogni-template-runtime/.env
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
DEPLOY_ENVIRONMENT=${DEPLOY_ENVIRONMENT}
EVM_RPC_URL=${EVM_RPC_URL}
POLYGON_RPC_URL=${POLYGON_RPC_URL}
TEMPORAL_DB_USER=${TEMPORAL_DB_USER}
TEMPORAL_DB_PASSWORD=${TEMPORAL_DB_PASSWORD}
COGNI_REPO_URL=${COGNI_REPO_URL}
COGNI_REPO_REF=${COGNI_REPO_REF}
GIT_READ_USERNAME=${GIT_READ_USERNAME}
GIT_READ_TOKEN=${GIT_READ_TOKEN}
POSTHOG_API_KEY=${POSTHOG_API_KEY}
POSTHOG_HOST=${POSTHOG_HOST}
# App/worker images — not started by infra deploy, but compose validates all vars.
# Use placeholder values; k8s/Argo manages the real images.
APP_IMAGE=${APP_IMAGE:-cogni-template-local}
MIGRATOR_IMAGE=${MIGRATOR_IMAGE:-unused-by-infra-deploy}
SCHEDULER_WORKER_IMAGE=${SCHEDULER_WORKER_IMAGE:-unused-by-infra-deploy}
# LiteLLM image — set above from GHCR content-hash tag.
LITELLM_IMAGE=${LITELLM_IMAGE}
ENV_EOF

# Verify .env was written
if ! test -s "$RUNTIME_ENV"; then
  log_error ".env write failed: $RUNTIME_ENV is empty or missing"
  exit 1
fi
log_info ".env written: $(wc -c < "$RUNTIME_ENV") bytes, $(wc -l < "$RUNTIME_ENV") lines"

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
# Discord bot (OpenClaw channel plugin)
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
# Grafana observability (for OpenClaw grafana-health skill)
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

# Doltgres has weak GRANT support so roles are near-permissive today; derived
# secrets are still a least-privilege improvement over a shared root pw.
DOLTGRES_PASSWORD="${DOLTGRES_PASSWORD:-$(derive_secret doltgres-root)}"
DOLTGRES_READER_PASSWORD="${DOLTGRES_READER_PASSWORD:-$(derive_secret doltgres-reader)}"
DOLTGRES_WRITER_PASSWORD="${DOLTGRES_WRITER_PASSWORD:-$(derive_secret doltgres-writer)}"
printf '%s=%s\n' DOLTGRES_PASSWORD "$DOLTGRES_PASSWORD" >> "$RUNTIME_ENV"
printf '%s=%s\n' DOLTGRES_READER_PASSWORD "$DOLTGRES_READER_PASSWORD" >> "$RUNTIME_ENV"
printf '%s=%s\n' DOLTGRES_WRITER_PASSWORD "$DOLTGRES_WRITER_PASSWORD" >> "$RUNTIME_ENV"

if [[ "${K8S_SECRETS_ONLY:-false}" != "true" ]]; then

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 2: Start edge stack (idempotent - only starts if not running)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "Ensuring edge stack (Caddy) is running..."
if ! $EDGE_COMPOSE ps -q caddy 2>/dev/null | grep -q .; then
  log_info "Starting edge stack..."
  $EDGE_COMPOSE up -d
else
  log_info "Edge stack already running"
  # Check for Caddyfile changes and recreate the container if needed.
  #
  # task.5078: previously this did `caddy reload || restart`. Reload re-reads
  # the Caddyfile but Caddy's runtime env stays whatever was set at the
  # original `docker compose up -d`. When deploy-infra adds a new site env
  # var to /opt/cogni-template-edge/.env (e.g., NODE_TEMPLATE_DOMAIN), reload
  # substitutes `{$NODE_TEMPLATE_DOMAIN}` to empty, the new server block is
  # silently absent, no cert gets provisioned, and TLS handshake errors out
  # for the new hostname. `docker compose up -d` (without --force-recreate)
  # detects the env_file delta and recreates the container with the new env
  # — fully covers the new-domain case without disturbing Caddy when only
  # existing-site Caddyfile lines changed.
  HASH_DIR="/var/lib/cogni"
  CADDYFILE="/opt/cogni-template-edge/configs/Caddyfile.tmpl"
  EDGE_ENV_FILE="/opt/cogni-template-edge/.env"
  CADDY_HASH_FILE="$HASH_DIR/caddyfile.sha256"
  EDGE_ENV_HASH_FILE="$HASH_DIR/edge.env.sha256"

  mkdir -p "$HASH_DIR"
  caddyfile_changed=false
  edge_env_changed=false

  if [[ -f "$CADDYFILE" ]]; then
    NEW_CADDY_HASH=$(hash_file "$CADDYFILE")
    OLD_CADDY_HASH=$(cat "$CADDY_HASH_FILE" 2>/dev/null || echo "none")
    if [[ "$NEW_CADDY_HASH" != "$OLD_CADDY_HASH" && "$NEW_CADDY_HASH" != "no-hash-tool" ]]; then
      caddyfile_changed=true
    fi
  fi
  if [[ -f "$EDGE_ENV_FILE" ]]; then
    NEW_EDGE_ENV_HASH=$(hash_file "$EDGE_ENV_FILE")
    OLD_EDGE_ENV_HASH=$(cat "$EDGE_ENV_HASH_FILE" 2>/dev/null || echo "none")
    if [[ "$NEW_EDGE_ENV_HASH" != "$OLD_EDGE_ENV_HASH" && "$NEW_EDGE_ENV_HASH" != "no-hash-tool" ]]; then
      edge_env_changed=true
    fi
  fi

  if [[ "$caddyfile_changed" == "true" || "$edge_env_changed" == "true" ]]; then
    log_info "Edge stack config changed (caddyfile=${caddyfile_changed} env=${edge_env_changed}), recreating Caddy..."
    # --force-recreate guarantees the container restarts even when compose's
    # delta detector doesn't classify env_file content as a change (which is
    # its default — env_file additions only trigger recreate via the explicit
    # flag). Belt-and-suspenders for the new-site-env-var case from task.5078.
    $EDGE_COMPOSE up -d --force-recreate caddy
    [[ "$caddyfile_changed" == "true" ]] && echo "$NEW_CADDY_HASH" > "$CADDY_HASH_FILE"
    [[ "$edge_env_changed" == "true" ]] && echo "$NEW_EDGE_ENV_HASH" > "$EDGE_ENV_HASH_FILE"
    log_info "Caddy recreated; new env_file values + Caddyfile in effect"
  fi
fi

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

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 4: Assert profile services exist (guard against silent compose drift)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESOLVED_SERVICES=$($RUNTIME_COMPOSE --profile bootstrap config --services)
log_info "Profile guardrail passed (sandbox-openclaw disabled)"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 5: Start/update postgres (must be healthy before provisioning)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "Bringing up postgres..."
if ! output="$($RUNTIME_COMPOSE up -d postgres 2>&1)"; then
  printf '%s\n' "$output" >&2
  if grep -qiE 'has active endpoints|error while removing network' <<<"$output"; then
    log_warn "Incremental reconcile failed due to network recreation; forcing full runtime teardown..."
    $RUNTIME_COMPOSE down --remove-orphans --timeout 30
    $RUNTIME_COMPOSE up -d postgres
  else
    exit 1
  fi
else
  printf '%s\n' "$output"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6: Run DB provisioning (idempotent — creates users/DBs if missing)
# Note: DB migrations are NOT run here — k8s PreSync hook handles those.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "[$(date -u +%H:%M:%S)] Running DB provisioning..."
emit_deployment_event "infra_deployment.db_provision_started" "in_progress" "Provisioning database users and schemas"
$RUNTIME_COMPOSE --profile bootstrap run --rm db-provision

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6a: Bring up Doltgres + provision DBs + roles
# Parallel to postgres/db-provision above, but for the knowledge data plane.
# Schema migration itself is NOT run here — it's a k8s PreSync Job
# (infra/k8s/base/poly-doltgres/doltgres-migration-job.yaml) that Argo CD
# runs before the poly Deployment syncs. Same pattern as the Postgres
# migrator Job (infra/k8s/base/node-app/migration-job.yaml).
# Guarded on compose presence — tolerates envs where doltgres is not in the compose file.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if $RUNTIME_COMPOSE config --services 2>/dev/null | grep -q '^doltgres$'; then
  log_info "[$(date -u +%H:%M:%S)] Bringing up doltgres..."
  $RUNTIME_COMPOSE up -d doltgres

  log_info "[$(date -u +%H:%M:%S)] Provisioning Doltgres DBs + roles..."
  $RUNTIME_COMPOSE --profile bootstrap run --rm doltgres-provision

  log_info "[$(date -u +%H:%M:%S)] Doltgres up + DBs provisioned. Schema migration runs as k8s PreSync Job."
else
  log_info "Doltgres not present in compose config — skipping knowledge plane bootstrap"
fi
log_info "[$(date -u +%H:%M:%S)] DB provisioning complete"
emit_deployment_event "infra_deployment.db_provision_complete" "success" "Database provisioned successfully"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6.6: Start/update infra services (rolling update, no down)
# Compose infra (Temporal, LiteLLM, Redis) must be up BEFORE k8s pods restart,
# because k8s pods depend on these via EndpointSlice bridges.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_info "[$(date -u +%H:%M:%S)] Starting infra services (rolling update)..."
emit_deployment_event "infra_deployment.stack_up_started" "in_progress" "Starting infrastructure services"

# Autoheal guard: stop autoheal before compose up to prevent race condition
# (autoheal can restart a container between compose stop and remove)
$RUNTIME_COMPOSE stop autoheal 2>/dev/null || true

# Infra services only — excludes app, scheduler-worker, db-migrate, and one-shot backup jobs
INFRA_SERVICES="postgres litellm redis alloy temporal-postgres temporal temporal-ui autoheal repo-init git-sync"
# Doltgres is optional — only include if it's in the compose file for this env.
if $RUNTIME_COMPOSE config --services 2>/dev/null | grep -q '^doltgres$'; then
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

# Sandbox-openclaw disabled — removed from k8s catalog and compose deploy path.

log_info "[$(date -u +%H:%M:%S)] Infra stack up complete"
emit_deployment_event "infra_deployment.stack_up_complete" "success" "Infrastructure services started"

ALLOY_CONFIG="/opt/cogni-template-runtime/configs/alloy-config.metrics.alloy"
ALLOY_HASH_FILE="/var/lib/cogni/alloy-config.sha256"
if [[ -f "$ALLOY_CONFIG" ]]; then
  mkdir -p /var/lib/cogni
  NEW_ALLOY_HASH=$(hash_file "$ALLOY_CONFIG")
  OLD_ALLOY_HASH=$(cat "$ALLOY_HASH_FILE" 2>/dev/null || echo "none")
  if [[ "$NEW_ALLOY_HASH" != "$OLD_ALLOY_HASH" && "$NEW_ALLOY_HASH" != "no-hash-tool" ]]; then
    log_info "Alloy config changed (hash: ${NEW_ALLOY_HASH:0:12}...), restarting container..."
    $RUNTIME_COMPOSE restart alloy
    echo "$NEW_ALLOY_HASH" > "$ALLOY_HASH_FILE"
    log_info "Alloy restarted with new config"
  else
    log_info "Alloy config unchanged (hash: ${NEW_ALLOY_HASH:0:12}...), no restart needed"
  fi
else
  log_warn "Alloy config missing at $ALLOY_CONFIG, skipping restart check"
fi

log_info "[$(date -u +%H:%M:%S)] Installing db-backup systemd timer..."
$RUNTIME_COMPOSE --profile backup stop db-backup 2>/dev/null || true
$RUNTIME_COMPOSE --profile backup rm -f db-backup 2>/dev/null || true
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
OnBootSec=15min
OnUnitActiveSec=${BACKUP_INTERVAL_SECONDS}s
AccuracySec=5min
RandomizedDelaySec=5min
Persistent=true
Unit=cogni-db-backup.service

[Install]
WantedBy=timers.target
SYSTEMD_TIMER_EOF

systemctl daemon-reload
systemctl enable --now cogni-db-backup.timer
systemctl reset-failed cogni-db-backup.service 2>/dev/null || true
log_info "db-backup timer installed with interval ${BACKUP_INTERVAL_SECONDS}s"

log_info "Running db-backup validation backup..."
# `up --force-recreate` keeps the Exited container briefly so alloy scrapes
# `db_backup.completed` into Loki (relied on by candidate-flight-infra). The
# explicit `rm -f` after prevents the next timer fire from colliding on the
# container name; the systemd unit's ExecStartPost mirrors this for the timer.
# A pre-cleanup at line ~888 + the existing top-level [FATAL] ERR trap handle
# the case where validation aborts mid-flight and leaves a leftover. (bug.5169)
# NON-FATAL: the inline validation backup is a smoke test, NOT a serving
# prerequisite. The scheduled systemd timer (above) is the real backup. A flaky
# / SIGKILLed (exit 137) validation MUST NOT abort deploy-infra and starve the
# app layer (Step 7 creates the namespace + node-app Secrets + triggers Argo) —
# that turns one backup hiccup into a cluster-wide outage (provision-env skill
# Gotcha 13, candidate-a 2026-06-04). Warn + continue; the timer retries.
backup_validated=1
if $RUNTIME_COMPOSE --profile backup up --force-recreate --no-deps --abort-on-container-exit --exit-code-from db-backup db-backup; then
  $RUNTIME_COMPOSE --profile backup logs --tail 80 db-backup | grep -q 'db_backup.completed' \
    || { log_warn "db-backup completed-marker missing after validation backup (non-fatal)"; backup_validated=0; }
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
  log_warn "db-backup validation backup did not exit clean (e.g. exit 137 on a loaded VM) — NON-FATAL; the scheduled timer will retry. Continuing so the app layer deploys."
  backup_validated=0
fi
$RUNTIME_COMPOSE --profile backup rm -f db-backup 2>/dev/null || true
if [[ "$backup_validated" == 1 ]]; then
  emit_deployment_event "infra_deployment.db_backup_scheduled" "success" "db-backup timer installed and validation backup completed"
else
  emit_deployment_event "infra_deployment.db_backup_scheduled" "warning" "db-backup timer installed; inline validation backup did not fully verify (non-fatal — timer retries)"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6.6a: Checksum-gated restart for LiteLLM config changes
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

# Steps 6.6b–6.6c (OpenClaw config hash + readiness gate) removed — sandbox-openclaw disabled.
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

  # ── Phase-1 read-path proof: OpenBao db-reader (Invariant 15 DB-cred migration) ─
  # secrets-management.md "DB-credential provisioning" Phase 1. deploy-infra holds
  # NO root token (Invariant 13); here it proves it can mint a least-privilege,
  # READ-ONLY OpenBao token via the ${DEPLOY_ENVIRONMENT}-db-reader k8s-auth role
  # and read the env's DB-cred tree — the same values ESO syncs to pods. Phase 2
  # will USE this to render .env from OpenBao instead of GH secrets; Phase 1 only
  # establishes + proves the path. STRICTLY NON-FATAL: any failure (db-reader role
  # absent on a VM provisioned before this landed, OpenBao sealed, empty tree)
  # logs a warning and never aborts the deploy. No secret VALUE is ever printed.
  verify_openbao_db_read_path() {
    local jwt tok
    # Every cluster call is `timeout 10`-bounded: a non-zero exit is already
    # caught (|| return 0), but a true network hang (OpenBao sealed/unreachable)
    # would stall — not abort — the deploy. The timeout converts a hang into the
    # same non-fatal skip.
    if ! timeout 10 kubectl get sa db-provisioner -n default >/dev/null 2>&1; then
      log_warn "  [openbao-read-path] db-provisioner SA absent — VM predates Phase 1; reprovision to land the db-reader role. Skipping proof (non-fatal)."
      return 0
    fi
    jwt=$(timeout 10 kubectl create token db-provisioner -n default 2>/dev/null) || {
      log_warn "  [openbao-read-path] could not mint db-provisioner token; skipping proof (non-fatal)."
      return 0
    }
    tok=$(timeout 10 kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \
      bao write -field=token auth/kubernetes/login \
      "role=${DEPLOY_ENVIRONMENT}-db-reader" "jwt=${jwt}" 2>/dev/null) || {
      log_warn "  [openbao-read-path] db-reader login failed (role absent / OpenBao sealed); skipping proof (non-fatal)."
      return 0
    }
    if timeout 10 kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN="${tok}" \
        bao kv list "cogni/${DEPLOY_ENVIRONMENT}" >/dev/null 2>&1; then
      log_info "  [openbao-read-path] OK — db-reader listed cogni/${DEPLOY_ENVIRONMENT}/* (Phase 1 proven; no value echoed)."
    else
      log_warn "  [openbao-read-path] db-reader token minted but list returned nothing (empty tree?); path partially proven (non-fatal)."
    fi
    return 0
  }
  verify_openbao_db_read_path || true

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
    SECRET_FILE=$(mktemp)
    cat > "$SECRET_FILE" <<SECEOF
DATABASE_URL=postgresql://${APP_DB_USER}:${APP_DB_PASSWORD}@${HOST_IP}:5432/cogni_${db_node}?sslmode=disable
DATABASE_SERVICE_URL=postgresql://${APP_DB_SERVICE_USER}:${APP_DB_SERVICE_PASSWORD}@${HOST_IP}:5432/cogni_${db_node}?sslmode=disable
${DOLTGRES_ENV_LINE}
AUTH_SECRET=${AUTH_SECRET}
LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
EVM_RPC_URL=${EVM_RPC_URL}
POLYGON_RPC_URL=${POLYGON_RPC_URL}
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
  # bug.5000: GH_REVIEW_APP_* are NOT injected — the worker HTTP-delegates PR
  # review GitHub I/O to the operator and holds no GitHub credential. (Keep in
  # parity with SCHEDULER_WORKER_KEYS in scripts/setup/lib/reconcile-secrets.sh.)
  SECRET_FILE=$(mktemp)
  cat > "$SECRET_FILE" <<SECEOF
DATABASE_URL=postgresql://${APP_DB_SERVICE_USER}:${APP_DB_SERVICE_PASSWORD}@${HOST_IP}:5432/cogni_operator?sslmode=disable
SCHEDULER_API_TOKEN=${SCHEDULER_API_TOKEN:-}
INTERNAL_OPS_TOKEN=${INTERNAL_OPS_TOKEN:-}
COGNI_NODE_DBS=${COGNI_NODE_DBS:-}
GH_WEBHOOK_SECRET=${GH_WEBHOOK_SECRET:-}
SECEOF
  kubectl -n "${K8S_NS}" create secret generic scheduler-worker-secrets \
    --from-env-file="$SECRET_FILE" --dry-run=client -o yaml | kubectl apply -f -
  rm -f "$SECRET_FILE"
  log_info "  Applied scheduler-worker-secrets"

  # Sandbox-openclaw secret removed — sandbox-openclaw disabled.

  log_info "[$(date -u +%H:%M:%S)] k8s secrets applied"
  emit_deployment_event "infra_deployment.k8s_secrets_complete" "success" "k8s secrets applied"

  # ── Sync GitHub App webhook secret (source: external) ───────────────────────
  # GH_WEBHOOK_SECRET is agent-generated but must byte-match the GitHub App's
  # webhook secret (the value lives on GitHub's side too). Push the provisioned
  # value to the App via the App's own key so BOTH copies converge — otherwise
  # every inbound webhook fails HMAC verification silently and this very step
  # (re-writing the pod Secret each deploy) is the BREAKING path, not the
  # healing one. Fail-soft: a sync failure warns but never aborts the deploy.
  # See docs/spec/secrets-management.md (source: external).
  # Runs ON THE VM (inside the remote heredoc) — REPO_ROOT is a runner-only var
  # and is UNBOUND here under `set -u`; the script is scp'd to /tmp alongside
  # ensure-temporal-namespace.sh (see upload block). A bare $REPO_ROOT ref aborts
  # the whole deploy before Phase 7 → zero app layer (regression #1482, candidate-a
  # 2026-06-04). Invoke the uploaded /tmp copy instead.
  if GH_REVIEW_APP_ID="${GH_REVIEW_APP_ID:-}" \
     GH_REVIEW_APP_PRIVATE_KEY_BASE64="${GH_REVIEW_APP_PRIVATE_KEY_BASE64:-}" \
     GH_WEBHOOK_SECRET="${GH_WEBHOOK_SECRET:-}" \
     bash /tmp/sync-app-webhook-secret.sh; then
    log_info "  GitHub App webhook secret synced (pod ↔ App)"
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

  # ── Wait for node-app rollouts first ───────────────────────────────────────
  ROLLOUT_PIDS=""
  for node in ${NODE_APP_TARGETS}; do
    kubectl -n "${K8S_NS}" rollout status "deployment/${node}-node-app" --timeout=300s 2>/dev/null &
    ROLLOUT_PIDS="$ROLLOUT_PIDS $!"
  done
  ROLLOUT_FAILED=0
  for pid in $ROLLOUT_PIDS; do
    if ! wait "$pid"; then
      ROLLOUT_FAILED=1
    fi
  done
  if [ $ROLLOUT_FAILED -ne 0 ]; then
    log_warn "One or more node-app rollouts did not complete within 300s"
  fi
  log_info "[$(date -u +%H:%M:%S)] Node-apps ready — rolling scheduler-worker"

  # ── Roll scheduler-worker only after node-apps are ready ───────────────────
  kubectl -n "${K8S_NS}" rollout restart deployment/scheduler-worker 2>/dev/null || true
  if ! kubectl -n "${K8S_NS}" rollout status deployment/scheduler-worker --timeout=300s 2>/dev/null; then
    log_warn "scheduler-worker rollout did not complete within 300s"
    ROLLOUT_FAILED=1
  fi
  log_info "[$(date -u +%H:%M:%S)] All rollouts complete"
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

# OpenClaw config/workspace uploads removed — sandbox-openclaw disabled.

# Upload deployment script
scp $SSH_OPTS "$ARTIFACT_DIR/deploy-infra-remote.sh" root@"$VM_HOST":/tmp/deploy-infra-remote.sh

# Upload healthcheck and bootstrap scripts (called from deploy-infra-remote.sh)
scp $SSH_OPTS \
  "$REPO_ROOT/scripts/ci/ensure-temporal-namespace.sh" \
  "$REPO_ROOT/infra/provision/cherry/harden-docker-public-ports.sh" \
  "$REPO_ROOT/scripts/secrets/sync-app-webhook-secret.sh" \
  root@"$VM_HOST":/tmp/

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
COMMIT_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
DEPLOY_ACTOR="${GITHUB_ACTOR:-$(whoami)}"

REMOTE_ENV_VARS=(
  DOMAIN APP_ENV DEPLOY_ENVIRONMENT DATABASE_URL DATABASE_SERVICE_URL
  LITELLM_MASTER_KEY OPENROUTER_API_KEY AUTH_SECRET
  POSTGRES_ROOT_USER POSTGRES_ROOT_PASSWORD APP_DB_USER APP_DB_PASSWORD
  APP_DB_SERVICE_USER APP_DB_SERVICE_PASSWORD APP_DB_READONLY_USER
  APP_DB_READONLY_PASSWORD APP_DB_NAME EVM_RPC_URL POLYGON_RPC_URL
  TEMPORAL_DB_USER TEMPORAL_DB_PASSWORD GHCR_DEPLOY_TOKEN GHCR_USERNAME
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
  CONNECTIONS_ENCRYPTION_KEY COGNI_NODE_DBS NODE_APP_TARGETS EDGE_ENV_LINES
  LITELLM_NODE_ENDPOINTS COGNI_DEFAULT_NODE_ID ACTIONS_AUTOMATION_BOT_PAT
  LITELLM_IMAGE COMMIT_SHA DEPLOY_ACTOR K8S_SECRETS_ONLY
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
