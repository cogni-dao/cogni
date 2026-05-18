#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/setup/provision-test-vm.sh
# Purpose: One-command VM provisioning + infra deployment + scorecard.
#          Generates ALL secrets (same generators as setup-secrets.ts), provisions
#          via OpenTofu, deploys Compose infra, verifies k3s + Argo CD.
# Usage:
#   CHERRY_AUTH_TOKEN=<token> bash scripts/setup/provision-test-vm.sh preview
#   CHERRY_AUTH_TOKEN=<token> bash scripts/setup/provision-test-vm.sh production
#   CHERRY_AUTH_TOKEN=<token> bash scripts/setup/provision-test-vm.sh candidate-a
#   CHERRY_AUTH_TOKEN=<token> bash scripts/setup/provision-test-vm.sh candidate-b
# Environments:
#   preview, production     — long-lived post-merge lanes
#   candidate-*             — pre-merge slots (candidate-a, candidate-b, ...).
#                             Requires matching infra/k8s/argocd/
#                             ${slot}-applicationset.yaml and
#                             infra/k8s/overlays/${slot}/*. DNS defaults to
#                             Cogni owns operator + resy public DNS and a
#                             repo-scoped VM alias. It does not provision or
#                             route cogni-poly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROVISION_DIR="$REPO_ROOT/infra/provision/cherry/base"

# shellcheck source=./scripts/setup/lib/cogni-deployment-identity.sh
source "$SCRIPT_DIR/lib/cogni-deployment-identity.sh"

# ── Flags ─────────────────────────────────────────────────────
AUTO_APPROVE=false
DEPLOY_ENV=""
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_APPROVE=true ;;
    preview|production) DEPLOY_ENV="$arg" ;;
    candidate-*) DEPLOY_ENV="$arg" ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

if [[ -z "$DEPLOY_ENV" ]]; then
  echo "Usage: provision-test-vm.sh <preview|production|candidate-*> [--yes]"
  echo ""
  echo "  preview       — preview.cognidao.org"
  echo "  production    — cognidao.org"
  echo "  candidate-a   — test.cognidao.org + resy-test.cognidao.org"
  echo "  candidate-b   — candidate-b.cognidao.org + resy-candidate-b.cognidao.org"
  echo "  --yes         — skip confirmation prompt (for CI/automation)"
  exit 1
fi

case "$DEPLOY_ENV" in
  preview)
    BRANCH="main"
    DEPLOY_BRANCH="deploy/preview"
    K8S_NAMESPACE="cogni-preview"
    OVERLAY_DIR="preview"
    APPSET_FILE="preview-applicationset.yaml"
    WORKSPACE="preview"
    ;;
  production)
    BRANCH="main"
    DEPLOY_BRANCH="deploy/production"
    K8S_NAMESPACE="cogni-production"
    OVERLAY_DIR="production"
    APPSET_FILE="production-applicationset.yaml"
    WORKSPACE="production"
    ;;
  candidate-*)
    # Pre-merge candidate slots. All fields derive from ${DEPLOY_ENV} so
    # spinning up candidate-b, candidate-c, ... only needs matching
    # infra/k8s/argocd/${slot}-applicationset.yaml and
    # infra/k8s/overlays/${slot}/ overlay trees. DNS is Cogni-scoped below.
    SLOT="$DEPLOY_ENV"
    BRANCH="main"
    DEPLOY_BRANCH="deploy/${SLOT}"
    K8S_NAMESPACE="cogni-${SLOT}"
    OVERLAY_DIR="${SLOT}"
    APPSET_FILE="${SLOT}-applicationset.yaml"
    WORKSPACE="${SLOT}"
    ;;
  *)
    echo "Unknown environment: $DEPLOY_ENV"
    echo "Must be one of: preview, production, candidate-*"
    echo "(canary was retired in bug.0312; candidate-a is its successor.)"
    exit 1
    ;;
esac

COGNI_DOMAIN_ROOT="$(cogni_domain_root)"
COGNI_DEPLOYMENT_SLUG="$(cogni_deployment_slug)"
DOMAIN="${DOMAIN:-$(cogni_operator_domain_for_env "$DEPLOY_ENV" "$COGNI_DOMAIN_ROOT")}"
RESY_DOMAIN="${RESY_DOMAIN:-$(cogni_resy_domain_for_env "$DEPLOY_ENV" "$COGNI_DOMAIN_ROOT")}"
VM_DNS_HOST="${VM_DNS_HOST:-$(cogni_vm_host_for_env "$DEPLOY_ENV" "$COGNI_DOMAIN_ROOT" "$COGNI_DEPLOYMENT_SLUG")}"
DNS_RECORDS=("$DOMAIN" "$RESY_DOMAIN" "$VM_DNS_HOST")
CADDYFILE_TEMPLATE="$REPO_ROOT/infra/compose/edge/configs/Caddyfile.cogni.tmpl"
COGNI_APP_TARGETS=("operator" "resy" "scheduler-worker")

# Allow branch override (e.g., testing a feature branch on preview infra)
BRANCH="${COGNI_REPO_REF:-$BRANCH}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${CYAN}[STEP]${NC} $1"; }

# ── Prerequisites ──────────────────────────────────────────
for cmd in tofu ssh-keygen age-keygen openssl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "Required: $cmd not found. Install it first."
    exit 1
  fi
done

# ── Secret generators (ported from setup-secrets.ts) ──────
# rand64: openssl rand -base64 <bytes>  (same as setup-secrets.ts rand64)
rand64() { openssl rand -base64 "${1:-32}"; }
# randHex: openssl rand -hex <bytes>    (same as setup-secrets.ts randHex)
randHex() { openssl rand -hex "${1:-32}"; }

# ══════════════════════════════════════════════════════════════
# Phase 1: Collect external inputs (only 2 required from human)
# ══════════════════════════════════════════════════════════════
log_step "Phase 1: Collect inputs"

# Load .env.operator if present (CHERRY_AUTH_TOKEN, OPENROUTER_API_KEY)
if [[ -f "$REPO_ROOT/.env.operator" ]]; then
  log_info "Loading .env.operator"
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env.operator"
  set +a
fi

# Cherry token — required
if [[ -z "${CHERRY_AUTH_TOKEN:-}" ]]; then
  echo -n "Cherry Servers API token: "
  read -rs CHERRY_AUTH_TOKEN
  echo ""
fi
export CHERRY_AUTH_TOKEN

if [[ -z "$CHERRY_AUTH_TOKEN" ]]; then
  log_error "CHERRY_AUTH_TOKEN is required."
  exit 1
fi

# Cherry project ID
if [[ -z "${CHERRY_PROJECT_ID:-}" ]]; then
  echo -n "Cherry Servers project ID: "
  read -r CHERRY_PROJECT_ID
  echo ""
fi

# OpenRouter key — optional (LiteLLM starts but can't proxy)
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo -n "OpenRouter API key (Enter to skip): "
  read -rs OPENROUTER_API_KEY
  echo ""
fi
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  log_warn "No OPENROUTER_API_KEY — LiteLLM will start but LLM calls will fail."
  OPENROUTER_API_KEY="sk-placeholder-no-llm-calls"
fi

# GHCR token for k3s image pulls (dummy OK for test — images are placeholders anyway)
GHCR_TOKEN="${GHCR_DEPLOY_TOKEN:-dummy-ghcr-token-for-test}"
GHCR_USERNAME="${GHCR_DEPLOY_USERNAME:-Cogni-1729}"

# ══════════════════════════════════════════════════════════════
# Phase 2: Load secrets from .env.{env} + generate VM keys
# ══════════════════════════════════════════════════════════════
mkdir -p "$REPO_ROOT/.local"

ENV_FILE="$REPO_ROOT/.env.${DEPLOY_ENV}"
if [[ ! -f "$ENV_FILE" ]]; then
  log_error "Missing $ENV_FILE"
  log_error "Run 'pnpm setup:secrets' first to generate secrets and save to .env.${DEPLOY_ENV}"
  exit 1
fi

log_step "Phase 2: Load secrets + generate VM keys"

# Load application secrets from .env.{env} (source of truth: setup-secrets.ts)
set -a
source "$ENV_FILE"
set +a
log_info "Loaded secrets from $ENV_FILE"

# SSH keypair — per-VM, not in .env file (uploaded to Cherry, saved to .local/)
# Reuse if VM exists, generate if fresh
if [[ -f "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-key" ]]; then
  log_info "Reusing existing SSH key from .local/${DEPLOY_ENV}-vm-key"
else
  TMPDIR=$(mktemp -d)
  log_info "Generating ephemeral SSH keypair..."
  ssh-keygen -t ed25519 -f "$TMPDIR/deploy_key" -C "cogni-${DEPLOY_ENV}-vm" -N "" -q
  cp "$TMPDIR/deploy_key.pub" "$PROVISION_DIR/keys/cogni_${DEPLOY_ENV}_deploy.pub"
  cp "$TMPDIR/deploy_key" "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-key"
  chmod 600 "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-key"
fi

# SOPS age keypair — per-VM, reuse if exists
if [[ -f "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-age-key" ]]; then
  AGE_PRIVATE_KEY=$(cat "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-age-key")
  log_info "Reusing existing SOPS age key"
else
  AGE_TMPDIR=$(mktemp -d)
  log_info "Generating ephemeral SOPS age keypair..."
  age-keygen -o "$AGE_TMPDIR/age-key.txt" 2>"$AGE_TMPDIR/age-pub.txt"
  AGE_PRIVATE_KEY=$(grep 'AGE-SECRET-KEY' "$AGE_TMPDIR/age-key.txt")
  AGE_PUBLIC_KEY=$(grep 'age1' "$AGE_TMPDIR/age-pub.txt" || grep 'age1' "$AGE_TMPDIR/age-key.txt" | head -1)
  log_info "  Age public key: $AGE_PUBLIC_KEY"
fi

# Set defaults for vars that may not be in .env file
POSTGRES_ROOT_USER="${POSTGRES_ROOT_USER:-postgres}"
APP_DB_USER="${APP_DB_USER:-app_user}"
APP_DB_SERVICE_USER="${APP_DB_SERVICE_USER:-app_service}"
APP_DB_READONLY_USER="${APP_DB_READONLY_USER:-app_readonly}"
TEMPORAL_DB_USER="${TEMPORAL_DB_USER:-temporal}"

# Derived values
APP_ENV="${DEPLOY_ENV}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENV}"

# Per-node databases. cogni-poly lives in its own repo/VM after the split.
COGNI_NODE_DBS="cogni_operator,cogni_resy"
LITELLM_DB_NAME="litellm"

# EVM RPC — use public Base mainnet endpoint for test
EVM_RPC_URL="${EVM_RPC_URL:-https://mainnet.base.org}"

# PostHog — use placeholder (app logs warning but starts)
POSTHOG_API_KEY="${POSTHOG_API_KEY:-phc_placeholder_test}"
POSTHOG_HOST="${POSTHOG_HOST:-https://us.i.posthog.com}"

# Repo URL/ref for git-sync
COGNI_REPO_URL="https://github.com/Cogni-DAO/cogni.git"
COGNI_REPO_REF="$BRANCH"

# LiteLLM node endpoints — billing callback routing (Compose→k8s NodePorts via host gateway)
# Format: nodeId=billingIngestUrl (one per node)
COGNI_NODE_ENDPOINTS="4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://host.docker.internal:30000/api/internal/billing/ingest,f6d2a17d-b7f6-4ad1-a86b-f0ad2380999e=http://host.docker.internal:30300/api/internal/billing/ingest"

# DATABASE_URLs (constructed from parts — same derivation as setup-secrets.ts)
# DATABASE_URLs use VM_IP placeholder — replaced after Phase 3 when IP is known.
# Inside k8s pods, 127.0.0.1 is the pod's loopback, NOT the host.
DATABASE_URL="postgresql://${APP_DB_USER}:${APP_DB_PASSWORD}@VM_IP_PLACEHOLDER:5432/cogni_operator"
DATABASE_SERVICE_URL="postgresql://${APP_DB_SERVICE_USER}:${APP_DB_SERVICE_PASSWORD}@VM_IP_PLACEHOLDER:5432/cogni_operator"

log_info "All secrets loaded from .env.${DEPLOY_ENV}"

# ══════════════════════════════════════════════════════════════
# Phase 3: Provision VM via OpenTofu
# ══════════════════════════════════════════════════════════════
log_step "Phase 3: Provision VM"

TFVARS="$PROVISION_DIR/terraform.${WORKSPACE}.tfvars"
cat > "$TFVARS" << EOF
environment          = "${DEPLOY_ENV}"
vm_name_prefix       = "cogni"
project_id           = "${CHERRY_PROJECT_ID}"
plan                 = "B1-6-6gb-100s-shared"
region               = "LT-Siauliai"
public_key_path      = "keys/cogni_${DEPLOY_ENV}_deploy.pub"
ghcr_deploy_username = "${GHCR_USERNAME}"
cogni_repo_url       = "${COGNI_REPO_URL}"
cogni_repo_ref       = "${COGNI_REPO_REF}"
EOF
log_info "Wrote $TFVARS"

# Pass empty SSH key to skip tofu's built-in health check (count = ssh_key != "" ? 1 : 0).
# Our Phase 4 loop handles the bootstrap wait more robustly (retries, SSH, progress).
export TF_VAR_ssh_private_key=""
export TF_VAR_ghcr_deploy_token="$GHCR_TOKEN"
export TF_VAR_sops_age_private_key="$AGE_PRIVATE_KEY"

cd "$PROVISION_DIR"

log_info "Initializing OpenTofu..."
tofu init -input=false

log_info "Selecting workspace: $WORKSPACE"
tofu workspace new "$WORKSPACE" 2>/dev/null || tofu workspace select "$WORKSPACE"

log_info "Planning..."
tofu plan -var-file="terraform.${WORKSPACE}.tfvars" -out=tfplan

echo ""
log_warn "About to provision a VM. This costs money and takes ~5 minutes."
if [[ "$AUTO_APPROVE" == "true" ]]; then
  log_info "Auto-approved (--yes flag)"
else
  echo -n "Proceed? [y/N] "
  read -r confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    log_info "Aborted."
    exit 0
  fi
fi

log_info "Applying..."
tofu apply tfplan

VM_IP=$(tofu output -raw vm_host)
log_info "VM provisioned at: $VM_IP"

# Save connection info (key already saved in phase 2)
echo "$VM_IP" > "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-ip"
echo "$AGE_PRIVATE_KEY" > "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-age-key"

# Fix DATABASE_URLs — replace placeholder with actual VM IP
# (pods can't use 127.0.0.1 — that's the pod's own loopback, not the host)
DATABASE_URL="${DATABASE_URL/VM_IP_PLACEHOLDER/$VM_IP}"
DATABASE_SERVICE_URL="${DATABASE_SERVICE_URL/VM_IP_PLACEHOLDER/$VM_IP}"
log_info "DATABASE_URLs updated with VM IP: $VM_IP"

cd "$REPO_ROOT"

SSH_KEY="$REPO_ROOT/.local/${DEPLOY_ENV}-vm-key"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=12"

# ══════════════════════════════════════════════════════════════
# Phase 4: Wait for cloud-init bootstrap
# ══════════════════════════════════════════════════════════════
# Clear stale host key — Cherry reuses IPs across VM recreations
ssh-keygen -R "$VM_IP" 2>/dev/null || true

log_step "Phase 4: Wait for bootstrap (~3-5 min)"

for attempt in $(seq 1 60); do
  if ssh $SSH_OPTS root@"$VM_IP" 'test -f /var/lib/cogni/bootstrap.ok' 2>/dev/null; then
    log_info "Bootstrap complete!"
    ssh $SSH_OPTS root@"$VM_IP" 'cat /var/lib/cogni/bootstrap.ok'
    break
  fi
  if ssh $SSH_OPTS root@"$VM_IP" 'test -f /var/lib/cogni/bootstrap.fail' 2>/dev/null; then
    log_error "Bootstrap FAILED:"
    ssh $SSH_OPTS root@"$VM_IP" 'cat /var/lib/cogni/bootstrap.fail; tail -50 /var/log/cogni-bootstrap.log'
    exit 1
  fi
  if [[ $attempt -eq 60 ]]; then
    log_error "Bootstrap did not complete after 10 minutes."
    log_error "SSH in to debug: ssh -i .local/${DEPLOY_ENV}-vm-key root@$VM_IP"
    exit 1
  fi
  # Show progress every 30s
  if (( attempt % 3 == 0 )); then
    log_info "  Waiting... (${attempt}0s elapsed)"
  fi
  sleep 10
done

# Quick verification
log_info "Verifying k3s + Argo CD..."
ssh $SSH_OPTS root@"$VM_IP" 'kubectl get nodes && echo "---" && kubectl -n argocd get pods --no-headers'

# ApplicationSets applied in Phase 7 (after all prerequisites are in place)

# ══════════════════════════════════════════════════════════════
# Phase 4b: Create/update DNS records
# ══════════════════════════════════════════════════════════════
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] && [[ -n "${CLOUDFLARE_ZONE_ID:-}" ]]; then
  log_step "Phase 4b: Create DNS records"
  # Derive subdomains from domain vars (e.g., test.cognidao.org → test).
  # Cogni writes only its own public domains plus its repo-scoped VM alias.
  for fqdn in "${DNS_RECORDS[@]}"; do
    sub="${fqdn%.${COGNI_DOMAIN_ROOT}}"  # Strip zone suffix to get subdomain
    # Delete existing A records for this subdomain
    EXISTING=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=${fqdn}&type=A" \
      | python3 -c "import json,sys; [print(x['id']) for x in json.load(sys.stdin).get('result',[])]" 2>/dev/null)
    for id in $EXISTING; do
      curl -s -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$id" >/dev/null
    done
    # Create new A record
    RESULT=$(curl -s -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
      -d "{\"type\":\"A\",\"name\":\"${sub}\",\"content\":\"${VM_IP}\",\"ttl\":300,\"proxied\":false}")
    OK=$(echo "$RESULT" | python3 -c 'import json,sys; print("OK" if json.load(sys.stdin).get("success") else "FAIL")' 2>/dev/null)
    log_info "  ${fqdn} → ${VM_IP}: $OK"
  done
else
  log_warn "Skipping DNS — CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID not set"
fi

# WARNING: Caddy (Phase 5) will attempt Let's Encrypt ACME HTTP-01 challenges
# immediately on startup. If DNS hasn't globally propagated by then, ACME fails
# and burns through the 5-failures-per-hostname-per-hour rate limit. Certs won't
# issue until the hourly window resets. See .claude/skills/dns-ops/SKILL.md.

# ══════════════════════════════════════════════════════════════
# Phase 4c: Seed per-app deploy branches with fresh VM state
# ══════════════════════════════════════════════════════════════
log_step "Phase 4c: Seed per-app deploy branches with $VM_IP"

# deploy/<env>-<app> branches are Argo's source of truth for rendered app
# state. Provision is the one writer for env-discovered VM state and must seed
# these branches before applying the ApplicationSet, otherwise a fresh cluster
# can sync stale ExternalName targets from pre-split branches.
REPO_URL="https://${GHCR_USERNAME:-Cogni-1729}:${GHCR_TOKEN}@github.com/Cogni-DAO/cogni.git"

for app in "${COGNI_APP_TARGETS[@]}"; do
  DEPLOY_BRANCH="deploy/${DEPLOY_ENV}-${app}"
  DEPLOY_TMP=$(mktemp -d)

  log_info "Cloning $DEPLOY_BRANCH..."
  if ! git clone --depth=1 --branch "$DEPLOY_BRANCH" "$REPO_URL" "$DEPLOY_TMP" 2>/dev/null; then
    log_error "Missing deploy branch: $DEPLOY_BRANCH"
    log_error "Run the deploy-branch bootstrap for ${DEPLOY_ENV}/${app} before provisioning."
    exit 1
  fi

  rm -rf \
    "$DEPLOY_TMP/infra/k8s/base" \
    "$DEPLOY_TMP/infra/k8s/overlays/${OVERLAY_DIR}/${app}" \
    "$DEPLOY_TMP/infra/catalog/${app}.yaml"
  mkdir -p \
    "$DEPLOY_TMP/infra/k8s/overlays/${OVERLAY_DIR}" \
    "$DEPLOY_TMP/infra/catalog"
  cp -R "$REPO_ROOT/infra/k8s/base" "$DEPLOY_TMP/infra/k8s/base"
  cp -R "$REPO_ROOT/infra/k8s/overlays/${OVERLAY_DIR}/${app}" "$DEPLOY_TMP/infra/k8s/overlays/${OVERLAY_DIR}/${app}"
  cp "$REPO_ROOT/infra/catalog/${app}.yaml" "$DEPLOY_TMP/infra/catalog/${app}.yaml"

  cat > "$DEPLOY_TMP/infra/k8s/overlays/${OVERLAY_DIR}/${app}/env-state.yaml" <<EOF
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Per-overlay VM truth — written by provision only (bug.0334).
apiVersion: v1
kind: ConfigMap
metadata:
  name: env-state
  annotations:
    config.kubernetes.io/local-config: "true"
data:
  VM_IP: "${VM_IP}"
EOF

  cd "$DEPLOY_TMP"
  git config user.name "provision-script"
  git config user.email "provision@cogni.dev"
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "chore(infra): seed ${DEPLOY_ENV}/${app} for VM ${VM_IP} [provision]"
    git push origin "$DEPLOY_BRANCH"
    log_info "Seeded $DEPLOY_BRANCH"
  else
    log_info "$DEPLOY_BRANCH already seeded"
  fi
  rm -rf "$DEPLOY_TMP"
  cd "$REPO_ROOT"
done

# ══════════════════════════════════════════════════════════════
# Phase 5: Deploy Compose infrastructure
# ══════════════════════════════════════════════════════════════
log_step "Phase 5: Deploy Compose infrastructure"

# Upload files
log_info "Uploading Compose files..."
ssh $SSH_OPTS root@"$VM_IP" 'mkdir -p /opt/cogni-template-edge/configs /opt/cogni-template-runtime/configs /opt/cogni-template-runtime/postgres-init /opt/cogni-template-runtime/litellm-image'

# Edge stack
scp $SSH_OPTS "$REPO_ROOT/infra/compose/edge/docker-compose.yml" root@"$VM_IP":/opt/cogni-template-edge/docker-compose.yml
scp $SSH_OPTS "$CADDYFILE_TEMPLATE" root@"$VM_IP":/opt/cogni-template-edge/configs/Caddyfile.tmpl

# Runtime stack
scp $SSH_OPTS "$REPO_ROOT/infra/compose/runtime/docker-compose.yml" root@"$VM_IP":/opt/cogni-template-runtime/docker-compose.yml
scp $SSH_OPTS "$REPO_ROOT/infra/compose/runtime/configs/litellm.config.yaml" root@"$VM_IP":/opt/cogni-template-runtime/configs/litellm.config.yaml
scp $SSH_OPTS "$REPO_ROOT/infra/compose/runtime/configs/temporal-dynamicconfig.yaml" root@"$VM_IP":/opt/cogni-template-runtime/configs/temporal-dynamicconfig.yaml
scp $SSH_OPTS "$REPO_ROOT/infra/compose/runtime/postgres-init/provision.sh" root@"$VM_IP":/opt/cogni-template-runtime/postgres-init/provision.sh

# LiteLLM custom image
scp $SSH_OPTS "$REPO_ROOT/infra/images/litellm/Dockerfile" root@"$VM_IP":/opt/cogni-template-runtime/litellm-image/Dockerfile
scp $SSH_OPTS "$REPO_ROOT/infra/images/litellm/cogni_callbacks.py" root@"$VM_IP":/opt/cogni-template-runtime/litellm-image/cogni_callbacks.py

# Write .env files
log_info "Writing .env files..."

ssh $SSH_OPTS root@"$VM_IP" "cat > /opt/cogni-template-edge/.env << 'ENVEOF'
DOMAIN=${DOMAIN}
RESY_DOMAIN=${RESY_DOMAIN}
OPERATOR_UPSTREAM=host.docker.internal:30000
RESY_UPSTREAM=host.docker.internal:30300
ENVEOF"

# All required vars must be in .env — Docker Compose validates ALL services at parse time,
# even when only starting specific ones. Services we won't start get placeholder values.
ssh $SSH_OPTS root@"$VM_IP" "cat > /opt/cogni-template-runtime/.env << 'ENVEOF'
# Infra services (actually used)
APP_ENV=${APP_ENV}
DEPLOY_ENVIRONMENT=${DEPLOY_ENVIRONMENT}
POSTGRES_ROOT_USER=${POSTGRES_ROOT_USER}
POSTGRES_ROOT_PASSWORD=${POSTGRES_ROOT_PASSWORD}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}
TEMPORAL_DB_USER=${TEMPORAL_DB_USER}
TEMPORAL_DB_PASSWORD=${TEMPORAL_DB_PASSWORD}
COGNI_NODE_DBS=${COGNI_NODE_DBS}
LITELLM_DB_NAME=${LITELLM_DB_NAME}
APP_DB_USER=${APP_DB_USER}
APP_DB_PASSWORD=${APP_DB_PASSWORD}
APP_DB_SERVICE_USER=${APP_DB_SERVICE_USER}
APP_DB_SERVICE_PASSWORD=${APP_DB_SERVICE_PASSWORD}
APP_DB_READONLY_USER=${APP_DB_READONLY_USER}
APP_DB_READONLY_PASSWORD=${APP_DB_READONLY_PASSWORD:-}
COGNI_NODE_ENDPOINTS=${COGNI_NODE_ENDPOINTS}
BILLING_INGEST_TOKEN=${BILLING_INGEST_TOKEN}
# Observability — Alloy log/metric shipping to Grafana Cloud
LOKI_WRITE_URL=${LOKI_WRITE_URL:-}
LOKI_USERNAME=${LOKI_USERNAME:-}
LOKI_PASSWORD=${LOKI_PASSWORD:-}
PROMETHEUS_REMOTE_WRITE_URL=${PROMETHEUS_REMOTE_WRITE_URL:-}
PROMETHEUS_USERNAME=${PROMETHEUS_USERNAME:-}
PROMETHEUS_PASSWORD=${PROMETHEUS_PASSWORD:-}
# App service vars (placeholders — services not started, but compose validates all)
AUTH_SECRET=${AUTH_SECRET}
EVM_RPC_URL=${EVM_RPC_URL}
DATABASE_URL=${DATABASE_URL}
DATABASE_SERVICE_URL=${DATABASE_SERVICE_URL}
POSTHOG_API_KEY=${POSTHOG_API_KEY}
POSTHOG_HOST=${POSTHOG_HOST}
OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
OPENCLAW_GITHUB_RW_TOKEN=placeholder-not-started
SCHEDULER_WORKER_IMAGE=placeholder:not-started
MIGRATOR_IMAGE=placeholder:not-started
APP_IMAGE=placeholder:not-started
APP_BASE_URL=https://${DOMAIN}
COGNI_REPO_URL=${COGNI_REPO_URL}
COGNI_REPO_REF=${COGNI_REPO_REF}
ENVEOF"

# Start services
log_info "Creating cogni-edge network..."
ssh $SSH_OPTS root@"$VM_IP" 'docker network create cogni-edge 2>/dev/null || true'

log_info "Building LiteLLM custom image (retry up to 3x — base image is ~1.2GB)..."
for attempt in 1 2 3; do
  if ssh $SSH_OPTS root@"$VM_IP" 'docker build -t cogni-litellm:latest /opt/cogni-template-runtime/litellm-image/' 2>&1; then
    log_info "LiteLLM image built"
    break
  fi
  if [[ $attempt -eq 3 ]]; then
    log_error "LiteLLM build failed after 3 attempts"
    exit 1
  fi
  log_warn "LiteLLM build failed (attempt $attempt/3), retrying in 10s..."
  sleep 10
done

log_info "Starting edge stack (Caddy)..."
ssh $SSH_OPTS root@"$VM_IP" 'docker compose --project-name cogni-edge --env-file /opt/cogni-template-edge/.env -f /opt/cogni-template-edge/docker-compose.yml up -d'

log_info "Starting infra services (postgres, temporal, litellm, redis)..."
ssh $SSH_OPTS root@"$VM_IP" 'docker compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml up -d --no-build postgres temporal-postgres temporal redis litellm autoheal'

# Wait for postgres
log_info "Waiting for postgres to become healthy..."
for i in $(seq 1 30); do
  if ssh $SSH_OPTS root@"$VM_IP" 'docker compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml ps postgres --format "{{.Health}}"' 2>/dev/null | grep -q "healthy"; then
    log_info "Postgres is healthy"
    break
  fi
  if [[ $i -eq 30 ]]; then
    log_error "Postgres did not become healthy after 60s"
    ssh $SSH_OPTS root@"$VM_IP" 'docker compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml logs postgres --tail 30'
    exit 1
  fi
  sleep 2
done

# DB provisioning
log_info "Running database provisioning..."
ssh $SSH_OPTS root@"$VM_IP" 'docker compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml run --rm db-provision'

# Temporal namespace bootstrap (idempotent — same script used by deploy-infra.sh)
log_info "Ensuring Temporal namespace exists..."
scp $SSH_OPTS "$REPO_ROOT/scripts/ci/ensure-temporal-namespace.sh" root@"$VM_IP":/tmp/ensure-temporal-namespace.sh
ssh $SSH_OPTS root@"$VM_IP" "TEMPORAL_NAMESPACE=cogni-${DEPLOY_ENV} TEMPORAL_CONTAINER=cogni-runtime-temporal-1 TEMPORAL_TIMEOUT=60 bash /tmp/ensure-temporal-namespace.sh"

# ══════════════════════════════════════════════════════════════
# Phase 6: Create k8s secrets directly on cluster
# ══════════════════════════════════════════════════════════════
log_step "Phase 6: Create k8s secrets on cluster"

# Create namespace (Argo CD creates it on first sync, but secrets need it now)
ssh $SSH_OPTS root@"$VM_IP" "kubectl create namespace ${K8S_NAMESPACE} 2>/dev/null || true"

# Node-app secrets — one per Cogni node (operator, resy)
# The Deployment references secretRef: {namePrefix}-node-app-secrets
for node in operator resy; do
  case $node in
    operator) db_name="cogni_operator" ;;
    resy)     db_name="cogni_resy" ;;
  esac

  NODE_DB_URL="postgresql://${APP_DB_USER}:${APP_DB_PASSWORD}@${VM_IP}:5432/${db_name}?sslmode=disable"
  NODE_DB_SERVICE_URL="postgresql://${APP_DB_SERVICE_USER}:${APP_DB_SERVICE_PASSWORD}@${VM_IP}:5432/${db_name}?sslmode=disable"

  ssh $SSH_OPTS root@"$VM_IP" "kubectl -n ${K8S_NAMESPACE} create secret generic ${node}-node-app-secrets \
    --from-literal=DATABASE_URL='${NODE_DB_URL}' \
    --from-literal=DATABASE_SERVICE_URL='${NODE_DB_SERVICE_URL}' \
    --from-literal=AUTH_SECRET='${AUTH_SECRET}' \
    --from-literal=LITELLM_MASTER_KEY='${LITELLM_MASTER_KEY}' \
    --from-literal=OPENROUTER_API_KEY='${OPENROUTER_API_KEY}' \
    --from-literal=EVM_RPC_URL='${EVM_RPC_URL}' \
    --from-literal=POSTHOG_API_KEY='${POSTHOG_API_KEY}' \
    --from-literal=POSTHOG_HOST='${POSTHOG_HOST}' \
    --from-literal=OPENCLAW_GATEWAY_TOKEN='${OPENCLAW_GATEWAY_TOKEN}' \
    --from-literal=OPENCLAW_GITHUB_RW_TOKEN='placeholder-not-needed-for-test' \
    --from-literal=SCHEDULER_API_TOKEN='${SCHEDULER_API_TOKEN}' \
    --from-literal=BILLING_INGEST_TOKEN='${BILLING_INGEST_TOKEN}' \
    --from-literal=INTERNAL_OPS_TOKEN='${INTERNAL_OPS_TOKEN}' \
    --from-literal=METRICS_TOKEN='${METRICS_TOKEN}' \
    --dry-run=client -o yaml | kubectl apply -f -"
  log_info "  Created ${node}-node-app-secrets"
done

# Scheduler-worker secret
# NOTE: COGNI_NODE_ENDPOINTS and COGNI_NODE_DBS belong in the configmap (set
# by Kustomize overlay), NOT here. Putting them in the secret shadows the
# configmap value (envFrom order: configmap first, secret second → secret wins)
# and caused CrashLoopBackOff when the secret had UUID-only keys without
# "operator=" named entry. See scorecard row 20.
ssh $SSH_OPTS root@"$VM_IP" "kubectl -n ${K8S_NAMESPACE} create secret generic scheduler-worker-secrets \
  --from-literal=DATABASE_URL='${DATABASE_SERVICE_URL}' \
  --from-literal=SCHEDULER_API_TOKEN='${SCHEDULER_API_TOKEN}' \
  --from-literal=GH_REVIEW_APP_ID='${GH_REVIEW_APP_ID:-}' \
  --from-literal=GH_REVIEW_APP_PRIVATE_KEY_BASE64='${GH_REVIEW_APP_PRIVATE_KEY_BASE64:-}' \
  --from-literal=GH_WEBHOOK_SECRET='${GH_WEBHOOK_SECRET:-}' \
  --from-literal=INTERNAL_OPS_TOKEN='${INTERNAL_OPS_TOKEN}' \
  --dry-run=client -o yaml | kubectl apply -f -"
log_info "  Created scheduler-worker-secrets"

# Sandbox-openclaw secret (placeholder)
ssh $SSH_OPTS root@"$VM_IP" "kubectl -n ${K8S_NAMESPACE} create secret generic sandbox-openclaw-secrets \
  --from-literal=OPENCLAW_GATEWAY_TOKEN='${OPENCLAW_GATEWAY_TOKEN}' \
  --from-literal=OPENCLAW_GITHUB_RW_TOKEN='placeholder-not-needed-for-test' \
  --from-literal=LITELLM_MASTER_KEY='${LITELLM_MASTER_KEY}' \
  --from-literal=DISCORD_BOT_TOKEN='placeholder' \
  --dry-run=client -o yaml | kubectl apply -f -"
log_info "  Created sandbox-openclaw-secrets"

log_info "All k8s secrets created"

# ══════════════════════════════════════════════════════════════
# Phase 7: Deployment Status Report (Scorecard)
# ══════════════════════════════════════════════════════════════
# ══════════════════════════════════════════════════════════════
# Phase 7: Apply ApplicationSets (LAST — all prerequisites ready)
# ══════════════════════════════════════════════════════════════
log_step "Phase 7: Apply ApplicationSets (triggers Argo sync)"

# Gate: verify prerequisites exist before enabling Argo sync
ssh $SSH_OPTS root@"$VM_IP" "
  kubectl -n ${K8S_NAMESPACE} get secret operator-node-app-secrets >/dev/null || { echo 'FATAL: operator secrets missing'; exit 1; }
  kubectl -n ${K8S_NAMESPACE} get secret resy-node-app-secrets >/dev/null || { echo 'FATAL: resy secrets missing'; exit 1; }
  kubectl -n ${K8S_NAMESPACE} get secret scheduler-worker-secrets >/dev/null || { echo 'FATAL: scheduler-worker secrets missing'; exit 1; }
  echo 'All prerequisite secrets verified'
"

# Apply the ApplicationSet for this environment via SCP from the local repo checkout.
# Bootstrap cloud-init already installed Argo CD. Re-applying the full install conflicts.
#
# Why SCP instead of git clone? The ApplicationSet files live in infra/k8s/argocd/ which
# may not exist on the target branch yet (e.g. staging/main lag behind canary). The
# operator's local checkout is the source of truth — it has the files they intend to deploy.
# This also avoids the chicken-and-egg: you can provision preview before the files are
# promoted to staging.
APPSET_LOCAL="$REPO_ROOT/infra/k8s/argocd/${APPSET_FILE}"
if [ ! -f "$APPSET_LOCAL" ]; then
  log_error "ApplicationSet file not found locally: $APPSET_LOCAL"
  log_error "Run this script from the repo root on a branch that has infra/k8s/argocd/"
  exit 1
fi

scp $SSH_OPTS "$APPSET_LOCAL" root@"$VM_IP":/tmp/appset.yaml
ssh $SSH_OPTS root@"$VM_IP" "
  kubectl apply -f /tmp/appset.yaml -n argocd
  rm -f /tmp/appset.yaml
  echo 'ApplicationSet applied: ${APPSET_FILE} — Argo syncing from deploy/* branches'
"

# Poll for apps to sync (up to 5 min)
log_info "Waiting for Argo to sync apps..."
for attempt in $(seq 1 30); do
  HEALTHY=$(ssh $SSH_OPTS root@"$VM_IP" 'kubectl -n argocd get applications -o jsonpath="{range .items[*]}{.status.health.status}{\" \"}{end}"' 2>/dev/null)
  HEALTHY_COUNT=$(echo "$HEALTHY" | tr ' ' '\n' | grep -c "Healthy" || true)
  TOTAL=$(echo "$HEALTHY" | tr ' ' '\n' | grep -c '.' || true)
  log_info "  Apps healthy: ${HEALTHY_COUNT}/${TOTAL} (${attempt}0s)"
  if [[ "$HEALTHY_COUNT" -ge 3 ]]; then
    log_info "Core apps healthy!"
    break
  fi
  if [[ $attempt -eq 30 ]]; then
    log_warn "Timeout waiting for apps — check scorecard for details"
  fi
  sleep 10
done

# ══════════════════════════════════════════════════════════════
# Phase 8: Deployment Status Report
# ══════════════════════════════════════════════════════════════
log_step "Phase 8: Deployment Status Report"

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  DEPLOYMENT STATUS REPORT"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "  Environment: ${APP_ENV} | VM: ${VM_IP} | Plan: B1-6-6gb-100s-shared"
echo "  Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  Branch: ${BRANCH}"
echo ""

# Docker Compose services
echo "── Compose Infrastructure ──────────────────────────────────────"
ssh $SSH_OPTS root@"$VM_IP" 'docker compose --project-name cogni-runtime --env-file /opt/cogni-template-runtime/.env -f /opt/cogni-template-runtime/docker-compose.yml ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"' 2>/dev/null || echo "(failed to query)"
echo ""

echo "── Edge (Caddy) ────────────────────────────────────────────────"
ssh $SSH_OPTS root@"$VM_IP" 'docker compose --project-name cogni-edge --env-file /opt/cogni-template-edge/.env -f /opt/cogni-template-edge/docker-compose.yml ps --format "table {{.Name}}\t{{.Status}}"' 2>/dev/null || echo "(failed to query)"
echo ""

# Host port bindings (k3s bridge)
echo "── k3s Bridge Ports ────────────────────────────────────────────"
for port in 5432 7233 4000 6379; do
  if ssh $SSH_OPTS root@"$VM_IP" "ss -tlnp | grep -q ':${port} '" 2>/dev/null; then
    echo "  Port $port: [UP]"
  else
    echo "  Port $port: [DOWN]"
  fi
done
echo ""

# k3s + Argo CD
echo "── k3s Cluster ─────────────────────────────────────────────────"
ssh $SSH_OPTS root@"$VM_IP" 'kubectl get nodes 2>/dev/null' || echo "(not ready)"
echo ""

echo "── Argo CD Applications ────────────────────────────────────────"
ssh $SSH_OPTS root@"$VM_IP" 'kubectl -n argocd get applications -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status 2>/dev/null' || echo "(not ready)"
echo ""

echo "── k8s Pods (${K8S_NAMESPACE}) ────────────────────────────────────"
ssh $SSH_OPTS root@"$VM_IP" "kubectl -n ${K8S_NAMESPACE} get pods 2>/dev/null" || echo "(namespace not created yet — Argo CD will create it on first sync)"
echo ""

echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "  SSH:     ssh -i .local/${DEPLOY_ENV}-vm-key root@$VM_IP"
echo "  Secrets: .env.${DEPLOY_ENV}"
echo ""
echo "  Next steps:"
echo "    1. Push this branch so Argo CD can find catalog + overlay files"
echo "    2. Argo CD will auto-sync within 3 minutes"
echo "    3. Re-run scorecard: ssh -i .local/${DEPLOY_ENV}-vm-key root@\$VM_IP 'kubectl -n argocd get applications'"
echo "    4. k8s secrets already created directly on cluster (no SOPS needed for test)"
echo ""
echo "  Destroy when done:"
echo "    cd infra/provision/cherry/base && tofu workspace select ${WORKSPACE} && tofu destroy -var-file=terraform.${WORKSPACE}.tfvars"
echo ""

# ══════════════════════════════════════════════════════════════
# Phase 9: Verify /readyz on all nodes (exit code = green/red)
# ══════════════════════════════════════════════════════════════
log_step "Phase 9: Verify /readyz on all nodes (up to 5 min)"

READYZ_OK=true
for node_port in 30000 30300; do
  NODE_OK=false
  for attempt in $(seq 1 30); do
    STATUS=$(ssh $SSH_OPTS root@"$VM_IP" "curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 http://localhost:${node_port}/readyz" 2>/dev/null || echo "000")
    if [[ "$STATUS" == "200" ]]; then
      log_info "  Port ${node_port}: /readyz 200 ✅"
      NODE_OK=true
      break
    fi
    if (( attempt % 6 == 0 )); then
      log_info "  Port ${node_port}: waiting... (${attempt}0s, last status: ${STATUS})"
    fi
    sleep 10
  done
  if [[ "$NODE_OK" != "true" ]]; then
    log_error "  Port ${node_port}: /readyz FAILED after 5 min ❌"
    READYZ_OK=false
  fi
done

echo ""
if [[ "$READYZ_OK" == "true" ]]; then
  log_info "═══ ALL COGNI NODES HEALTHY — ${DEPLOY_ENV} IS GREEN ═══"
  exit 0
else
  log_error "═══ SOME COGNI NODES FAILED /readyz — ${DEPLOY_ENV} IS RED ═══"
  log_error "Debug: ssh -i .local/${DEPLOY_ENV}-vm-key root@$VM_IP 'kubectl -n ${K8S_NAMESPACE} logs -l app.kubernetes.io/name=node-app --tail=20'"
  exit 1
fi
