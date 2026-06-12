#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Secret-reconciliation helpers for provision-env-vm.sh Phase 5c (bug.5081).
# Sourced — callers own shell options.
#
# Problem: bootstrap.sh Phase 2's `declare_or_gen` is idempotent against
# `.env.<env>`, but on a GHA runner the file doesn't survive the ephemeral
# FS, so every dispatch regenerates fresh random values. Without reconcile,
# Phase 5c then overwrites OpenBao (corrupting pod secrets) and Phase 5f
# writes runtime/.env with values that don't match the persisted postgres/
# temporal data dirs (immediate `password authentication failed`).
#
# Two reconcile sources, two disjoint key sets:
#   1. OpenBao SSoT  → keys delivered to k8s pods via ESO
#   2. VM runtime/.env truth → Compose-only keys (postgres bootstraps directly
#                              from this file; never reaches OpenBao)
#
# Caller contract (globals expected at invocation time):
#   DEPLOY_ENV, ROOT_TOKEN, VM_IP, SSH_OPTS, REPO_ROOT,
#   PRIMARY_NODE_DB, APP_DB_USER, APP_DB_SERVICE_USER, DOMAIN,
#   POSTGRES_ROOT_PASSWORD, optional DOLTGRES_PASSWORD
# Caller's seed loop iterates the arrays exported here:
#   NODE_TEMPLATE_KEYS, SCHEDULER_WORKER_KEYS

# ── Per-service key arrays — single source for both reconcile + seed ──────────
# Note: operator-passthrough keys (OPENROUTER_API_KEY, POSTHOG_*, EVM_RPC_URL,
# POLYGON_RPC_URL) ARE reconciled from OpenBao on
# re-runs. This matches the SSoT contract: day-2 rotations use
# `pnpm secrets:set` (which writes OpenBao directly); `gh secret set` +
# re-dispatch is bootstrap-only and will NOT propagate a value change for
# these keys past first provision.
#
# NODE_BASELINE_KEYS = the universe of app keys a node MAY consume. The
# per-node fan-out (seed_node_app_secrets) gates each key against the node's
# capabilities via infra/secrets-catalog.yaml (CATALOG_IS_SSOT): a `service:`-
# pinned A2 key (POLY_WALLET_AEAD_*, POLYGON_RPC_URL → poly) is dropped from
# nodes that don't own it. Drift between this list and the catalog's
# node-baseline set is guarded by scripts/ci/tests/secrets-fanout.test.sh.
declare -ga NODE_BASELINE_KEYS=(
  AUTH_SECRET LITELLM_MASTER_KEY
  SCHEDULER_API_TOKEN BILLING_INGEST_TOKEN
  INTERNAL_OPS_TOKEN METRICS_TOKEN GH_WEBHOOK_SECRET
  CONNECTIONS_ENCRYPTION_KEY POLY_WALLET_AEAD_KEY_HEX
  POLY_WALLET_AEAD_KEY_ID
  APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD
  DATABASE_URL DATABASE_SERVICE_URL
  DOLTGRES_PASSWORD DOLTGRES_URL
  POSTHOG_API_KEY POSTHOG_HOST OPENROUTER_API_KEY
  EVM_RPC_URL POLYGON_RPC_URL
  APP_BASE_URL NEXTAUTH_URL
  # External integrations (source: human, gate-by-presence). _node_gets_key
  # gates each against the catalog: _shared/llm/web reach every node; PRIVY_*
  # (appliesTo: payments) + PRIVY_USER_WALLETS_* (service: poly) drop from
  # non-poly nodes. GH_REVIEW_APP_* lives here for the node-app pods (operator
  # owns the GitHub App auth). Per bug.5000 it is NO LONGER in
  # SCHEDULER_WORKER_KEYS — the worker HTTP-delegates review GitHub I/O to the
  # operator and holds no GitHub credential.
  DOLTHUB_OWNER DOLT_CREDS_JWK DOLT_CREDS_KEYID DOLTHUB_API_TOKEN
  TAVILY_API_KEY
  LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_BASE_URL
  GH_OAUTH_CLIENT_ID GH_OAUTH_CLIENT_SECRET
  DISCORD_OAUTH_CLIENT_ID DISCORD_OAUTH_CLIENT_SECRET
  GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET
  DISCORD_BOT_TOKEN
  GH_REVIEW_APP_ID GH_REVIEW_APP_PRIVATE_KEY_BASE64
  PRIVY_APP_ID PRIVY_APP_SECRET PRIVY_SIGNING_KEY
  PRIVY_USER_WALLETS_APP_ID PRIVY_USER_WALLETS_APP_SECRET PRIVY_USER_WALLETS_SIGNING_KEY
)
# Back-compat alias — reconcile_secrets_on_rerun reconciles the primary node's
# OpenBao SSoT into .env for the runtime/.env (Compose) write.
declare -ga NODE_TEMPLATE_KEYS=("${NODE_BASELINE_KEYS[@]}")
declare -ga SCHEDULER_WORKER_KEYS=(
  DATABASE_SERVICE_URL SCHEDULER_API_TOKEN GH_WEBHOOK_SECRET
  INTERNAL_OPS_TOKEN
)
# Compose-tier secrets — bootstrap postgres/temporal directly via runtime/.env,
# never seeded to OpenBao. Truth lives on the VM after first provision.
declare -ga COMPOSE_ONLY_KEYS=(
  POSTGRES_ROOT_PASSWORD
  APP_DB_READONLY_PASSWORD
  TEMPORAL_DB_PASSWORD
)
# APP_DB_PASSWORD / APP_DB_SERVICE_PASSWORD / DOLTGRES_PASSWORD moved to
# NODE_BASELINE_KEYS (materialized to cogni/<env>/<node>) — each precedes its DSN
# so the composition reads the OpenBao value. APP_DB_* are per-node source:agent;
# DOLTGRES_PASSWORD is the env-level Doltgres superuser, derived from
# POSTGRES_ROOT_PASSWORD (salt doltgres-root) and written per-node so DOLTGRES_URL
# is OpenBao-sole-source (Invariant 15) — the pod connects as that superuser
# because Doltgres 0.56.3 RBAC is table-DML-only (databases.md §5.2). The same
# value lands in every node path; provisioners read it set-once. APP_DB_READONLY_PASSWORD
# stays Compose-only (env-level Grafana role, not pod-facing).

# ── Catalog-gated per-node fan-out (task.5094) ────────────────────────────────
# The OpenBao seed fans NODE_BASELINE_KEYS to every type:node, gating + valuing
# each key from infra/secrets-catalog.yaml. Distinct-per-node secrets get a
# fresh value per node (isolation); derived/DB values bind the node's FQDN/DB;
# shared + human values pass through identically. openssl generators mirror
# scripts/lib/secrets-catalog-loader.ts (generate.kind).

CATALOG_FILE="${CATALOG_FILE:-$REPO_ROOT/infra/secrets-catalog.yaml}"
# Nodes that receive payment/signing-key capabilities (custody opt-in; mirrors
# PAYMENT_NODES in setup-secrets.ts). A node NEVER gets a key it didn't ask for.
PAYMENT_NODES="${PAYMENT_NODES:-poly}"

rand64() { openssl rand -base64 "${1:-32}"; }
randHex() { openssl rand -hex "${1:-32}"; }
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

# Read one catalog field for a secret name. Empty string if name or field absent.
_cat_field() {
  yq -N "(.secrets[] | select(.name == \"$1\") | ${2}) // \"\"" "$CATALOG_FILE" 2>/dev/null | head -1
}

# Does node $1 receive key $2? Gate against capability/service pinning in the
# catalog: a `service:`-pinned A2 key belongs only to its owning node (or poly-
# capability nodes); `_shared`/`_system` and capability `appliesTo` reach every
# node (current node set is homogeneous full-app). Legacy keys absent from the
# catalog (DATABASE_URL/_SERVICE_URL) are baseline → kept.
_node_gets_key() {
  local node="$1" k="$2" appliesTo service
  appliesTo=$(_cat_field "$k" '.appliesTo')
  service=$(_cat_field "$k" '.service')
  if [[ "$appliesTo" == "payments" ]]; then
    [[ " $PAYMENT_NODES " == *" $node "* ]] && return 0 || return 1
  fi
  if [[ -n "$service" && "$service" != "_shared" && "$service" != "_system" && "$service" != "$node" ]]; then
    # A2 pinned to another node (e.g. poly): only that node (or poly-cap) gets it.
    [[ " $PAYMENT_NODES " == *" $node "* && "$service" == "poly" ]] && return 0 || return 1
  fi
  return 0
}

# Resolve the value to seed for (node, key). Idempotent: an existing OpenBao
# value at cogni/<env>/<node>/<key> is preserved (no churn on re-runs → 0 pod
# restarts). Otherwise: Postgres DSNs bind cogni_<node>; the Doltgres DSN binds
# knowledge_<node> using the Compose-infra root password source; derive-env
# binds the node's FQDN; agent-random distinct keys mint a FRESH value per node
# (isolation); _shared / shared:true / human keys pass through the .env value.
_resolve_node_value() {
  local node="$1" k="$2" existing
  existing=$(bao_get_field "$node" "$k")
  if [[ -n "$existing" ]]; then printf '%s' "$existing"; return 0; fi
  _compose_node_value "$node" "$k"
}

# Authoritative composer: build (node, key)'s value from canonical inputs,
# IGNORING any existing OpenBao value. _resolve_node_value preserves an existing
# value (0 churn on re-runs); secret-materialize uses THIS to overwrite a DRIFTED
# composed DSN — e.g. a pre-#1584 DATABASE_URL still naming the legacy app_user
# instead of the per-node app_<node> role (#1584 half-rollout self-heal).
_compose_node_value() {
  local node="$1" k="$2" kind source shared service db
  db="cogni_${node//-/_}"
  case "$k" in
    DATABASE_URL)
      # Per-node: app_<node> role + the node's own source:agent password (OpenBao).
      # Role name is computed from the node; the password is read from
      # cogni/<env>/<node> (materialize generated it before this composition).
      printf 'postgresql://app_%s:%s@%s:5432/%s?sslmode=disable' \
        "${node//-/_}" "$(bao_get_field "$node" APP_DB_PASSWORD)" "${VM_IP}" "${db}"; return 0 ;;
    DATABASE_SERVICE_URL)
      printf 'postgresql://service_%s:%s@%s:5432/%s?sslmode=disable' \
        "${node//-/_}" "$(bao_get_field "$node" APP_DB_SERVICE_PASSWORD)" "${VM_IP}" "${db}"; return 0 ;;
    DOLTGRES_PASSWORD)
      # Env-wide Doltgres superuser (one server, every node's knowledge_<node> DB).
      # Operator holds the single canonical SSOT (cogni/<env>/operator/DOLTGRES_PASSWORD)
      # and every node inherits it, so the shared superuser never diverges across nodes.
      # derive_secret is ONLY the genesis bootstrap for the very first seed (operator,
      # fresh env) — deterministic so a not-yet-seeded peer composes the same value.
      # It is NOT the source of truth: post-init the field is stored + reconciled to the
      # live volume via `pnpm secrets:set <env> operator DOLTGRES_PASSWORD` (immutable
      # superuser, Doltgres 0.56.3 can't ALTER it — databases.md §5.2), never re-derived.
      local _dg; _dg="$(bao_get_field operator DOLTGRES_PASSWORD)"
      [[ -n "$_dg" ]] && { printf '%s' "$_dg"; return 0; }
      derive_secret doltgres-root; return 0 ;;
    DOLTGRES_URL)
      # Per-node knowledge_<node> DB, reached as the shared `postgres` superuser
      # (Doltgres 0.56.3 RBAC is table-DML-only — databases.md §5.2). Embed the
      # operator-canonical superuser SSOT — never the per-node value (which can lag a
      # volume restore). Same resolution as the DOLTGRES_PASSWORD branch (operator
      # SSOT, else genesis derive) so the URL never embeds an empty password before
      # operator is seeded. Composed, never derived inline, never from .env.
      local _dgu; _dgu="$(bao_get_field operator DOLTGRES_PASSWORD)"
      [[ -n "$_dgu" ]] || _dgu="$(derive_secret doltgres-root)"
      printf 'postgresql://postgres:%s@%s:5435/knowledge_%s?sslmode=disable' \
        "$_dgu" "${VM_IP}" "${node//-/_}"; return 0 ;;
  esac
  kind=$(_cat_field "$k" '.generate.kind')
  source=$(_cat_field "$k" '.source')
  shared=$(_cat_field "$k" '.shared')
  service=$(_cat_field "$k" '.service')
  if [[ "$kind" == "derive-env" ]]; then
    printf 'https://%s' "$(host_for_node "$node" "$DOMAIN")"; return 0
  fi
  if [[ "$source" == "agent" && "$service" != "_shared" && "$shared" != "true" \
        && "$kind" =~ ^(base64|hex|sk-cogni)$ ]]; then
    case "$kind" in
      base64) rand64 "$(_cat_field "$k" '.generate.bytes')" ;;
      hex) randHex "$(_cat_field "$k" '.generate.bytes')" ;;
      sk-cogni) printf 'sk-cogni-%s' "$(randHex 24)" ;;
    esac
    return 0
  fi
  printf '%s' "${!k:-}"  # passthrough: _shared / shared:true / human value
}

# Fan NODE_BASELINE_KEYS to one node's OpenBao path with per-node values.
# Caller provides seed_kv (provision-env-vm.sh) + globals DOMAIN/VM_IP/APP_DB_*.
seed_node_app_secrets() {
  local node="$1" k v n=0
  for k in "${NODE_BASELINE_KEYS[@]}"; do
    _node_gets_key "$node" "$k" || continue
    v=$(_resolve_node_value "$node" "$k")
    [[ -z "$v" ]] && continue
    seed_kv "$node" "$k" "$v"
    n=$((n + 1))
  done
  log_info "  seeded ${n} key(s) → cogni/${DEPLOY_ENV}/${node}/*"
}

# Read one field from OpenBao at cogni/<env>/<svc>/<k>. Stdout = value
# (empty if path or field absent). Mirrors seed_kv's exec shape.
bao_get_field() {
  local svc="$1" k="$2"
  ssh $SSH_OPTS root@"$VM_IP" \
    "kubectl exec -n openbao openbao-0 -- env BAO_TOKEN='${ROOT_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao kv get -format=json 'cogni/${DEPLOY_ENV}/${svc}'" \
    2>/dev/null | jq -r --arg k "$k" '.data.data[$k] // empty' 2>/dev/null || true
}

# Override the shell var + .env.<env> entry for KEY with VALUE.
# Skips if value matches or KEY isn't yet in the file. Uses `|` as sed
# delimiter (safe for base64 / hex / sk- prefixed tokens; would break
# if a value contains a literal `|`).
_apply_reconciled() {
  local k="$1" v="$2"
  local env_file="$REPO_ROOT/.env.${DEPLOY_ENV}"
  [[ -z "$v" ]] && return 1
  [[ "$v" == "${!k:-}" ]] && return 1
  export "${k}=${v}"
  if [[ -f "$env_file" ]] && grep -qE "^${k}=" "$env_file"; then
    sed -i.bak "s|^${k}=.*$|${k}=${v}|" "$env_file"
    rm -f "${env_file}.bak"
  fi
  return 0
}

# Reconcile a service's keys from OpenBao. Fresh provisions = no-op.
_reconcile_from_openbao() {
  local svc="$1"; shift
  local k v n=0
  for k in "$@"; do
    v=$(bao_get_field "$svc" "$k")
    if _apply_reconciled "$k" "$v"; then n=$((n + 1)); fi
  done
  [[ $n -gt 0 ]] && log_info "  reconciled ${n} ${svc}/ key(s) from OpenBao SSoT"
  return 0
}

# Reconcile Compose-only keys from the VM's existing runtime/.env.
# Fresh provisions (no file on VM) = no-op.
_reconcile_from_compose_vm() {
  local vm_env_dump
  vm_env_dump=$(ssh $SSH_OPTS root@"$VM_IP" \
    'cat /opt/cogni-template-runtime/.env 2>/dev/null' || true)
  if [[ -z "$vm_env_dump" ]]; then
    log_info "  no prior /opt/cogni-template-runtime/.env on VM — fresh provision"
    return 0
  fi
  local k v n=0
  for k in "${COMPOSE_ONLY_KEYS[@]}"; do
    v=$(printf '%s\n' "$vm_env_dump" | sed -n "s|^${k}=\\(.*\\)$|\\1|p" | head -1)
    if _apply_reconciled "$k" "$v"; then n=$((n + 1)); fi
  done
  [[ $n -gt 0 ]] && log_info "  reconciled ${n} Compose-only key(s) from VM runtime/.env"
  # DSN keys are constructed in provision-env-vm.sh from component secrets;
  # if reconcile changed those components, re-derive so the OpenBao seed below
  # writes values consistent with the VM runtime.
  if [[ $n -gt 0 ]]; then
    DATABASE_URL="postgresql://${APP_DB_USER}:${APP_DB_PASSWORD}@${VM_IP}:5432/${PRIMARY_NODE_DB}?sslmode=disable"
    DATABASE_SERVICE_URL="postgresql://${APP_DB_SERVICE_USER}:${APP_DB_SERVICE_PASSWORD}@${VM_IP}:5432/${PRIMARY_NODE_DB}?sslmode=disable"
    export DATABASE_URL DATABASE_SERVICE_URL DOLTGRES_PASSWORD
  fi
  return 0
}

# Entry point — called by Phase 5c after ROOT_TOKEN + APP_BASE_URL/NEXTAUTH_URL
# are set. Idempotent: fresh provisions no-op cleanly.
reconcile_secrets_on_rerun() {
  log_info "Reconciling .env.${DEPLOY_ENV} with OpenBao + VM truth (re-run idempotency, bug.5081)..."
  _reconcile_from_openbao node-template     "${NODE_TEMPLATE_KEYS[@]}"
  _reconcile_from_openbao scheduler-worker  "${SCHEDULER_WORKER_KEYS[@]}"
  _reconcile_from_compose_vm
}
