#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/setup/provision-env-vm.sh
# Purpose: One-command VM provisioning + infra deployment + scorecard.
#          Generates ALL secrets (same generators as setup-secrets.ts), provisions
#          via OpenTofu, deploys Compose infra, verifies k3s + Argo CD.
# Usage:
#   CHERRY_AUTH_TOKEN=<token> bash scripts/setup/provision-env-vm.sh preview
#   CHERRY_AUTH_TOKEN=<token> bash scripts/setup/provision-env-vm.sh production
#   CHERRY_AUTH_TOKEN=<token> DOMAIN=test.cognidao.org \
#     bash scripts/setup/provision-env-vm.sh candidate-a
#   CHERRY_AUTH_TOKEN=<token> bash scripts/setup/provision-env-vm.sh candidate-b
# Environments:
#   preview, production     — long-lived post-merge lanes
#   candidate-*             — pre-merge slots (candidate-a, candidate-b, ...).
#                             Requires matching infra/k8s/argocd/
#                             ${slot}-applicationset.yaml and
#                             infra/k8s/overlays/${slot}/*. DNS defaults to
#                             ${slot}.cognidao.org; pass DOMAIN=... to override
#                             (candidate-a inherits test.cognidao.org from the
#                             retired canary env).

set -euo pipefail

# Bash 4+ preflight — uses `mapfile`/associative arrays via image-tags.sh.
# macOS Bash 3.2 fails opaquely 100s of lines in; fail clean here instead.
# Canonical fix is the installer wrapper; bootstrap.sh also checks but this
# guards direct invocation.
if (( BASH_VERSINFO[0] < 4 )); then
  printf 'provision-env-vm.sh requires Bash 4+ (current: %s).\n' "$BASH_VERSION" >&2
  printf 'Install via: bash scripts/bootstrap/install/install-bash.sh\n' >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROVISION_DIR="$REPO_ROOT/infra/provision/cherry/base"

# shellcheck source=./scripts/setup/lib/fork-identity.sh
source "$SCRIPT_DIR/lib/fork-identity.sh"

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
  echo "Usage: provision-env-vm.sh <preview|production|candidate-*> [--yes]"
  echo ""
  echo "  preview       — preview.cognidao.org"
  echo "  production    — cognidao.org"
  echo "  candidate-a   — test.cognidao.org (pass DOMAIN=test.cognidao.org)"
  echo "  candidate-b   — candidate-b.cognidao.org (or pass DOMAIN)"
  echo "  --yes         — skip confirmation prompt (for CI/automation)"
  exit 1
fi

case "$DEPLOY_ENV" in
  preview|production)
    BRANCH="main"
    DEPLOY_BRANCH="deploy/${DEPLOY_ENV}"
    K8S_NAMESPACE="cogni-${DEPLOY_ENV}"
    OVERLAY_DIR="${DEPLOY_ENV}"
    APPSET_FILE="${DEPLOY_ENV}-applicationset.yaml"
    WORKSPACE="${DEPLOY_ENV}"
    ;;
  candidate-*)
    # Pre-merge candidate slots. All fields derive from ${DEPLOY_ENV} so
    # spinning up candidate-b, candidate-c, ... only needs (1) a matching
    # infra/k8s/argocd/${slot}-applicationset.yaml and (2) a matching
    # infra/k8s/overlays/${slot}/ overlay tree. DNS + DOMAIN come from
    # FORK_DOMAIN_ROOT env var composed with the convention below.
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

# Public DOMAIN derives from the FORK_DOMAIN_ROOT env var (GH repo
# variable in the GHA path; exported shell var in the laptop fallback).
# VM_DNS_HOST always includes the fork slug so sibling repos under one
# Cloudflare zone do not share generic candidate-a.vm/preview.vm aliases.
# (B2 + P5 — replaces POLY_DOMAIN/RESY_DOMAIN hardcodes.)
FORK_ROOT="${FORK_DOMAIN_ROOT:-}"
if [ -z "$FORK_ROOT" ]; then
  echo "[ERROR] FORK_DOMAIN_ROOT is not set." >&2
  echo "[ERROR] Set the GitHub repo variable: gh variable set FORK_DOMAIN_ROOT --body <zone-name>" >&2
  echo "[ERROR] Or for laptop runs: export FORK_DOMAIN_ROOT=<zone-name>" >&2
  exit 1
fi
FORK_SLUG=$(fork_identity_slug "$REPO_ROOT")
if [ -z "$FORK_SLUG" ]; then
  echo "[ERROR] Unable to derive fork slug from FORK_SLUG env var or git origin." >&2
  exit 1
fi
VM_DNS_HOST=$(vm_host_for_env "$DEPLOY_ENV" "$FORK_ROOT" "$FORK_SLUG")
if [ -z "${DOMAIN:-}" ]; then
  DOMAIN=$(domain_for_env "$DEPLOY_ENV" "$FORK_ROOT")
fi

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
for cmd in tofu ssh-keygen age-keygen openssl yq git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "Required: $cmd not found. Install it first (see scripts/bootstrap/install/)."
    exit 1
  fi
done

# Fork identity (B1 + B2). Source the catalog library to get NODE_TARGETS,
# then derive the fork's repo coordinates from origin. Both replace the
# Cogni-DAO/cogni + operator|poly|resy hardcodes the canary tripped on.
# shellcheck source=../ci/lib/image-tags.sh
. "$REPO_ROOT/scripts/ci/lib/image-tags.sh"

GH_REPO=$(git -C "$REPO_ROOT" remote get-url origin \
  | sed -E 's#.*github.com[:/]([^/]+/[^/.]+).*#\1#')
if [[ -z "$GH_REPO" || "$GH_REPO" =~ ^Cogni-DAO/(cogni|node-template)$ ]]; then
  log_error "origin points at the upstream template ($GH_REPO) or is undetectable."
  log_error "provision-env-vm.sh must run inside a fork (the bootstrap pushes deploy state to origin)."
  exit 1
fi
log_info "Fork repo: $GH_REPO"
log_info "Nodes:     ${NODE_TARGETS[*]}"

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

# SSH keypair — per-VM, uploaded to Cherry, saved to .local/.
# On the GHA runner the "Restore prior init-artifact keys" step in
# .github/workflows/provision-env.yml decrypts the prior run's vm-key
# into .local/ BEFORE this script runs, so re-runs reuse the same public
# key and tofu's Cherry SSH resource stays idempotent. Fresh-fork +
# fresh-env runs (no prior artifact / expired retention) fall through
# to the else-branch and generate a new keypair.
if [[ -f "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-key" ]]; then
  log_info "Reusing existing SSH key from .local/${DEPLOY_ENV}-vm-key"
  # Rehydrate .pub from the private key — tofu's `file(var.public_key_path)`
  # reads it during plan, and the encrypted init-artifact only carries
  # the private half.
  ssh-keygen -y -f "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-key" \
    > "$PROVISION_DIR/keys/cogni_${DEPLOY_ENV}_deploy.pub"
else
  TMPDIR=$(mktemp -d)
  log_info "Generating ephemeral SSH keypair (GHA runner — no laptop .local/ state)"
  ssh-keygen -t ed25519 -f "$TMPDIR/deploy_key" -C "cogni-${DEPLOY_ENV}-vm" -N "" -q
  cp "$TMPDIR/deploy_key.pub" "$PROVISION_DIR/keys/cogni_${DEPLOY_ENV}_deploy.pub"
  cp "$TMPDIR/deploy_key" "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-key"
  chmod 600 "$REPO_ROOT/.local/${DEPLOY_ENV}-vm-key"
fi

# SOPS age keypair — per-VM. Same restore-on-rerun path as the SSH key above.
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

# Per-node databases derive from NODE_TARGETS (B2). Hyphens → underscores
# for postgres-name legality: node-template → cogni_node_template.
# Exported because Phase 5f invokes deploy-infra.sh via an explicit env
# prefix that forwards only a fixed subset; db-provision container reads
# COGNI_NODE_DBS from the VM's runtime/.env and aborts if empty.
export COGNI_NODE_DBS=$(IFS=','; printf '%s' "${NODE_TARGETS[*]/#/cogni_}" | sed 's/-/_/g')
LITELLM_DB_NAME="litellm"
# Primary node DB (first NODE_TARGETS entry) — used for DATABASE_URL defaults
# before per-node secrets are written in Phase 6. Each node gets its own DB
# scoped secret there.
PRIMARY_NODE_DB="cogni_${NODE_TARGETS[0]//-/_}"

# EVM RPC — use public Base mainnet endpoint for test
EVM_RPC_URL="${EVM_RPC_URL:-https://mainnet.base.org}"
# Polygon RPC — optional; poly-node reads fall back to viem default (public
# polygon-rpc.com, often tenant-rate-limited). Pass a real Alchemy/QuickNode
# URL via env to unblock /api/v1/poly/wallet/balance on candidate-a.
POLYGON_RPC_URL="${POLYGON_RPC_URL:-}"

# PostHog — use placeholder (app logs warning but starts)
POSTHOG_API_KEY="${POSTHOG_API_KEY:-phc_placeholder_test}"
POSTHOG_HOST="${POSTHOG_HOST:-https://us.i.posthog.com}"

# Repo URL/ref for git-sync — derive from origin (B1: never hardcode upstream).
COGNI_REPO_URL="https://github.com/${GH_REPO}.git"
COGNI_REPO_REF="$BRANCH"

# LiteLLM node endpoints — billing callback routing (Compose→k8s NodePorts
# via the host gateway). Per-node `node_id` MUST match what the running pod
# reads via getNodeId() at runtime, OR per-node Temporal task queues drift:
#   - app submits to `scheduler-tasks-${app.nodeId}`
#   - worker polls `scheduler-tasks-${endpoints.nodeId}`
#   - drift = every chat request hangs 126s (handler-side timeout) then 500
#
# The pod reads `/app/.cogni/repo-spec.yaml::node_id` (Dockerfile L110 copies
# top-level `.cogni/` for node-template; per-node `.cogni/` for monorepo
# nodes). Provision MUST read the same source.
#
# Identity-inheritance check (cross-tenant safety): forks that inherit
# upstream's `.cogni/repo-spec.yaml` ALSO inherit upstream's DAO contracts,
# operator_wallet.address, activity_ledger.approvers, and payments.* — meaning
# the fork's deployment would route governance/payments to upstream's wallets.
# Hard-fail when we detect either (a) the placeholder UUID or (b) upstream's
# known sentinel UUID, with a pointer to the mint script.
#
# Format: <key>=<billing-ingest-url>,... — both `name` and `node_id` are
# included as keys to match the scheduler-worker ConfigMap convention
# (services/scheduler-worker resolves either form).
PLACEHOLDER_NODE_ID="00000000-0000-4000-a000-000000000000"
# Upstream Cogni-DAO/node-template's committed node_id. Forks that haven't
# minted their own inherit this. Bumped here in lockstep when upstream rotates.
UPSTREAM_NODE_ID="4ff8eac1-4eba-4ed0-931b-b1fe4f64713d"
COGNI_NODE_ENDPOINTS_PARTS=()
for node in "${NODE_TARGETS[@]}"; do
  per_node_spec="$REPO_ROOT/nodes/${node}/.cogni/repo-spec.yaml"
  top_level_spec="$REPO_ROOT/.cogni/repo-spec.yaml"
  # Resolution: per-node first (monorepo case), top-level fallback (single-node
  # fork case — what the Dockerfile bakes). See PR #61.
  nid=""
  spec_source=""
  if [[ -f "$per_node_spec" ]]; then
    nid=$(yq -N '.node_id // ""' "$per_node_spec")
    spec_source="$per_node_spec"
  fi
  if [[ -z "$nid" || "$nid" == "null" || "$nid" == "$PLACEHOLDER_NODE_ID" ]]; then
    nid=$(yq -N '.node_id // ""' "$top_level_spec")
    spec_source="$top_level_spec"
  fi
  if [[ -z "$nid" || "$nid" == "null" || "$nid" == "$PLACEHOLDER_NODE_ID" ]]; then
    log_error "node_id for '${node}' is empty/placeholder."
    log_error "  per-node spec: $per_node_spec"
    log_error "  top-level spec: $top_level_spec"
    log_error ""
    log_error "Generate your fork's identity via the operator DAO setup wizard:"
    log_error "  https://cognidao.org/setup/dao"
    log_error "Then commit the generated .cogni/repo-spec.yaml to this fork's main + re-run."
    log_error "(Runbook step: docs/runbooks/fork-quickstart.md §4.5)"
    exit 2
  fi
  # Upstream-inheritance check: a fork running with upstream's UUID is also
  # running with upstream's DAO/wallet/payments — cross-tenant leak, not a
  # usable deployment. Skip if origin IS Cogni-DAO/node-template (upstream's
  # own canary deployment is the only legitimate user of this UUID).
  if [[ "$nid" == "$UPSTREAM_NODE_ID" ]]; then
    origin_url=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")
    if [[ "$origin_url" != *"Cogni-DAO/node-template"* ]]; then
      log_error "node_id for '${node}' equals upstream's UUID — your fork inherited"
      log_error "upstream's IDENTITY (DAO contracts, operator wallet, approvers, payments_in)."
      log_error "Deploying as-is would route real value through upstream's contracts."
      log_error "Origin: ${origin_url:-<unset>}"
      log_error ""
      log_error "Generate your fork's own identity via the operator DAO setup wizard:"
      log_error "  https://cognidao.org/setup/dao"
      log_error "Then commit the generated .cogni/repo-spec.yaml to this fork's main + re-run."
      log_error "(Runbook step: docs/runbooks/fork-quickstart.md §4.5)"
      exit 2
    fi
  fi
  np=$(yq -N '.node_port // 30000' "$REPO_ROOT/infra/catalog/${node}.yaml")
  url="http://host.docker.internal:${np}/api/internal/billing/ingest"
  COGNI_NODE_ENDPOINTS_PARTS+=("${node}=${url}")
  COGNI_NODE_ENDPOINTS_PARTS+=("${nid}=${url}")
  log_info "  node '${node}' → node_id=${nid} (from $(basename "$(dirname "$(dirname "$spec_source")")")/.cogni/)"
done
COGNI_NODE_ENDPOINTS=$(IFS=,; printf '%s' "${COGNI_NODE_ENDPOINTS_PARTS[*]}")
log_info "COGNI_NODE_ENDPOINTS (derived from repo-spec): ${COGNI_NODE_ENDPOINTS}"

# DATABASE_URLs (constructed from parts — same derivation as setup-secrets.ts)
# DATABASE_URLs use VM_IP placeholder — replaced after Phase 3 when IP is known.
# Inside k8s pods, 127.0.0.1 is the pod's loopback, NOT the host.
#
# sslmode=disable: the Postgres that backs the k8s app pods runs in the
# Compose-infra stack on the VM host (no in-cluster TLS termination). The
# postgres-js driver defaults to "prefer TLS"; against a non-TLS server it
# surfaces as a connect-time error and /readyz fails 503 on a cold-start.
# Forks that front Postgres with TLS (cert-manager + pgbouncer) override
# this seed value. Tracked in bug.0446 H10.
DATABASE_URL="postgresql://${APP_DB_USER}:${APP_DB_PASSWORD}@VM_IP_PLACEHOLDER:5432/${PRIMARY_NODE_DB}?sslmode=disable"
DATABASE_SERVICE_URL="postgresql://${APP_DB_SERVICE_USER}:${APP_DB_SERVICE_PASSWORD}@VM_IP_PLACEHOLDER:5432/${PRIMARY_NODE_DB}?sslmode=disable"

log_info "All secrets loaded from .env.${DEPLOY_ENV}"

# ══════════════════════════════════════════════════════════════
# Phase 3: Provision VM via OpenTofu
# ══════════════════════════════════════════════════════════════
log_step "Phase 3: Provision VM"

# Cherry SSH-key labels (and VM hostnames) derive from $GH_REPO so that
# multiple forks on the same Cherry account don't collide on the fixed
# `cogni-<env>-deploy` label. Earlier canary (v0 incident, 2026-05-17)
# deleted what looked like an orphan key but was actually load-bearing
# for a VM in a sibling project — Cherry SSH keys are ACCOUNT-scoped,
# not project-scoped. Per-fork namespacing eliminates the collision class.
#
# Cogni-DAO/node-template       → cogni-dao-node-template
# i-am-coco/cogni-node-20260517 → i-am-coco-cogni-node-20260517
VM_NAME_PREFIX=$(echo "${GH_REPO//\//-}" | tr '[:upper:]' '[:lower:]')
log_info "VM/SSH-key prefix: ${VM_NAME_PREFIX} (from \$GH_REPO=${GH_REPO})"

TFVARS="$PROVISION_DIR/terraform.${WORKSPACE}.tfvars"
cat > "$TFVARS" << EOF
environment          = "${DEPLOY_ENV}"
vm_name_prefix       = "${VM_NAME_PREFIX}"
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

# Re-run idempotency: adopt existing Cherry resources into tofu state.
# tfstate is ephemeral on the GHA runner (TODO: remote backend in
# main.tf:11), so without import tofu calls POST /v1/ssh-keys with the
# same label every time → Cherry returns `"key with this label already
# exists." (error code: 400)` (seen on i-am-coco fork run 26628927120).
# Importing both ssh_key + server keeps `ssh_key_ids` correlated; importing
# only one risks tofu wanting to replace the un-imported resource.
SSH_KEY_LABEL="${VM_NAME_PREFIX}-${DEPLOY_ENV}-deploy"
SERVER_HOSTNAME="${DEPLOY_ENV}-${VM_NAME_PREFIX}"
CHERRY_API="https://api.cherryservers.com/v1"

log_info "Probing Cherry for existing resources to adopt..."
# curl -f propagates HTTP errors through `set -e`. Without it, a 401/5xx
# returns a non-JSON body → jq empty → script proceeds as if no resource
# exists → tofu apply hits the original "label already exists" 400.
adopt() {  # adopt <tofu-address> <id-or-empty> <human-label>
  local addr="$1" id="$2" lbl="$3"
  [[ -z "$id" ]] && return 0
  log_info "Adopting Cherry $lbl (id=$id) into tofu state"
  tofu import -var-file="terraform.${WORKSPACE}.tfvars" "$addr" "$id"
}
EXISTING_KEY_ID=$(curl -fsS -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" \
  "${CHERRY_API}/ssh-keys" \
  | jq -r --arg lbl "$SSH_KEY_LABEL" '.[]? | select(.label == $lbl) | .id' \
  | head -1)
EXISTING_SERVER_ID=$(curl -fsS -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" \
  "${CHERRY_API}/projects/${CHERRY_PROJECT_ID}/servers" \
  | jq -r --arg h "$SERVER_HOSTNAME" '.[]? | select(.hostname == $h) | .id' \
  | head -1)
adopt cherryservers_ssh_key.key    "$EXISTING_KEY_ID"    "ssh_key '$SSH_KEY_LABEL'"
adopt cherryservers_server.server  "$EXISTING_SERVER_ID" "server '$SERVER_HOSTNAME'"

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
# ConnectTimeout=10 + ConnectionAttempts=1: bound the connect phase to 10s
# and refuse TCP SYN retries. Default OpenSSH retries SYN for ~2min before
# giving up, which on a dropped-packet network (Cherry VM still booting,
# firewall not yet open, transient ISP loss) causes the Phase 4 wait loop
# to silently consume the workflow's full 60-min budget — exactly the
# failure signature on PR #46's first validator run
# (https://github.com/i-am-coco/node-template/actions/runs/26473976287,
# 60-min wall-clock = timeout = cancelled).
# ServerAliveInterval/CountMax govern an established session; ConnectTimeout
# governs the dial. Both apply.
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=15 -o ServerAliveCountMax=12"

# ══════════════════════════════════════════════════════════════
# Phase 4: Wait for cloud-init bootstrap
# ══════════════════════════════════════════════════════════════
# Clear stale host key — Cherry reuses IPs across VM recreations
ssh-keygen -R "$VM_IP" 2>/dev/null || true

log_step "Phase 4: Wait for bootstrap (~3-5 min, hard cap 10 min wall-clock)"

# Wall-clock budget — the previous `for attempt in $(seq 1 60); sleep 10`
# pattern claimed "10 min" but each iteration made TWO ssh calls; with
# OpenSSH's default ~2-min TCP SYN retry on dropped packets, one stalled
# iteration consumed ~4 min and the whole loop overran the workflow's
# 60-min timeout (see SSH_OPTS comment above). ConnectTimeout=10 bounds
# each ssh dial to 10s; the budget guard below bounds the outer loop
# regardless of how many iterations fit.
PHASE_4_BUDGET_SECS=600
PHASE_4_START=$SECONDS
attempt=0
while true; do
  attempt=$((attempt + 1))
  elapsed=$(( SECONDS - PHASE_4_START ))
  if (( elapsed > PHASE_4_BUDGET_SECS )); then
    log_error "Bootstrap did not complete within ${PHASE_4_BUDGET_SECS}s wall-clock (attempt=${attempt})."
    # One diagnostic SSH with hard-bounded timeout. Distinguishes
    # "VM still booting, just slow" from "packets dropped, VM unreachable" —
    # the former produces log output, the latter times out the diagnostic too.
    log_info "Attempting diagnostic SSH (10s budget) to dump VM bootstrap state..."
    set +e
    ssh -i "$SSH_KEY" \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=10 \
        -o ConnectionAttempts=1 \
        root@"$VM_IP" \
        '{ test -r /var/log/cogni-bootstrap.log && tail -100 /var/log/cogni-bootstrap.log; } 2>&1 || { test -r /var/log/cloud-init-output.log && tail -100 /var/log/cloud-init-output.log; } 2>&1 || echo "(neither log readable on VM)"'
    diag_rc=$?
    set -e
    if [[ $diag_rc -ne 0 ]]; then
      log_warn "  diagnostic SSH itself failed (rc=${diag_rc}) — VM likely unreachable (network drop, not slow bootstrap)."
    fi
    log_error "SSH in to debug: ssh -i .local/${DEPLOY_ENV}-vm-key root@$VM_IP"
    exit 1
  fi
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
  # Show progress every ~30s (3 iterations; iterations are bounded by
  # ConnectTimeout=10 + sleep 10 = 10-30s, so logs land roughly every minute
  # in the worst case where every ssh dial times out).
  if (( attempt % 3 == 0 )); then
    log_info "  Waiting... (${elapsed}s elapsed of ${PHASE_4_BUDGET_SECS}s budget, attempt=${attempt})"
  fi
  sleep 10
done

# Quick verification
log_info "Verifying k3s + Argo CD..."
ssh $SSH_OPTS root@"$VM_IP" 'kubectl get nodes && echo "---" && kubectl -n argocd get pods --no-headers'

# ── Phase 4a: Fetch k3s kubeconfig to operator's laptop ──────────────────
# Without this, the operator's only way to talk to the cluster is to SSH
# into the VM and run kubectl there — the same laptop-shell anti-pattern
# at the control-plane tier that proj.security-hardening exists to
# eliminate at the data tier. Fetch + rewrite the API server URL to the
# public VM IP so local `kubectl` Just Works.
#
# Security note: this kubeconfig is the k3s cluster-admin credential. On
# candidate-a (single-operator fork) the operator IS the admin so this is
# correct. preview/production should ship a constrained kubeconfig in a
# follow-up — bound to a dedicated SA with minimum RBAC.
log_step "Phase 4a: Fetch kubeconfig to .local/${DEPLOY_ENV}-kubeconfig.yaml"
KUBECONFIG_LOCAL="$REPO_ROOT/.local/${DEPLOY_ENV}-kubeconfig.yaml"
# k3s issues its server cert for 127.0.0.1 (no SAN for the public VM IP).
# Rewrite the server URL to the public IP AND drop certificate-authority-data
# in favor of insecure-skip-tls-verify. Acceptable on candidate-a (fresh-fork,
# single operator, HTTPS still encrypts the wire). preview/production should
# either (a) install k3s with `--tls-san <vm-ip>` so the cert is valid, or
# (b) use an SSH tunnel so the kubeconfig's 127.0.0.1 entry is honored.
# Both are v-next per .context/followup-bug.0446 + the broader observability
# track (Grafana/Loki + Argo UI as the visibility surface instead of kubectl).
ssh $SSH_OPTS root@"$VM_IP" 'cat /etc/rancher/k3s/k3s.yaml' \
  | sed "s|server: https://127.0.0.1:6443|server: https://${VM_IP}:6443|" \
  | yq '.clusters[].cluster."insecure-skip-tls-verify" = true | del(.clusters[].cluster."certificate-authority-data")' \
  > "$KUBECONFIG_LOCAL"
chmod 600 "$KUBECONFIG_LOCAL"
if ! KUBECONFIG="$KUBECONFIG_LOCAL" kubectl get nodes >/dev/null 2>&1; then
  log_warn "  Fetched kubeconfig at $KUBECONFIG_LOCAL but local kubectl can't reach ${VM_IP}:6443."
  log_warn "  Likely Cherry firewall — check that the k3s API port (6443/tcp) is open."
else
  log_info "  Local kubectl works. Operator next step:"
  log_info "    export KUBECONFIG=$KUBECONFIG_LOCAL"
  log_info "    kubectl get nodes  # should print the VM node"
fi

# ApplicationSets applied in Phase 7 (after all prerequisites are in place)

# ══════════════════════════════════════════════════════════════
# Phase 4b: Create/update DNS records
# ══════════════════════════════════════════════════════════════
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] && [[ -n "${CLOUDFLARE_ZONE_ID:-}" ]]; then
  log_step "Phase 4b: Create DNS records + set Cloudflare SSL mode"

  # ── Zone SSL mode = Full ─────────────────────────────────────────────
  # Cloudflare proxies our DNS (proxied:true below). Browsers terminate
  # TLS at Cloudflare's edge (Universal SSL — always trusted). The
  # origin (Caddy) uses self-signed certs via `tls internal`; Cloudflare
  # "Full" SSL mode talks HTTPS to origin but trusts any cert. This
  # eliminates LE entirely + the 50-certs/week/domain rate limit that
  # blocked iterating bootstrap across many provisions.
  #
  # Token needs Zone:Zone Settings:Edit scope (in addition to Zone:DNS:Edit
  # the bootstrap floor already requires). Failure here surfaces the gap
  # clearly rather than letting Caddy hit a downstream TLS error.
  SSL_RESP=$(curl -sS -X PATCH \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/settings/ssl" \
    -d '{"value":"full"}')
  SSL_OK=$(echo "$SSL_RESP" | python3 -c 'import json,sys; r=json.load(sys.stdin); print("OK" if r.get("success") else r.get("errors",[{}])[0].get("message","FAIL"))' 2>/dev/null || echo "FAIL")
  if [[ "$SSL_OK" != "OK" ]]; then
    log_error "Failed to set Cloudflare SSL mode to 'full': $SSL_OK"
    log_error "Your CLOUDFLARE_API_TOKEN needs the Zone:Zone Settings:Edit scope."
    log_error "Mint a token at https://dash.cloudflare.com/profile/api-tokens with:"
    log_error "  Permissions: Zone:DNS:Edit + Zone:Zone Settings:Edit"
    log_error "  Zone Resources: Include — Specific zone — <your zone>"
    exit 1
  fi
  log_info "Cloudflare SSL mode → full (zone $CLOUDFLARE_ZONE_ID)"

  # FQDNs come from two sources (B2):
  #   1. DOMAIN — the apex/operator-host (Caddy listens here for TLS)
  #   2. public_url_for_target $DEPLOY_ENV $node — one per NODE_TARGETS entry
  # No more hardcoded poly-*/resy-* (those squatted on upstream's zone last canary).
  # The VM alias is repo-scoped because several forks may share a Cloudflare
  # zone; generic candidate-a.vm.<root> collides across repos.
  DNS_RECORDS=("$DOMAIN" "$VM_DNS_HOST")
  for node in "${NODE_TARGETS[@]}"; do
    node_url=$(public_url_for_target "$DEPLOY_ENV" "$node" 2>/dev/null || true)
    [[ -z "$node_url" ]] && continue
    fqdn="${node_url#https://}"
    [[ "$fqdn" == "$DOMAIN" ]] && continue  # dedupe apex
    DNS_RECORDS+=("$fqdn")
  done

  for fqdn in "${DNS_RECORDS[@]}"; do
    # Subdomain = FQDN minus the zone root. Use FORK_DOMAIN_ROOT if available;
    # else fall back to the legacy cognidao.org suffix strip.
    sub="$fqdn"
    if [[ -n "$FORK_ROOT" && "$FORK_ROOT" != "null" ]]; then
      sub="${fqdn%.${FORK_ROOT}}"
      [[ "$sub" == "$fqdn" ]] && sub="@"  # apex record
    else
      sub="${fqdn%.cognidao.org}"
    fi
    # Proxy state per record:
    #   • Browser-facing (DOMAIN apex + per-node public URLs) → proxied=true
    #     so Cloudflare terminates TLS at the edge with Universal SSL
    #     (browser-trusted always; no LE involvement).
    #   • VM_DNS_HOST → proxied=false so SSH (port 22) + diagnostic NodePort
    #     access (port 30000+) still reach the origin directly. Cloudflare
    #     proxy only forwards 80/443 — non-standard ports get dropped on
    #     proxied records.
    if [[ "$fqdn" == "$VM_DNS_HOST" ]]; then
      proxied="false"
    else
      proxied="true"
    fi
    EXISTING=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=${fqdn}&type=A" \
      | python3 -c "import json,sys; [print(x['id']) for x in json.load(sys.stdin).get('result',[])]" 2>/dev/null)
    for id in $EXISTING; do
      curl -s -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$id" >/dev/null
    done
    RESULT=$(curl -s -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
      -d "{\"type\":\"A\",\"name\":\"${sub}\",\"content\":\"${VM_IP}\",\"ttl\":300,\"proxied\":${proxied}}")
    OK=$(echo "$RESULT" | python3 -c 'import json,sys; print("OK" if json.load(sys.stdin).get("success") else "FAIL")' 2>/dev/null)
    log_info "  ${fqdn} → ${VM_IP} (proxied=${proxied}): $OK"
  done
else
  log_warn "Skipping DNS — CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID not set"
fi

# ══════════════════════════════════════════════════════════════
# Phase 4b.5: Seed (or content-align) deploy/* branches in the fork
# ══════════════════════════════════════════════════════════════
# B1 (deploy machinery) — node-template ships only `main`; per-node
# deploy branches don't exist until first promote-and-deploy run. But
# Phase 4c (env-state push) AND the AppSet generators (Phase 7) both
# need them present. Seed from the operator's local HEAD SHA via
# `gh api /git/refs` when missing. Requires GITHUB_ADMIN_PAT (set by
# bootstrap.sh) — exported as GH_TOKEN.
#
# Per-env drift policy (validator's third run surfaced this — an
# existing branch at a stale pre-PR-#42 SHA was missing the
# infra/k8s/argocd/{openbao,external-secrets}/ dirs Argo Applications
# reference, producing a downstream ComparisonError):
#   * Branch absent             → create at SEED_SHA.
#   * Branch == SEED_SHA        → no-op (true idempotency).
#   * Branch != SEED_SHA AND
#     DEPLOY_ENV is candidate-* → force-update to SEED_SHA. Experiment
#                                  slots reset cleanly; Phase 4c re-writes
#                                  env-state.yaml downstream so per-run
#                                  drift self-heals.
#   * Branch != SEED_SHA AND
#     DEPLOY_ENV is preview/
#     production               → FAIL HARD. Persistent slots must not
#                                  be blindly stomped (history loss).
#                                  Operator merges SEED_SHA's content
#                                  forward OR deletes the branch and
#                                  re-runs.
log_step "Phase 4b.5: Seed deploy/* branches in fork (content-aware idempotent)"

# bootstrap.sh writes GHCR_DEPLOY_TOKEN=GITHUB_ADMIN_PAT into .env.operator;
# this script reads it as GHCR_TOKEN. Use whichever the caller set.
SEED_TOKEN="${GITHUB_ADMIN_PAT:-${GHCR_TOKEN:-${GHCR_DEPLOY_TOKEN:-}}}"
if [[ -n "$SEED_TOKEN" ]]; then
  export GH_TOKEN="$SEED_TOKEN"
  # Seed source is the operator's currently-checked-out HEAD on the fork —
  # NOT a hardcoded `main`. This lets a PR reviewer bootstrap-and-validate
  # the PR branch directly without first merging it to main. The operator
  # must have already pushed their branch to the fork (the runbook tells
  # them to). If HEAD isn't reachable on the fork, fall back to main with
  # a warning so non-PR-validation flows still work.
  LOCAL_HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")
  SEED_SHA=""
  if [[ -n "$LOCAL_HEAD" ]] && gh api "repos/${GH_REPO}/commits/${LOCAL_HEAD}" >/dev/null 2>&1; then
    SEED_SHA="$LOCAL_HEAD"
    SEED_SRC="local HEAD"
  else
    SEED_SHA=$(gh api "repos/${GH_REPO}/branches/main" --jq '.commit.sha' 2>/dev/null || echo "")
    SEED_SRC="main"
    [[ -n "$LOCAL_HEAD" ]] && log_warn "  local HEAD ${LOCAL_HEAD:0:8} not on fork — push it first if validating a PR branch"
  fi
  if [[ -z "$SEED_SHA" ]]; then
    log_error "Could not resolve a seed SHA for ${GH_REPO} (neither HEAD nor main reachable)."
    exit 1
  fi
  # AppSet template generates one Application per catalog entry. Seed BOTH
  # the env-wide branch AND the per-app branches from the same SHA so
  # Phase 4c's patches propagate consistently to whichever branches the
  # AppSets watch.
  BRANCHES_TO_SEED=("deploy/${DEPLOY_ENV}")
  for target in "${ALL_TARGETS[@]}"; do
    BRANCHES_TO_SEED+=("deploy/${DEPLOY_ENV}-${target}")
  done
  for ref in "${BRANCHES_TO_SEED[@]}"; do
    existing_sha=$(gh api "repos/${GH_REPO}/branches/${ref}" --jq '.commit.sha' 2>/dev/null || echo "")
    if [[ -n "$existing_sha" ]]; then
      if [[ "$existing_sha" == "$SEED_SHA" ]]; then
        log_info "  ${ref} — already at seed SHA ${SEED_SHA:0:8}"
        continue
      fi
      # Branch exists but at a different SHA. Resolution depends on env.
      case "$DEPLOY_ENV" in
        candidate-*)
          log_warn "  ${ref} — exists at ${existing_sha:0:8}, force-updating to ${SEED_SHA:0:8} (${SEED_SRC})"
          if gh api -X PATCH "repos/${GH_REPO}/git/refs/heads/${ref}" \
              -f "sha=${SEED_SHA}" \
              -F force=true >/dev/null 2>&1; then
            log_info "  ${ref} — force-updated"
          else
            log_error "  ${ref} — FAILED to force-update (check PAT push permission)"
            exit 1
          fi
          ;;
        preview|production)
          log_error "  ${ref} — exists at ${existing_sha:0:8}, diverged from seed ${SEED_SHA:0:8} (${SEED_SRC})"
          log_error "    candidate-* slots auto-resolve via force-update; ${DEPLOY_ENV} does not."
          log_error "    Reconcile manually then re-run, e.g.:"
          log_error "      git fetch origin ${ref} && git merge ${SEED_SHA} && git push origin ${ref}"
          log_error "    Or delete + re-seed (destroys env-state Phase 4c wrote previously):"
          log_error "      gh api -X DELETE repos/${GH_REPO}/git/refs/heads/${ref}"
          exit 1
          ;;
        *)
          log_error "  ${ref} — exists at ${existing_sha:0:8}, diverged. Unknown DEPLOY_ENV='${DEPLOY_ENV}', refusing to force-update."
          exit 1
          ;;
      esac
      continue
    fi
    # Branch absent → create at SEED_SHA.
    if gh api -X POST "repos/${GH_REPO}/git/refs" \
        -f "ref=refs/heads/${ref}" \
        -f "sha=${SEED_SHA}" >/dev/null 2>&1; then
      log_info "  ${ref} — seeded from ${SEED_SRC} (${SEED_SHA:0:8})"
    else
      log_error "  ${ref} — FAILED to seed (check PAT push permission)"
      exit 1
    fi
  done
else
  log_warn "No GitHub PAT in env (GITHUB_ADMIN_PAT/GHCR_TOKEN) — skipping branch-seed."
  log_warn "Phase 4c will fail if deploy/${DEPLOY_ENV} doesn't already exist on the fork."
fi

# ══════════════════════════════════════════════════════════════
# Phase 4c: Patch EndpointSlice IPs on deploy branch
# ══════════════════════════════════════════════════════════════
log_step "Phase 4c: Patch EndpointSlice IPs to $VM_IP on $DEPLOY_BRANCH"

# deploy/<env> is the sole persistence layer for env-discovered state (VM IPs).
# promote-and-deploy.yml no longer rsyncs overlays — only updates digests.
# Provision is the one writer for IP state.
DEPLOY_TMP=$(mktemp -d)
# B1 — push to the fork's own deploy branch, NOT the upstream template.
# Last canary's auto-flight here was a `fatal: 403` because the bot account
# had no write access to Cogni-DAO/cogni. Use the same GHCR PAT we already
# have (it doubles as a Contents:Write PAT on the fork; bootstrap.sh's
# pre-flight check guarantees that).
REPO_URL="https://${GHCR_USERNAME:-${GITHUB_ADMIN_USERNAME:-Cogni-1729}}:${GHCR_TOKEN}@github.com/${GH_REPO}.git"

log_info "Cloning $DEPLOY_BRANCH..."
git clone --depth=1 --branch "$DEPLOY_BRANCH" "$REPO_URL" "$DEPLOY_TMP" 2>/dev/null

# Write VM IP to each overlay's env-state.yaml (bug.0334). This is the ONLY
# file provision writes under infra/k8s/. The promote workflow rsyncs
# everything else from main with --exclude='env-state.yaml'.
for overlay_dir in "$DEPLOY_TMP/infra/k8s/overlays/${OVERLAY_DIR}"/*/; do
  [[ -d "$overlay_dir" ]] || continue
  cat > "${overlay_dir}env-state.yaml" <<EOF
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
done

# B2 (overlays) — the shared _template/ overlay and per-env wrappers
# reference `vm.cognidao.org` as the ExternalName placeholder for pod→host
# service discovery (postgres, temporal, litellm, doltgres, redis). Rewrite it
# to the repo/env-scoped VM alias, e.g. `<slug>-candidate-a.vm.<root>`.
# Sed walks both the per-env wrapper AND the shared _template (each deploy
# branch is per-env, so substituting _template doesn't race with siblings).
if [[ -n "$FORK_ROOT" && "$FORK_ROOT" != "null" ]]; then
  log_info "Rewriting overlay vm.cognidao.org → ${VM_DNS_HOST}"
  # Rewrite both the per-env wrapper directory AND the shared _template.
  # _template lives at overlays/_template/ — each deploy branch has its own
  # copy, so per-env substitutions don't conflict across branches.
  find "$DEPLOY_TMP/infra/k8s/overlays/${OVERLAY_DIR}" \
       "$DEPLOY_TMP/infra/k8s/overlays/_template" \
       -name "kustomization.yaml" -print0 2>/dev/null \
    | xargs -0 sed -i.bak -E "s/vm\.cognidao\.org/${VM_DNS_HOST}/g"
  find "$DEPLOY_TMP/infra/k8s/overlays/${OVERLAY_DIR}" \
       "$DEPLOY_TMP/infra/k8s/overlays/_template" \
       -name "*.bak" -delete 2>/dev/null || true
fi

# Image-pull fallback (next failure cliff after vm.* rewrite) — fresh forks
# have nothing on their own GHCR namespace yet. Substitute the overlay's
# `<env>-placeholder-<target>` newTag with the catalog's bootstrap_image_tag,
# which points at a known-good upstream pr-* image. First canary pulls
# upstream's code; argocd-image-updater swaps to the fork's own pr-* tags
# after its first push-to-main publishes them.
log_info "Rewriting overlay newTag → catalog bootstrap_image_tag"
for target in "${ALL_TARGETS[@]}"; do
  catalog_file="$REPO_ROOT/infra/catalog/${target}.yaml"
  boot_tag=$(yq -N '.bootstrap_image_tag // ""' "$catalog_file" 2>/dev/null)
  if [[ -z "$boot_tag" || "$boot_tag" == "null" ]]; then
    log_warn "  ${target} — no bootstrap_image_tag in catalog; first deploy may ImagePullBackOff"
    continue
  fi
  overlay_file="$DEPLOY_TMP/infra/k8s/overlays/${OVERLAY_DIR}/${target}/kustomization.yaml"
  [[ -f "$overlay_file" ]] || continue
  # Pattern: newTag: "<env>-placeholder-<target>" → newTag: "<boot_tag>"
  sed -i.bak -E "s|newTag: \"${OVERLAY_DIR}-placeholder-${target}\"|newTag: \"${boot_tag}\"|g" \
    "$overlay_file"
  rm -f "${overlay_file}.bak"
  log_info "  ${target} → ${boot_tag}"

  # Migrator placeholder (bug.0446 H8). Derive boot tag by replacing the
  # runner suffix with the migrator suffix from the same catalog entry, then
  # sed-rewrite the parallel placeholder declared in the overlay's images
  # block. Skipped silently when migrator_tag_suffix is absent (service-type
  # targets like scheduler-worker).
  app_suffix=$(yq -N '.image_tag_suffix // ""' "$catalog_file" 2>/dev/null)
  migrator_suffix=$(yq -N '.migrator_tag_suffix // ""' "$catalog_file" 2>/dev/null)
  if [[ -n "$migrator_suffix" && "$migrator_suffix" != "null" \
        && -n "$app_suffix" && "$app_suffix" != "null" ]]; then
    # boot_tag ends with app_suffix (e.g. -node-template); swap to migrator
    # suffix (e.g. -node-template-migrate) to derive the migrator boot tag.
    migrator_boot_tag="${boot_tag%${app_suffix}}${migrator_suffix}"
    migrator_placeholder="${OVERLAY_DIR}-placeholder${migrator_suffix}"
    sed -i.bak -E "s|newTag: \"${migrator_placeholder}\"|newTag: \"${migrator_boot_tag}\"|g" \
      "$overlay_file"
    rm -f "${overlay_file}.bak"
    log_info "  ${target} migrator → ${migrator_boot_tag}"
  fi
done

cd "$DEPLOY_TMP"
git config user.name "provision-script"
git config user.email "provision@cogni.dev"
git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore(infra): write env-state.yaml for ${DEPLOY_ENV} — VM_IP=${VM_IP} [provision]"
  git push origin "$DEPLOY_BRANCH"
  log_info "Pushed EndpointSlice IP patches to $DEPLOY_BRANCH"
  PATCHED_SHA=$(git rev-parse HEAD)
  # AppSets watch per-app deploy branches (deploy/<env>-<target>), not the
  # env-wide one. Mirror the patched commit to every per-app branch so they
  # all reflect the same env-state.yaml + vm.<root> + bootstrap_image_tag
  # patches. Without this the per-app branches stay at the seed (Phase 4b.5)
  # and Argo deploys unpatched placeholder image tags → ImagePullBackOff.
  for target in "${ALL_TARGETS[@]}"; do
    per_app_branch="deploy/${DEPLOY_ENV}-${target}"
    if git push -f origin "${PATCHED_SHA}:refs/heads/${per_app_branch}"; then
      log_info "  mirrored to ${per_app_branch} (${PATCHED_SHA:0:8})"
    else
      log_error "  ${per_app_branch} — FAILED to mirror (check PAT push permission)"
      exit 1
    fi
  done
else
  log_info "EndpointSlice IPs already correct on $DEPLOY_BRANCH"
fi
rm -rf "$DEPLOY_TMP"
cd "$REPO_ROOT"

# ══════════════════════════════════════════════════════════════
# Phase 5: Deploy Compose infrastructure
# ══════════════════════════════════════════════════════════════
log_step "Phase 5: Deploy Compose infrastructure"

# Upload files
log_info "Uploading Compose files..."
ssh $SSH_OPTS root@"$VM_IP" 'mkdir -p /opt/cogni-template-edge/configs /opt/cogni-template-runtime/configs /opt/cogni-template-runtime/postgres-init /opt/cogni-template-runtime/litellm-image'

# Edge stack
scp $SSH_OPTS "$REPO_ROOT/infra/compose/edge/docker-compose.yml" root@"$VM_IP":/opt/cogni-template-edge/docker-compose.yml
scp $SSH_OPTS "$REPO_ROOT/infra/compose/edge/configs/Caddyfile.tmpl" root@"$VM_IP":/opt/cogni-template-edge/configs/Caddyfile.tmpl

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

# NODE_UPSTREAM points Caddy at the k3s NodePort on the host. Single-node
# fork: one site block, one upstream (bug.5001). Multi-node forks add
# additional NODE_UPSTREAM_<slug> blocks rather than reintroducing the
# multi-key pattern. Port is catalog-driven (catalog::node_port is the
# canonical source — node-template ships 30000).
NODE_PORT_FROM_CATALOG=$(yq -N '.node_port // 30000' "$REPO_ROOT/infra/catalog/node-template.yaml")
# Caddy serves a self-signed origin cert via `tls internal`; Cloudflare's
# Full SSL mode trusts any origin cert. No ACME, no LE rate limit, no
# cert-loss-on-reprovision. See infra/compose/edge/configs/Caddyfile.tmpl.
ssh $SSH_OPTS root@"$VM_IP" "cat > /opt/cogni-template-edge/.env << 'ENVEOF'
DOMAIN=${DOMAIN}
NODE_UPSTREAM=host.docker.internal:${NODE_PORT_FROM_CATALOG}
ENVEOF"

# runtime/.env is written AFTER Phase 5c's OpenBao-SSoT reconcile (bug.5081)
# so re-runs don't ship Phase-2's freshly-regenerated random values that would
# mismatch the persisted postgres/temporal/etc state on the existing VM.
# Function defined here; call at end of Phase 5c. No consumer between here and
# Phase 5f — runtime services aren't started until deploy-infra.sh.
write_runtime_env_on_vm() {
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
POLYGON_RPC_URL=${POLYGON_RPC_URL}
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
LITELLM_IMAGE=cogni-litellm:latest
ENVEOF"
}

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

# Runtime stack (postgres, temporal, redis, litellm, alloy, alloy-k8s-events,
# autoheal, repo-init, git-sync) + db-provision + temporal-namespace bootstrap
# are deferred to Phase 5f (below), which reuses scripts/ci/deploy-infra.sh — the
# canonical primitive used by candidate-flight-infra.yml + promote-and-deploy.yml.
# Phase 5e mints Grafana Cloud read/write tokens that Alloy needs; deploy-infra
# can therefore only run AFTER 5b/5c/5e have populated the runner env.

# ══════════════════════════════════════════════════════════════
# Phase 5b: Install OpenBao + ESO + auto-init + auto-unseal + auth bind
# ══════════════════════════════════════════════════════════════
# task.0284 — fully automates the substrate bootstrap. Phase 5b.1 registers
# Argo Applications for the OpenBao + ESO kustomize layers (Argo renders them
# via kustomize-with-helm thanks to the argocd-cm patch in bootstrap.yaml).
# Phase 5b.2 → 5b.5 then drive OpenBao through init → unseal → KV mount →
# Kubernetes auth method → eso-reader role bind so `ClusterSecretStore
# openbao-backend` reaches `Ready=True` with zero operator toil.
#
# v-next of task.0284 — Phase 5b.1 was previously an imperative `kubectl
# kustomize --enable-helm | kubectl apply` against the operator's local
# checkout; Argo never saw the substrate and couldn't reconcile drift.
# This phase now applies two Argo Application CRs (openbao + external-secrets);
# the Applications fetch from the fork's own deploy/${DEPLOY_ENV} branch and
# Argo handles render + apply + drift correction.
#
# Default seal shape: Shamir 1-of-1 — appropriate for the single-operator
# OSS baseline. Multi-operator forks override via OPENBAO_KEY_SHARES +
# OPENBAO_KEY_THRESHOLD env vars (rare for v1 single-node k3s).
#
# Idempotency: every step short-circuits if its target state already holds
# (`bao status` initialized, `bao auth list` has kubernetes/, policy + role
# writes are upsert by design). Re-running Phase 5b after a chart version
# bump just re-applies the Application CRs (no-op if unchanged) and re-verifies
# state.
log_step "Phase 5b: Install + initialize OpenBao + ESO"

# Wall-clock budget — same shape as Phase 4. Phase 5b's individual kubectl
# waits compound (Argo sync + CRD Established + pod Running); without an
# outer guard, a slow-but-not-stuck cluster could silently consume the
# workflow's full budget. Validator run 26481178062 (i-am-coco fork) failed
# Phase 5b inside ~12 min wall-clock but for a different reason: the prior
# Health.Status=Healthy wait false-positived in 9 seconds on a brand-new
# Application (Argo defaults Health to "Healthy" vacuously when no resources
# are tracked yet) → script proceeded against an unprepped cluster →
# cascade failure. Strengthen the Application wait + bump generous timeouts
# + this wall-clock guard so the next iteration fails LOUDLY at a real
# boundary rather than silently at a stale signal.
PHASE_5B_BUDGET_SECS=900
PHASE_5B_START=$SECONDS

# Diagnostic dump on Phase 5b timeout — same shape as the Phase 4 one. The
# substrate side has three independent state surfaces worth capturing
# (Argo Application state, openbao namespace pod state, recent events
# across the cluster); together they distinguish "Argo can't render"
# vs "render OK but pod can't pull image" vs "all OK but slow".
phase_5b_timeout() {
  local reason="$1"
  local elapsed=$(( SECONDS - PHASE_5B_START ))
  log_error "Phase 5b failed (${reason}) — elapsed=${elapsed}s of ${PHASE_5B_BUDGET_SECS}s budget."
  log_info "Attempting Phase 5b diagnostic dump (10s ssh budget)..."
  set +e
  ssh -i "$SSH_KEY" \
      -o StrictHostKeyChecking=no \
      -o ConnectTimeout=10 \
      -o ConnectionAttempts=1 \
      root@"$VM_IP" '
        echo "=== argocd applications ==="
        kubectl -n argocd get applications -o wide 2>&1
        echo
        echo "=== application/openbao describe (tail) ==="
        kubectl -n argocd describe application openbao 2>&1 | tail -80
        echo
        echo "=== application/external-secrets describe (tail) ==="
        kubectl -n argocd describe application external-secrets 2>&1 | tail -80
        echo
        echo "=== openbao namespace state ==="
        kubectl -n openbao get all 2>&1
        echo
        echo "=== openbao-0 describe (tail) ==="
        kubectl -n openbao describe pod openbao-0 2>&1 | tail -60
        echo
        echo "=== external-secrets namespace state ==="
        kubectl -n external-secrets get all 2>&1
        echo
        echo "=== recent events (sorted, all namespaces, last 50) ==="
        kubectl get events --sort-by=.lastTimestamp -A 2>&1 | tail -50
      '
  local diag_rc=$?
  set -e
  if [[ $diag_rc -ne 0 ]]; then
    log_warn "  diagnostic SSH itself failed (rc=${diag_rc}) — VM may be unreachable."
  fi
  log_error "SSH in to debug: ssh -i .local/${DEPLOY_ENV}-vm-key root@$VM_IP"
  exit 1
}

# ── 5b.1 Register Argo Applications for the substrate ─────────────────────
# Substitute ${FORK_REPO} + ${DEPLOY_BRANCH} placeholders, apply the two
# Application CRs into the argocd namespace, then wait for both to complete
# their first sync. Argo's repo-server clones the deploy branch, runs
# `kustomize build --enable-helm` (per the bootstrap argocd-cm patch), and
# applies server-side.
SUBSTRATE_FORK_REPO="https://github.com/${GH_REPO}.git"
for substrate in openbao external-secrets; do
  rendered=$(mktemp)
  sed -e "s#\${FORK_REPO}#${SUBSTRATE_FORK_REPO}#g" \
      -e "s#\${DEPLOY_BRANCH}#${DEPLOY_BRANCH}#g" \
      "$REPO_ROOT/infra/k8s/argocd/${substrate}-application.yaml" >"$rendered"
  scp $SSH_OPTS "$rendered" root@"$VM_IP":/tmp/${substrate}-application.yaml
  rm -f "$rendered"
  ssh $SSH_OPTS root@"$VM_IP" "kubectl apply -f /tmp/${substrate}-application.yaml && rm -f /tmp/${substrate}-application.yaml"
  log_info "Applied Argo Application: ${substrate} (repo=${SUBSTRATE_FORK_REPO} branch=${DEPLOY_BRANCH})"
done

# Wait for both substrate Applications to complete their first sync.
# `operationState.phase=Succeeded` is picked over the previous
# `health.status=Healthy` because the latter false-positives on a brand-new
# Application CR (Argo defaults Health to "Healthy" vacuously when no
# resources are tracked yet) — exactly the failure mode in validator run
# 26481178062. The operationState field only populates after a real sync
# operation runs, so this wait blocks until Argo has actually rendered,
# applied, and reported success. Hard-fail (no `|| log_warn`) — if the
# substrate sync hasn't completed, nothing downstream can succeed.
#
# Per-substrate timeouts: ESO is just a Deployment + CRDs (~2-3min real,
# 5min budget); OpenBao is a StatefulSet + PVC bind + image pull
# (~3-5min real, 10min budget — validator's previous 120s pod-Running
# wait was the actual root failure of this signal).
for substrate in external-secrets openbao; do
  case "$substrate" in
    external-secrets) wait_timeout=300s ;;
    openbao)          wait_timeout=600s ;;
  esac
  log_info "Waiting for application/${substrate} operationState.phase=Succeeded (up to ${wait_timeout})..."
  ssh $SSH_OPTS root@"$VM_IP" \
    "kubectl -n argocd wait --for=jsonpath='{.status.operationState.phase}'=Succeeded --timeout=${wait_timeout} application/${substrate}" \
    || phase_5b_timeout "application/${substrate} first sync did not complete"
  if (( SECONDS - PHASE_5B_START > PHASE_5B_BUDGET_SECS )); then
    phase_5b_timeout "wall-clock budget exhausted after application/${substrate} wait"
  fi
done

# Wait for ExternalSecret + ClusterSecretStore CRDs to be Established before
# 5b.5 below applies the ClusterSecretStore CR. Argo Succeeded implies the
# CRD manifests were applied; Establishment is a separate API-server loop
# that can lag briefly. Bumped 120s → 300s for that lag plus headroom.
log_info "Waiting for ESO CRDs to register..."
ssh $SSH_OPTS root@"$VM_IP" "kubectl wait --for=condition=Established --timeout=300s crd/externalsecrets.external-secrets.io crd/clustersecretstores.external-secrets.io" \
  || phase_5b_timeout "ESO CRDs not Established"

# Wait for the openbao-0 pod to exist + be Running. NOT Ready — sealed pods
# are Running but not Ready. The chart's readiness probe gates on unsealed
# status; the pod is functional for init/unseal once it's Running.
# Bumped from 60×2s=120s to 60×10s=600s. StatefulSet pod create + PVC bind
# + first image pull is realistically 3-5min on GHA-runner-network k3s; the
# previous 120s budget was flake-by-design.
log_info "Waiting for openbao-0 pod to be Running (sealed but accepting init, up to 600s)..."
ssh $SSH_OPTS root@"$VM_IP" '
  for i in $(seq 1 60); do
    phase=$(kubectl -n openbao get pod openbao-0 -o jsonpath="{.status.phase}" 2>/dev/null || echo "")
    [[ "$phase" == "Running" ]] && exit 0
    sleep 10
  done
  echo "openbao-0 did not reach Running phase within 600s" >&2
  exit 1
' || phase_5b_timeout "openbao-0 not Running"
if (( SECONDS - PHASE_5B_START > PHASE_5B_BUDGET_SECS )); then
  phase_5b_timeout "wall-clock budget exhausted after openbao-0 Running wait"
fi

# ── 5b.2 Init + unseal (idempotent — Shamir 1-of-1 default) ───────────────
OPENBAO_KEY_SHARES="${OPENBAO_KEY_SHARES:-1}"
OPENBAO_KEY_THRESHOLD="${OPENBAO_KEY_THRESHOLD:-1}"
OPENBAO_INIT_LOCAL="$REPO_ROOT/.local/${DEPLOY_ENV}-openbao-init.json"
OPENBAO_ROOT_TOKEN_LOCAL="$REPO_ROOT/.local/${DEPLOY_ENV}-openbao-root-token"

# Check current seal status. Output is JSON when -format=json is passed.
seal_status=$(ssh $SSH_OPTS root@"$VM_IP" \
  'kubectl exec -n openbao openbao-0 -- bao status -format=json 2>/dev/null || true')

if [[ -z "$seal_status" ]]; then
  log_warn "Could not read bao status — openbao-0 may still be coming up. Skipping init/unseal; re-run provision to retry."
else
  initialized=$(echo "$seal_status" | jq -r '.initialized // false')
  sealed=$(echo "$seal_status" | jq -r '.sealed // true')

  if [[ "$initialized" != "true" ]]; then
    log_info "Initializing OpenBao (Shamir ${OPENBAO_KEY_THRESHOLD}-of-${OPENBAO_KEY_SHARES})..."
    init_json=$(ssh $SSH_OPTS root@"$VM_IP" \
      "kubectl exec -n openbao openbao-0 -- bao operator init \
        -key-shares=${OPENBAO_KEY_SHARES} -key-threshold=${OPENBAO_KEY_THRESHOLD} -format=json")
    # Persist locally — .local/ is gitignored. Sensitive; chmod 600.
    printf '%s' "$init_json" >"$OPENBAO_INIT_LOCAL"
    chmod 600 "$OPENBAO_INIT_LOCAL"
    jq -r '.root_token' <"$OPENBAO_INIT_LOCAL" >"$OPENBAO_ROOT_TOKEN_LOCAL"
    chmod 600 "$OPENBAO_ROOT_TOKEN_LOCAL"
    log_info "  Init artifacts saved to $OPENBAO_INIT_LOCAL + $OPENBAO_ROOT_TOKEN_LOCAL (600)"
    sealed=true
  else
    log_info "OpenBao already initialized — reading prior init artifacts from $OPENBAO_INIT_LOCAL"
    if [[ ! -r "$OPENBAO_INIT_LOCAL" ]]; then
      log_error "OpenBao is initialized on the VM but $OPENBAO_INIT_LOCAL is missing — cannot unseal/auth."
      log_error "Recover the unseal key(s) and root token from your password manager (or another operator on a multi-operator fork) and place them in this file before re-running."
      exit 1
    fi
    # Re-derive the root-token sidecar that 5b.3/5b.4/5c gate on. The init
    # branch above writes it; the rerun branch was missing this step.
    jq -r '.root_token' <"$OPENBAO_INIT_LOCAL" >"$OPENBAO_ROOT_TOKEN_LOCAL"
    chmod 600 "$OPENBAO_ROOT_TOKEN_LOCAL"
  fi

  if [[ "$sealed" == "true" ]]; then
    log_info "Unsealing OpenBao..."
    # Apply unseal keys one at a time until threshold met. For 1-of-1, this
    # loops exactly once.
    key_count=$(jq '.unseal_keys_b64 | length' <"$OPENBAO_INIT_LOCAL")
    threshold=$(jq -r '.unseal_threshold // 1' <"$OPENBAO_INIT_LOCAL")
    for i in $(seq 0 $((threshold - 1))); do
      [[ $i -ge $key_count ]] && break
      key=$(jq -r ".unseal_keys_b64[$i]" <"$OPENBAO_INIT_LOCAL")
      ssh $SSH_OPTS root@"$VM_IP" \
        "kubectl exec -n openbao openbao-0 -- bao operator unseal '${key}'" >/dev/null
    done
    log_info "  OpenBao unsealed"
  else
    log_info "OpenBao already unsealed"
  fi
fi

# ── 5b.3 Mount KV v2 + enable kubernetes auth + write eso-reader policy + role ─
# All four operations are idempotent: `bao secrets enable` errors on
# re-enable but we short-circuit by listing first; `bao auth enable` same;
# `bao policy write` and `bao write auth/.../role/...` are upsert.
if [[ -r "$OPENBAO_ROOT_TOKEN_LOCAL" ]]; then
  ROOT_TOKEN=$(cat "$OPENBAO_ROOT_TOKEN_LOCAL")
  bao_exec() {
    # Runs `bao $@` inside the openbao-0 pod with the root token via env.
    ssh $SSH_OPTS root@"$VM_IP" \
      "kubectl exec -n openbao openbao-0 -- env BAO_TOKEN='${ROOT_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao $*"
  }

  # KV v2 mount at cogni/.
  if ! bao_exec "secrets list -format=json" 2>/dev/null | jq -e '."cogni/"' >/dev/null 2>&1; then
    log_info "Mounting KV v2 at cogni/..."
    bao_exec "secrets enable -path=cogni -version=2 kv" >/dev/null
  else
    log_info "KV v2 mount cogni/ already present"
  fi

  # Kubernetes auth method.
  if ! bao_exec "auth list -format=json" 2>/dev/null | jq -e '."kubernetes/"' >/dev/null 2>&1; then
    log_info "Enabling kubernetes auth method..."
    bao_exec "auth enable kubernetes" >/dev/null
  else
    log_info "kubernetes auth method already enabled"
  fi
  # Configure (idempotent).
  bao_exec "write auth/kubernetes/config kubernetes_host=https://kubernetes.default.svc:443" >/dev/null

  # eso-reader policy + role binding (upsert). Used by the in-cluster ESO
  # controller's ServiceAccount — read-only across all envs.
  log_info "Writing eso-reader policy + role binding..."
  ssh $SSH_OPTS root@"$VM_IP" "kubectl exec -i -n openbao openbao-0 -- env BAO_TOKEN='${ROOT_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao policy write eso-reader -" <<'HCL'
path "cogni/data/*"     { capabilities = ["read"] }
path "cogni/metadata/*" { capabilities = ["read", "list"] }
HCL
  bao_exec "write auth/kubernetes/role/eso-reader \
    bound_service_account_names=external-secrets \
    bound_service_account_namespaces=external-secrets \
    policies=eso-reader \
    ttl=1h" >/dev/null
  log_info "  eso-reader role bound — ESO can now read cogni/* via Kubernetes auth"

  # ── 5b.4 Operator writer role (per-env, post-bootstrap CLI path) ──────────
  # Closes the post-bootstrap gap: without this, `pnpm secrets:set` would
  # have nowhere to authenticate except the root token (forbidden by spec
  # Invariant 13 NO_OPERATOR_ROOT_TOKEN_ON_LAPTOP).
  #
  # The operator authenticates as the `openbao-operator` ServiceAccount in
  # the `default` namespace (created here). They mint a short-lived JWT
  # via `kubectl create token openbao-operator` and exchange it for a bao
  # token via `bao login -method=kubernetes role=${DEPLOY_ENV}-writer`.
  #
  # Policy is per-env: writers on this env CANNOT touch other envs' paths
  # (spec Invariant 6 RBAC_VIA_PATH_POLICY). No `delete` capability — destroy
  # requires admin escalation per CC6.1.
  log_info "Writing ${DEPLOY_ENV}-writer policy + role binding..."
  ssh $SSH_OPTS root@"$VM_IP" \
    "kubectl get sa openbao-operator -n default >/dev/null 2>&1 \
       || kubectl create sa openbao-operator -n default"
  ssh $SSH_OPTS root@"$VM_IP" \
    "kubectl exec -i -n openbao openbao-0 -- env BAO_TOKEN='${ROOT_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao policy write ${DEPLOY_ENV}-writer -" <<HCL
path "cogni/data/${DEPLOY_ENV}/*"     { capabilities = ["read", "create", "update", "patch"] }
path "cogni/metadata/${DEPLOY_ENV}/*" { capabilities = ["read", "list"] }
HCL
  bao_exec "write auth/kubernetes/role/${DEPLOY_ENV}-writer \
    bound_service_account_names=openbao-operator \
    bound_service_account_namespaces=default \
    policies=${DEPLOY_ENV}-writer \
    ttl=1h" >/dev/null
  log_info "  ${DEPLOY_ENV}-writer role bound — operator: kubectl create token openbao-operator -n default | bao login -method=kubernetes role=${DEPLOY_ENV}-writer"
else
  log_warn "No root token at $OPENBAO_ROOT_TOKEN_LOCAL — skipping KV mount + auth setup. Re-run provision after recovering init artifacts."
fi

# ── 5b.5 Apply ClusterSecretStore (lives at parent of per-env trees) ──────
CSS_LOCAL="$REPO_ROOT/infra/k8s/secrets/external-secrets/cluster-secret-store.yaml"
scp $SSH_OPTS "$CSS_LOCAL" root@"$VM_IP":/tmp/cluster-secret-store.yaml
ssh $SSH_OPTS root@"$VM_IP" "kubectl apply -f /tmp/cluster-secret-store.yaml"
log_info "Applied ClusterSecretStore openbao-backend"

# ══════════════════════════════════════════════════════════════
# seed_kv: <service> <KEY> <value> → cogni/${DEPLOY_ENV}/<service>
# File-scope helper used by Phase 5c (app secrets) AND Phase 5e (auto-mint).
# No-op when value is empty. First write creates the path (put); later writes
# patch so existing keys are preserved. Requires ROOT_TOKEN to be set by the
# caller (read from $OPENBAO_ROOT_TOKEN_LOCAL after Phase 5b.2 produces it).
seed_kv() {
  local svc="$1" k="$2" v="$3"
  [[ -z "$v" ]] && return 0
  local path="cogni/${DEPLOY_ENV}/${svc}"
  local op="patch"
  if ! ssh $SSH_OPTS root@"$VM_IP" \
    "kubectl exec -n openbao openbao-0 -- env BAO_TOKEN='${ROOT_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao kv metadata get '${path}'" \
    >/dev/null 2>&1; then
    op="put"
  fi
  printf '%s' "$v" | ssh $SSH_OPTS root@"$VM_IP" \
    "kubectl exec -i -n openbao openbao-0 -- env BAO_TOKEN='${ROOT_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao kv ${op} '${path}' '${k}=-'" \
    >/dev/null
}

# ══════════════════════════════════════════════════════════════
# Phase 5c: Seed OpenBao with auto-generated app secrets (task.0284)
# ══════════════════════════════════════════════════════════════
# Phase 2 (above) sourced .env.${DEPLOY_ENV}, which carries every secret
# auto-generated by bootstrap.sh + every operator pass-through (DATABASE_URL,
# AUTH_SECRET, ...). Seed them into the OpenBao path the ExternalSecret
# extracts so Phase 6's `kubectl apply -k` produces a populated k8s Secret,
# not an empty one.
#
# Per-service paths follow spec Invariant 1 (PATH_CONVENTION_PER_SERVICE_PER_ENV):
#   cogni/<env>/node-template/*    — primary node app
#   cogni/<env>/scheduler-worker/* — scheduler-worker service
#
# Operator-pass-through secrets that DON'T exist in .env.${DEPLOY_ENV}
# (OPENROUTER_API_KEY, OBSERVABILITY tokens, OAuth client creds, …) are
# entered post-bootstrap via `pnpm secrets:set` — fork-quickstart Step 6.7.
# Pods will start with empty values for those keys and fail loudly at runtime
# (Invariant 12 TRANSITION_SAFE).
log_step "Phase 5c: Reconcile .env.${DEPLOY_ENV} with OpenBao + VM truth, then seed"

if [[ ! -r "$OPENBAO_ROOT_TOKEN_LOCAL" ]]; then
  log_warn "Skipping seed — no root token (Phase 5b.2 did not produce one)."
  log_warn "Substrate is up but empty; pods will CrashLoop until secrets are entered manually."
else
  ROOT_TOKEN=$(cat "$OPENBAO_ROOT_TOKEN_LOCAL")
  : "${DOMAIN:?DOMAIN must be set before Phase 5c — required for derive-env keys}"
  export APP_BASE_URL="https://${DOMAIN}"
  export NEXTAUTH_URL="https://${DOMAIN}"

  # Re-run idempotency (bug.5081): pull existing values from OpenBao + VM
  # so Phase 2's regenerated randoms don't overwrite live state. Lib also
  # exports NODE_TEMPLATE_KEYS + SCHEDULER_WORKER_KEYS for the seed loop.
  # shellcheck source=lib/reconcile-secrets.sh
  source "$REPO_ROOT/scripts/setup/lib/reconcile-secrets.sh"
  reconcile_secrets_on_rerun

  log_info "Seeding cogni/${DEPLOY_ENV}/node-template/*..."
  for k in "${NODE_TEMPLATE_KEYS[@]}"; do seed_kv node-template "$k" "${!k:-}"; done
  log_info "Seeding cogni/${DEPLOY_ENV}/scheduler-worker/*..."
  for k in "${SCHEDULER_WORKER_KEYS[@]}"; do seed_kv scheduler-worker "$k" "${!k:-}"; done
  log_info "OpenBao paths seeded for ${DEPLOY_ENV}"

  # Write runtime/.env LAST so the VM gets reconciled values, not Phase-2
  # regenerations (see write_runtime_env_on_vm definition comment).
  log_info "Writing /opt/cogni-template-runtime/.env on VM with reconciled values..."
  write_runtime_env_on_vm
fi

# ══════════════════════════════════════════════════════════════
# Phase 5e: Grafana Cloud auto-mint (read + write) — one-root-token derivation
# ══════════════════════════════════════════════════════════════
# Operator pastes ONE Grafana Cloud admin token (glc_*) + GRAFANA_URL into
# GH-env-secrets. This phase derives BOTH paths from that single root:
#   1. Cloud-side bootstrap minter SA + glsa_ token (transient, runner-only)
#   2. Stack-side Viewer child SA + glsa_ read token (validator scorecard,
#      Loki+Prom+Postgres queries via $GRAFANA_URL/api/...)
#   3. Cloud access-policy + glc_ push token (Alloy → Loki/Prom remote write)
#
# Output → cogni/${DEPLOY_ENV}/_shared (Invariant 1 cross-service path,
# variable names match setup-secrets.ts entries):
#   GRAFANA_SERVICE_ACCOUNT_TOKEN  glsa_* child read
#   GRAFANA_URL                    stack URL
#   LOKI_WRITE_URL                 hosted-Loki push URL
#   LOKI_USERNAME                  numeric Loki user
#   LOKI_PASSWORD                  glc_* push token (= PROMETHEUS_PASSWORD)
#   PROMETHEUS_REMOTE_WRITE_URL    hosted-Mimir push URL
#   PROMETHEUS_USERNAME            numeric Prom user
#   PROMETHEUS_PASSWORD            glc_* push token (= LOKI_PASSWORD)
#
# Artifact: .local/${DEPLOY_ENV}-grafana-sa-token.json (8 fields, chmod 600,
# encrypted by the "Encrypt init artifacts" step in provision-env.yml).
#
# The glc_* admin root NEVER lands in OpenBao and NEVER reaches the VM —
# only the two derived tokens (glsa_ read + glc_ push) are seeded.
#
# Graceful skip: if GH_GRAFANA_CLOUD_ADMIN_TOKEN/GRAFANA_URL are unset, the
# mint script logs + exit 0 with no output. Bootstrap continues; scorecard
# row 5 stays 🟡. Observability is optional, never blocks bootstrap.
log_step "Phase 5e: Grafana Cloud auto-mint (optional)"

if [[ ! -r "$OPENBAO_ROOT_TOKEN_LOCAL" ]]; then
  log_warn "Skipping Phase 5e — no OpenBao root token; cannot seed cogni/${DEPLOY_ENV}/_shared"
elif [[ -z "${GRAFANA_CLOUD_ADMIN_TOKEN:-}" || -z "${GRAFANA_URL:-}" ]]; then
  log_info "Phase 5e skipped — GRAFANA_CLOUD_ADMIN_TOKEN/GRAFANA_URL unset (scorecard row 5 stays 🟡)"
else
  ROOT_TOKEN=$(cat "$OPENBAO_ROOT_TOKEN_LOCAL")

  # Mint runs on the runner — Cloud admin root never travels to the VM.
  MINT_OUT=$(REPO_ROOT="$REPO_ROOT" DEPLOY_ENV="$DEPLOY_ENV" FORK_SLUG="$FORK_SLUG" \
              GH_GRAFANA_CLOUD_ADMIN_TOKEN="$GRAFANA_CLOUD_ADMIN_TOKEN" \
              GRAFANA_URL="$GRAFANA_URL" \
              bash "$REPO_ROOT/scripts/setup/provision-grafana-cloud-mint.sh") \
    || { log_error "Grafana Cloud mint failed — continuing bootstrap; re-run after fixing creds"; MINT_OUT=""; }

  if [[ -n "$MINT_OUT" ]]; then
    # Parse the 8 KEY=VALUE lines emitted by the mint script.
    declare -A MINTED=()
    while IFS='=' read -r k v; do
      [[ -z "$k" ]] && continue
      MINTED[$k]="$v"
    done <<<"$MINT_OUT"

    SEED_OK=true
    for k in GRAFANA_SERVICE_ACCOUNT_TOKEN GRAFANA_URL \
             LOKI_WRITE_URL LOKI_USERNAME LOKI_PASSWORD \
             PROMETHEUS_REMOTE_WRITE_URL PROMETHEUS_USERNAME PROMETHEUS_PASSWORD; do
      if [[ -z "${MINTED[$k]:-}" ]]; then
        log_warn "Phase 5e: missing $k in mint output — skipping seed"
        SEED_OK=false
        break
      fi
    done

    if [[ "$SEED_OK" == "true" ]]; then
      log_info "Seeding 8 derived keys to cogni/${DEPLOY_ENV}/_shared"
      for k in GRAFANA_SERVICE_ACCOUNT_TOKEN GRAFANA_URL \
               LOKI_WRITE_URL LOKI_USERNAME LOKI_PASSWORD \
               PROMETHEUS_REMOTE_WRITE_URL PROMETHEUS_USERNAME PROMETHEUS_PASSWORD; do
        seed_kv _shared "$k" "${MINTED[$k]}"
      done
      # Export under the names deploy-infra.sh + provision-grafana-postgres-
      # datasources.sh expect (deploy-infra writes runtime/.env's
      # LOKI_*/PROMETHEUS_* from these GRAFANA_CLOUD_* runner-env names; the
      # datasource script reads GRAFANA_URL + GRAFANA_SERVICE_ACCOUNT_TOKEN
      # directly). MINT_OUT names match the *VM .env* convention; the runner
      # env contract is one indirection away — see deploy-infra.sh lines
      # 664-678.
      export GRAFANA_SERVICE_ACCOUNT_TOKEN="${MINTED[GRAFANA_SERVICE_ACCOUNT_TOKEN]}"
      export GRAFANA_URL="${MINTED[GRAFANA_URL]}"
      export GRAFANA_CLOUD_LOKI_URL="${MINTED[LOKI_WRITE_URL]}"
      export GRAFANA_CLOUD_LOKI_USER="${MINTED[LOKI_USERNAME]}"
      export GRAFANA_CLOUD_LOKI_API_KEY="${MINTED[LOKI_PASSWORD]}"
      export PROMETHEUS_REMOTE_WRITE_URL="${MINTED[PROMETHEUS_REMOTE_WRITE_URL]}"
      export PROMETHEUS_USERNAME="${MINTED[PROMETHEUS_USERNAME]}"
      export PROMETHEUS_PASSWORD="${MINTED[PROMETHEUS_PASSWORD]}"
      log_info "Grafana auto-mint complete for ${DEPLOY_ENV}"
    else
      log_info "Phase 5e: mint script produced incomplete output (graceful skip)"
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════
# Phase 5f: Bring up full Compose runtime via deploy-infra.sh
# ══════════════════════════════════════════════════════════════
# Reuse the canonical CI primitive that candidate-flight-infra.yml + promote-
# and-deploy.yml call. It rsyncs infra/compose/** to the VM, writes the .env,
# brings the full runtime stack up (postgres, temporal, redis, litellm,
# *alloy*, *alloy-k8s-events*, autoheal, repo-init, git-sync), runs
# db-provision + ensure-temporal-namespace, and is idempotent on re-runs.
#
# deploy-infra.sh expects ~/.ssh/deploy_key + known_hosts populated. The
# bootstrap already has .local/${DEPLOY_ENV}-vm-key; we copy it to the CI
# location and ssh-keyscan the VM IP so the script's StrictHostKeyChecking=yes
# clears.
#
# All required deploy-infra env vars are exported by Phase 2 (`set -a; source
# $ENV_FILE`); Phase 5e exports the GRAFANA_CLOUD_LOKI_*/PROMETHEUS_*
# observability vars. VM_HOST is overridden with the freshly-provisioned IP
# because .env.${DEPLOY_ENV}'s value may be a DNS name that doesn't yet
# resolve. REF is the runner's checkout SHA so the rsync source is the
# tree currently being provisioned (not main).
log_step "Phase 5f: Bring up full Compose runtime (deploy-infra.sh)"

mkdir -p ~/.ssh && chmod 700 ~/.ssh
cp "$SSH_KEY" ~/.ssh/deploy_key
chmod 600 ~/.ssh/deploy_key
KEYSCAN_OUT=$(ssh-keyscan -T 10 -H "$VM_IP" 2>/dev/null || true)
if [[ -n "$KEYSCAN_OUT" ]]; then
  printf '%s\n' "$KEYSCAN_OUT" >>~/.ssh/known_hosts
else
  log_warn "ssh-keyscan returned no host keys for $VM_IP — deploy-infra.sh's StrictHostKeyChecking=yes will likely fail next."
fi

REF_FOR_INFRA="${GITHUB_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
log_info "Invoking deploy-infra.sh --ref ${REF_FOR_INFRA} (VM_HOST=${VM_IP})"

# Force the CI-shaped env for this one invocation; do not pollute the parent
# scope with VM_HOST/SSH_KEY_PATH/DEPLOY_ENVIRONMENT overrides. LITELLM_IMAGE
# pins to the locally-built tag (Phase 5 built cogni-litellm:latest on the VM
# already), preventing deploy-infra's GHCR default from triggering a pull
# the fork has no access to.
VM_HOST="$VM_IP" \
SSH_KEY_PATH="$HOME/.ssh/deploy_key" \
DEPLOY_ENVIRONMENT="$DEPLOY_ENV" \
APP_ENV="$APP_ENV" \
COGNI_REPO_URL="$COGNI_REPO_URL" \
COGNI_REPO_REF="$COGNI_REPO_REF" \
DATABASE_URL="$DATABASE_URL" \
DATABASE_SERVICE_URL="$DATABASE_SERVICE_URL" \
LITELLM_IMAGE="cogni-litellm:latest" \
bash "$REPO_ROOT/scripts/ci/deploy-infra.sh" --ref "$REF_FOR_INFRA"

log_info "Phase 5f: full runtime stack up"

# ══════════════════════════════════════════════════════════════
# Phase 5g: Register Postgres datasource at Grafana (optional)
# ══════════════════════════════════════════════════════════════
# Reuses scripts/ci/provision-grafana-postgres-datasources.sh — the same
# script candidate-flight-infra.yml + promote-and-deploy.yml call. Skips
# gracefully when Grafana creds OR GRAFANA_PDC_NETWORK_UUID are absent.
#
# Fresh-fork reality: GRAFANA_PDC_NETWORK_UUID is the *internal* Grafana
# network UUID, which only exists once the operator has manually bound a
# datasource to PDC at least once (see comment in the script + the readonly
# runbook). For a clean fork without PDC, this phase is a no-op; the
# datasource gets registered the first time candidate-flight runs after the
# operator wires GRAFANA_PDC_NETWORK_UUID into GH env secrets.
log_step "Phase 5g: Register Postgres datasource at Grafana (optional)"

if [[ -z "${GRAFANA_URL:-}" || -z "${GRAFANA_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  log_info "Phase 5g skipped — Grafana creds absent (Phase 5e did not mint or was disabled)"
elif [[ -z "${GRAFANA_PDC_NETWORK_UUID:-}" ]]; then
  log_info "Phase 5g skipped — GRAFANA_PDC_NETWORK_UUID unset"
  log_info "  This is expected for a fresh fork. After bootstrap, bind one Postgres"
  log_info "  datasource via the Grafana UI (PDC network), copy its"
  log_info "  jsonData.secureSocksProxyUsername into GH env secret"
  log_info "  GRAFANA_PDC_NETWORK_UUID, then re-run candidate-flight-infra.yml."
else
  log_info "Invoking provision-grafana-postgres-datasources.sh"
  if ! DEPLOY_ENVIRONMENT="$DEPLOY_ENV" \
       POSTGRES_ROOT_PASSWORD="$POSTGRES_ROOT_PASSWORD" \
       GRAFANA_URL="$GRAFANA_URL" \
       GRAFANA_SERVICE_ACCOUNT_TOKEN="$GRAFANA_SERVICE_ACCOUNT_TOKEN" \
       GRAFANA_PDC_NETWORK_UUID="$GRAFANA_PDC_NETWORK_UUID" \
       COGNI_NODE_DBS="$COGNI_NODE_DBS" \
       APP_DB_READONLY_USER="${APP_DB_READONLY_USER:-app_readonly}" \
       APP_DB_READONLY_PASSWORD="${APP_DB_READONLY_PASSWORD:-}" \
       bash "$REPO_ROOT/scripts/ci/provision-grafana-postgres-datasources.sh"; then
    log_warn "Phase 5g: datasource registration failed — continuing bootstrap"
  else
    log_info "Phase 5g: Postgres datasources registered at $GRAFANA_URL"
  fi
fi

# ══════════════════════════════════════════════════════════════
# Phase 6: Apply ExternalSecret manifests (ESO materializes the k8s Secrets)
# ══════════════════════════════════════════════════════════════
# task.0284 — replaces the pre-substrate imperative `kubectl create secret
# generic ...` block. App secrets now flow OpenBao → ESO → native k8s Secret.
# Phase 5b auto-inits + auto-unseals OpenBao + auto-binds the eso-reader role;
# Phase 5c seeds the per-service paths from .env.${DEPLOY_ENV}. By the time
# this phase runs the substrate is populated for the keys the fork generated,
# and ESO can reconcile on first apply.
#
# Bootstrap dependency order (enforced by Phase 5 → 6 → 7 sequencing):
#   1. OpenBao + ESO installed (Phase 5b.1)
#   2. OpenBao init + unseal + KV mount + Kubernetes auth + eso-reader (5b.2-3)
#   3. ClusterSecretStore applied (5b.4)
#   4. OpenBao paths seeded with auto-generated app secrets (Phase 5c)
#   5. ExternalSecret CRDs applied (this phase) — ESO syncs Secret resources
#   6. ApplicationSets applied (Phase 7) — pods consume via envFrom: secretRef
#
# TRANSITION_SAFE: operator-pass-through keys NOT in .env.${DEPLOY_ENV}
# (OPENROUTER_API_KEY, GRAFANA_CLOUD_LOKI_*, ...) remain empty until the
# operator runs `pnpm secrets:set` post-bootstrap (docs/runbooks/
# fork-quickstart.md Step 6.7). Pods that consume those keys CrashLoop on
# missing envFrom values — loud-by-design (Spec Invariant 12).
log_step "Phase 6: Apply ExternalSecret manifests"

# Apply each leaf ExternalSecret kustomization directly using LOCAL kubectl —
# no SSH-for-kubectl, no rsync of partial repo subtree. Kustomize runs here
# with full repo context, so any references (relative paths, components,
# generators) resolve against the operator's checkout. This is the
# canonical pattern called out in .claude/skills/cicd-secrets-expert
# anti-patterns ("ssh root@vm kubectl ... — use local kubectl").
#
# Leaves are enumerated from the two SSOT trees per secrets-classification.md:
#   - infra/k8s/secrets/external-secrets/<env>/<svc>/    (operator-domain)
#   - nodes/<node>/k8s/external-secrets/<env>/           (node-domain, A2)
# An aggregator kustomization is deliberately absent — every prior incarnation
# leaked a relative-up ref (../../../../../nodes/...) which broke remote
# apply paths. Self-contained leaves compose without that smell.
#
# ClusterSecretStore is applied earlier at Phase 5b.5 (cluster-scoped,
# env-independent — does not belong in this loop).

# Create namespace (Argo CD creates it on first sync, but ExternalSecret needs it now)
KUBECONFIG="$KUBECONFIG_LOCAL" kubectl create namespace "$K8S_NAMESPACE" \
  --dry-run=client -o yaml | \
  KUBECONFIG="$KUBECONFIG_LOCAL" kubectl apply -f -

ES_APPLIED=0

# Operator-domain leaves: infra/k8s/secrets/external-secrets/<env>/<svc>/
for svc_dir in "$REPO_ROOT"/infra/k8s/secrets/external-secrets/"${DEPLOY_ENV}"/*/; do
  [[ -d "$svc_dir" && -f "$svc_dir/kustomization.yaml" ]] || continue
  svc=$(basename "${svc_dir%/}")
  KUBECONFIG="$KUBECONFIG_LOCAL" kubectl -n "$K8S_NAMESPACE" apply -k "$svc_dir"
  log_info "  applied operator-domain ExternalSecret: $svc"
  ES_APPLIED=$((ES_APPLIED + 1))
done

# Node-domain leaves: nodes/<node>/k8s/external-secrets/<env>/
for node_es_dir in "$REPO_ROOT"/nodes/*/k8s/external-secrets/"${DEPLOY_ENV}"/; do
  [[ -d "$node_es_dir" && -f "$node_es_dir/kustomization.yaml" ]] || continue
  rel="${node_es_dir#"$REPO_ROOT"/nodes/}"
  node_name="${rel%%/*}"
  KUBECONFIG="$KUBECONFIG_LOCAL" kubectl -n "$K8S_NAMESPACE" apply -k "$node_es_dir"
  log_info "  applied node-domain ExternalSecret: $node_name"
  ES_APPLIED=$((ES_APPLIED + 1))
done

if [[ $ES_APPLIED -eq 0 ]]; then
  log_warn "No ExternalSecret manifests applied for ${DEPLOY_ENV}."
  log_warn "Pods consuming envFrom: secretRef will CrashLoop until the operator"
  log_warn "adds an ExternalSecret kustomization under either"
  log_warn "  infra/k8s/secrets/external-secrets/${DEPLOY_ENV}/<svc>/, or"
  log_warn "  nodes/<node>/k8s/external-secrets/${DEPLOY_ENV}/"
else
  log_info "Applied ${ES_APPLIED} ExternalSecret manifest(s) for ${DEPLOY_ENV}"
fi

# ══════════════════════════════════════════════════════════════
# Phase 7: Deployment Status Report (Scorecard)
# ══════════════════════════════════════════════════════════════
# ══════════════════════════════════════════════════════════════
# Phase 7: Apply ApplicationSets (LAST — all prerequisites ready)
# ══════════════════════════════════════════════════════════════
log_step "Phase 7: Apply ApplicationSets (triggers Argo sync)"

# Apply the ApplicationSet for this environment via SCP from the local repo checkout.
# task.0284 — the pre-substrate prerequisite gate (`kubectl get secret node-app-
# secrets` etc.) is intentionally removed: ESO materializes those Secrets
# asynchronously from OpenBao, so a hard-gate here would either always fail
# (cold cluster, OpenBao not yet seeded) or always pass for the wrong reason
# (stale Secret from a prior provision still cached). The ExternalSecret status
# is the authoritative readiness signal; surface it via `kubectl describe
# externalsecret -n ${K8S_NAMESPACE}` post-apply.
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

# B1 (deploy machinery) — substitute repoURL to point at the FORK, not the
# upstream. AppSet files commit with the canonical Cogni-DAO/node-template
# URL; provision rewrites at apply time so Argo CD syncs from the fork's
# own deploy/* branches. Idempotent for the canonical operator (no-op).
APPSET_RENDERED=$(mktemp)
trap 'rm -f "$APPSET_RENDERED"' EXIT
sed -E "s#https://github\.com/[Cc]ogni-[Dd][Aa][Oo]/node-template\.git#https://github.com/${GH_REPO}.git#g" \
  "$APPSET_LOCAL" > "$APPSET_RENDERED"
log_info "AppSet repoURL substituted: → https://github.com/${GH_REPO}.git"

scp $SSH_OPTS "$APPSET_RENDERED" root@"$VM_IP":/tmp/appset.yaml
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
# Diagnostic dump on /readyz failure — same shape as the Phase 4 + 5b
# helpers. The app tier has its own state surfaces worth capturing on a
# RED outcome: pod conditions (Init:Error vs CrashLoopBackOff vs Pending),
# the init-container's actual log (this is where bug.0446 H8a class
# failures surface), ExternalSecret sync state (Invariant 12 — pods
# fail loud when their secret is empty), the Secret's data keys
# (NEVER values — only key NAMES, to surface missing-key wiring vs
# missing-value cases), and recent events. Without this, validators
# see a pod LIST and have to guess which surface to interrogate.
phase_9_diagnostic() {
  log_info "Attempting Phase 9 diagnostic dump (10s ssh budget)..."
  set +e
  ssh -i "$SSH_KEY" \
      -o StrictHostKeyChecking=no \
      -o ConnectTimeout=10 \
      -o ConnectionAttempts=1 \
      root@"$VM_IP" "
echo '=== pods (${K8S_NAMESPACE}) ==='
kubectl -n ${K8S_NAMESPACE} get pods -o wide 2>&1
echo
echo '=== node-app pod describe (tail) ==='
kubectl -n ${K8S_NAMESPACE} describe pod -l app.kubernetes.io/name=node-app 2>&1 | tail -80
echo
echo '=== node-app init (migrate) logs — prefer --previous, fallback current ==='
pod=\$(kubectl -n ${K8S_NAMESPACE} get pod -l app.kubernetes.io/name=node-app -o name | head -1)
kubectl -n ${K8S_NAMESPACE} logs \$pod -c migrate --tail=80 --previous 2>&1 || kubectl -n ${K8S_NAMESPACE} logs \$pod -c migrate --tail=80 2>&1
echo
echo '=== node-app main container logs (tail 80) ==='
kubectl -n ${K8S_NAMESPACE} logs \$pod -c app --tail=80 --previous 2>&1 || kubectl -n ${K8S_NAMESPACE} logs \$pod -c app --tail=80 2>&1
echo
echo '=== scheduler-worker pod describe (tail) ==='
kubectl -n ${K8S_NAMESPACE} describe pod -l app.kubernetes.io/name=scheduler-worker 2>&1 | tail -80
echo
echo '=== scheduler-worker logs (tail 80, prefer --previous) ==='
sw=\$(kubectl -n ${K8S_NAMESPACE} get pod -l app.kubernetes.io/name=scheduler-worker -o name | head -1)
kubectl -n ${K8S_NAMESPACE} logs \$sw --tail=80 --previous 2>&1 || kubectl -n ${K8S_NAMESPACE} logs \$sw --tail=80 2>&1
echo
echo '=== ExternalSecrets sync state ==='
kubectl -n ${K8S_NAMESPACE} get externalsecret -o wide 2>&1
echo
echo '=== k8s Secret data keys (key NAMES only, never values) ==='
kubectl -n ${K8S_NAMESPACE} get secret node-template-env-secrets -o jsonpath='{.data}' 2>&1 | jq 'keys' 2>&1 || echo '(secret not yet materialized by ESO)'
echo
echo '=== recent events (sorted, ${K8S_NAMESPACE}, last 40) ==='
kubectl -n ${K8S_NAMESPACE} get events --sort-by=.lastTimestamp 2>&1 | tail -40
"
  local diag_rc=$?
  set -e
  if [[ $diag_rc -ne 0 ]]; then
    log_warn "  diagnostic SSH itself failed (rc=${diag_rc}) — VM may be unreachable."
  fi
}

log_step "Phase 9: Verify /readyz on all nodes (up to 5 min)"

READYZ_OK=true
for node in "${NODE_TARGETS[@]}"; do
  catalog_file="$REPO_ROOT/infra/catalog/${node}.yaml"
  node_port=$(yq -N '.node_port // ""' "$catalog_file" 2>/dev/null)
  if [[ -z "$node_port" || "$node_port" == "null" ]]; then
    log_warn "  ${node}: no node_port in ${catalog_file}; skipping /readyz"
    continue
  fi
  NODE_OK=false
  for attempt in $(seq 1 30); do
    STATUS=$(ssh $SSH_OPTS root@"$VM_IP" "curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 http://localhost:${node_port}/readyz" 2>/dev/null || echo "000")
    if [[ "$STATUS" == "200" ]]; then
      log_info "  ${node} (${node_port}): /readyz 200 ✅"
      NODE_OK=true
      break
    fi
    if (( attempt % 6 == 0 )); then
      log_info "  ${node} (${node_port}): waiting... (${attempt}0s, last status: ${STATUS})"
    fi
    sleep 10
  done
  if [[ "$NODE_OK" != "true" ]]; then
    log_error "  ${node} (${node_port}): /readyz FAILED after 5 min ❌"
    READYZ_OK=false
  fi
done

# ══════════════════════════════════════════════════════════════
# Phase 9a: Verify public /readyz via Cloudflare → Caddy → app
# ══════════════════════════════════════════════════════════════
# Phase 9 confirmed the app responds at the k3s NodePort on the VM's
# loopback. Phase 9a probes the full edge path that real users hit:
# Cloudflare proxy → Caddy (tls internal, CF Full mode) → app. This
# catches:
#   * Caddy `tls internal` cold-start race (Caddy needs ~1-5s to
#     generate its internal CA cert on first request — Cloudflare
#     probing in that window returns 525)
#   * CF zone SSL mode misconfiguration (Phase 4b sets "full"; if
#     someone manually flipped to "full strict" the self-signed
#     origin cert would be rejected)
#   * DNS propagation gaps (Phase 4b just created the records; CF
#     proxied records propagate within ~30s in practice)
#
# SOFT-WARN by design: Phase 9 already hard-fails if the app is
# genuinely broken at the NodePort; Phase 9a is a pure edge-path
# observability check. A transient edge failure should not block
# artifact encryption + upload — the validator scorecard surfaces
# the result. Persistent failure here = ops investigation.
log_step "Phase 9a: Verify public /readyz via Cloudflare (up to 2 min)"

if [[ -z "${DOMAIN:-}" ]]; then
  log_warn "  DOMAIN unset — skipping public probe"
else
  PUBLIC_OK=false
  for attempt in $(seq 1 24); do
    STATUS=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://${DOMAIN}/readyz" 2>/dev/null || echo "000")
    if [[ "$STATUS" == "200" ]]; then
      log_info "  https://${DOMAIN}/readyz 200 ✅ (after $((attempt * 5))s)"
      PUBLIC_OK=true
      break
    fi
    if (( attempt % 4 == 0 )); then
      log_info "  https://${DOMAIN}/readyz waiting... ($((attempt * 5))s, last status: ${STATUS})"
    fi
    sleep 5
  done
  if [[ "$PUBLIC_OK" != "true" ]]; then
    log_warn "  https://${DOMAIN}/readyz did not return 200 within 120s (last status: ${STATUS})"
    log_warn "  This is a SOFT warn — Phase 9 already verified the app at the NodePort."
    log_warn "  Likely causes: Caddy tls-internal CA cold-start race; CF SSL mode != 'full';"
    log_warn "  DNS propagation lag. Re-probe manually: curl -I https://${DOMAIN}/readyz"
  fi
fi

echo ""
if [[ "$READYZ_OK" == "true" ]]; then
  log_info "═══ ALL NODES HEALTHY — CANARY IS GREEN ═══"
  exit 0
else
  log_error "═══ SOME NODES FAILED /readyz — CANARY IS RED ═══"
  phase_9_diagnostic
  log_error "Debug: ssh -i .local/${DEPLOY_ENV}-vm-key root@$VM_IP 'kubectl -n ${K8S_NAMESPACE} logs -l app.kubernetes.io/name=node-app --tail=20'"
  exit 1
fi
