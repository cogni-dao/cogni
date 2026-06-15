#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-env-substrate.sh <env> — tofu-free, idempotent reconcile of an
# environment's OpenBao auth/role/SA substrate (the layer BENEATH the per-node
# substrate runner). Extracted verbatim from provision-env-vm.sh Phase 5b.3-5b.5
# so it is callable WITHOUT a full tofu provision — closing the drift where prod
# (missing db-provisioner) and preview (missing both writer + db-provisioner)
# diverged because Phase 5b only ran inside cold-start provisioning.
#
# Every operation is an upsert / create-if-absent — running it against a live env
# ADDS what's missing non-destructively and a re-run is a no-op. It NEVER inits,
# unseals, or touches data; it only reconciles:
#   - KV v2 mount cogni/ + kubernetes + github-actions auth methods
#   - eso-reader        policy + role  (ESO controller SA, read-only, all envs)
#   - <env>-writer      policy + role  (openbao-writer SA, per-env RW; jwt twin)
#   - <env>-db-reader   policy + role  (db-provisioner SA, per-env read-only)
#   - ClusterSecretStore openbao-backend
#
# RENAME (additive, safe): the writer SA is `openbao-writer` (was `openbao-operator`).
# The <env>-writer role binds BOTH names during transition, so consumers still on
# the old name keep working until every env is reconciled; the consumer flip
# (secret-materialize.sh → openbao-writer) + dropping openbao-operator is the gated
# follow-up. Both SAs are created here so either token mints.
#
# Auth: needs the env's OpenBao root token (policy/role writes are root-gated).
# Provide via OPENBAO_ROOT_TOKEN, or OPENBAO_ROOT_TOKEN_LOCAL (a file path). The
# token is passed transiently to the pod via env, never persisted (Invariant 13).
#
# Env: VM_IP (or VM_HOST), SSH_OPTS, GH_REPO. Usage: reconcile-env-substrate.sh <env>

set -euo pipefail

DEPLOY_ENV="${1:?usage: reconcile-env-substrate.sh <candidate-a|preview|production>}"
[[ "$DEPLOY_ENV" =~ ^(candidate-a|preview|production)$ ]] || { echo "❌ unsupported env: $DEPLOY_ENV" >&2; exit 2; }

VM_IP="${VM_IP:-${VM_HOST:-}}"
[[ -n "$VM_IP" ]] || { echo "❌ VM_IP (or VM_HOST) is required" >&2; exit 2; }
GH_REPO="${GH_REPO:?GH_REPO is required (owner/repo for the GHA OIDC writer role)}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=accept-new -o ConnectTimeout=30}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ROOT_TOKEN="${OPENBAO_ROOT_TOKEN:-}"
if [[ -z "$ROOT_TOKEN" && -n "${OPENBAO_ROOT_TOKEN_LOCAL:-}" && -r "$OPENBAO_ROOT_TOKEN_LOCAL" ]]; then
  ROOT_TOKEN="$(cat "$OPENBAO_ROOT_TOKEN_LOCAL")"
fi
[[ -n "$ROOT_TOKEN" ]] || { echo "❌ root token required (set OPENBAO_ROOT_TOKEN or OPENBAO_ROOT_TOKEN_LOCAL)" >&2; exit 2; }

log() { printf '[reconcile-env-substrate] %s\n' "$*"; }

# shellcheck disable=SC2086  # SSH_OPTS is an intentional word-split option string
remote() { ssh $SSH_OPTS "root@${VM_IP}" "$@"; }
bao_exec() {
  remote "kubectl exec -n openbao openbao-0 -- env BAO_TOKEN='${ROOT_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao $*"
}
bao_policy() {
  # bao_policy <name> < HCL-on-stdin
  # shellcheck disable=SC2086
  ssh $SSH_OPTS "root@${VM_IP}" \
    "kubectl exec -i -n openbao openbao-0 -- env BAO_TOKEN='${ROOT_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao policy write $1 -"
}
ensure_sa() {
  remote "kubectl get sa $1 -n default >/dev/null 2>&1 || kubectl create sa $1 -n default"
}

# Fail-loud deploy-pointer preflight. A stale VM_HOST/SSH_DEPLOY_KEY (env VM migrated or
# rebuilt without re-pointing VM_HOST, SSH_DEPLOY_KEY, and the <env>.vm.cognidao.org DNS
# record) otherwise surfaces as a cryptic mid-run SSH timeout or 'Permission denied'. Catch
# it up front with a diagnosis. See .claude/skills/devops-expert 'VM migration orphans deploy pointers'.
if ! ssh $SSH_OPTS -o BatchMode=yes -o ConnectTimeout=15 "root@${VM_IP}" true 2>/tmp/_vmprobe; then
  # Classify into a stable reason; NEVER echo the host/IP or raw ssh stderr
  # (privacy: docs/spec/observability.md §5 — stable fields only, no secrets).
  reason=unreachable
  grep -qi 'permission denied' /tmp/_vmprobe && reason=auth_denied
  rm -f /tmp/_vmprobe
  echo "::error::${DEPLOY_ENV}: VM SSH preflight failed (reason=${reason}) — deploy-pointer drift. The ${DEPLOY_ENV} VM was likely migrated/rebuilt without re-pointing VM_HOST, SSH_DEPLOY_KEY, and the ${DEPLOY_ENV}.vm.cognidao.org DNS record. Verify VM_HOST resolves to the live Cherry VM and SSH_DEPLOY_KEY matches it. See .claude/skills/devops-expert." >&2
  exit 1
fi
rm -f /tmp/_vmprobe

log "reconciling OpenBao substrate for env '${DEPLOY_ENV}' on ${VM_IP}"

# ── KV v2 mount + kubernetes auth (idempotent: list-then-enable) ─────────────
if ! bao_exec "secrets list -format=json" 2>/dev/null | jq -e '."cogni/"' >/dev/null 2>&1; then
  log "mounting KV v2 at cogni/..."; bao_exec "secrets enable -path=cogni -version=2 kv" >/dev/null
else log "KV v2 mount cogni/ already present"; fi

if ! bao_exec "auth list -format=json" 2>/dev/null | jq -e '."kubernetes/"' >/dev/null 2>&1; then
  log "enabling kubernetes auth method..."; bao_exec "auth enable kubernetes" >/dev/null
else log "kubernetes auth method already enabled"; fi
bao_exec "write auth/kubernetes/config kubernetes_host=https://kubernetes.default.svc:443" >/dev/null

# ── eso-reader (ESO controller SA, read-only, env-wide) ──────────────────────
log "writing eso-reader policy + role..."
bao_policy eso-reader <<'HCL'
path "cogni/data/*"     { capabilities = ["read"] }
path "cogni/metadata/*" { capabilities = ["read", "list"] }
HCL
bao_exec "write auth/kubernetes/role/eso-reader \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=eso-reader ttl=1h" >/dev/null

# ── <env>-writer (openbao-writer SA; additive bind keeps openbao-operator) ───
log "writing ${DEPLOY_ENV}-writer policy + role (SA openbao-writer + openbao-operator)..."
ensure_sa openbao-writer
ensure_sa openbao-operator
bao_policy "${DEPLOY_ENV}-writer" <<HCL
path "cogni/data/${DEPLOY_ENV}/*"     { capabilities = ["read", "create", "update", "patch"] }
path "cogni/metadata/${DEPLOY_ENV}/*" { capabilities = ["read", "list"] }
HCL
bao_exec "write auth/kubernetes/role/${DEPLOY_ENV}-writer \
  bound_service_account_names=openbao-writer,openbao-operator \
  bound_service_account_namespaces=default \
  policies=${DEPLOY_ENV}-writer ttl=1h" >/dev/null

# ── <env>-db-reader (db-provisioner SA, read-only, env-wide) ─────────────────
log "writing ${DEPLOY_ENV}-db-reader policy + role (SA db-provisioner)..."
ensure_sa db-provisioner
bao_policy "${DEPLOY_ENV}-db-reader" <<HCL
path "cogni/data/${DEPLOY_ENV}/*"     { capabilities = ["read"] }
path "cogni/metadata/${DEPLOY_ENV}"   { capabilities = ["list"] }
path "cogni/metadata/${DEPLOY_ENV}/*" { capabilities = ["read", "list"] }
HCL
bao_exec "write auth/kubernetes/role/${DEPLOY_ENV}-db-reader \
  bound_service_account_names=db-provisioner \
  bound_service_account_namespaces=default \
  policies=${DEPLOY_ENV}-db-reader ttl=15m" >/dev/null

# ── GitHub Actions OIDC writer (jwt twin of <env>-writer policy) ─────────────
if ! bao_exec "auth list -format=json" 2>/dev/null | jq -e '."github-actions/"' >/dev/null 2>&1; then
  log "enabling github-actions (jwt) auth method..."; bao_exec "auth enable -path=github-actions jwt" >/dev/null
else log "github-actions (jwt) auth method already enabled"; fi
bao_exec "write auth/github-actions/config \
  oidc_discovery_url=https://token.actions.githubusercontent.com \
  bound_issuer=https://token.actions.githubusercontent.com" >/dev/null
bao_exec "write auth/github-actions/role/gha-${DEPLOY_ENV}-writer \
  role_type=jwt user_claim=sub \
  bound_subject=repo:${GH_REPO}:environment:${DEPLOY_ENV} \
  bound_audiences=cogni-openbao \
  policies=${DEPLOY_ENV}-writer \
  token_ttl=10m token_max_ttl=10m token_num_uses=3" >/dev/null

# ── ClusterSecretStore (ESO store binding) ───────────────────────────────────
CSS_LOCAL="$REPO_ROOT/infra/k8s/secrets/external-secrets/cluster-secret-store.yaml"
if [[ -r "$CSS_LOCAL" ]]; then
  log "applying ClusterSecretStore openbao-backend..."
  # shellcheck disable=SC2086
  scp $SSH_OPTS "$CSS_LOCAL" "root@${VM_IP}:/tmp/cluster-secret-store.yaml"
  remote "kubectl apply -f /tmp/cluster-secret-store.yaml >/dev/null && rm -f /tmp/cluster-secret-store.yaml"
else
  log "WARN: ClusterSecretStore manifest not found at $CSS_LOCAL — skipping"
fi

log "substrate reconciled for ${DEPLOY_ENV} (idempotent; re-run is a no-op)"
