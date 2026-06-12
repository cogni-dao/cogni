#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Unit tests for the catalog-gated per-node secret fan-out (task.5094) in
# scripts/setup/lib/reconcile-secrets.sh::seed_node_app_secrets. Sources the
# lib, stubs the runtime deps (seed_kv, bao_get_field, host_for_node, log_info),
# and drives the fan-out against the REAL infra/secrets-catalog.yaml so this is
# the CI-side proof of "distinct paths AND distinct values per node" before the
# live candidate-a provision.
#
# Run: bash scripts/ci/tests/secrets-fanout.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export REPO_ROOT

TMPROOT=$(mktemp -d -t secrets-fanout.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT
SEED_LOG="$TMPROOT/seed.log"

# Globals the lib expects from provision-env-vm.sh.
DEPLOY_ENV="candidate-a"
DOMAIN="test.cognidao.org"
VM_IP="10.0.0.1"
POSTGRES_ROOT_PASSWORD="postgres-root"
APP_DB_USER="app_user"; APP_DB_PASSWORD="pw_app"
APP_DB_SERVICE_USER="app_service"; APP_DB_SERVICE_PASSWORD="pw_svc"
CATALOG_FILE="$REPO_ROOT/infra/secrets-catalog.yaml"
# Passthrough (.env) values — same across nodes by contract.
LITELLM_MASTER_KEY="sk-cogni-shared-master"
OPENROUTER_API_KEY="sk-or-shared"
# External integration passthrough values (human source) — prove routing.
GH_OAUTH_CLIENT_ID="gh-oauth-id"          # appliesTo: web   → every node
TAVILY_API_KEY="tvly-shared"              # appliesTo: llm   → every node
PRIVY_APP_ID="privy-app-id"               # appliesTo: payments → poly only
PRIVY_USER_WALLETS_APP_ID="privy-uw-id"   # service: poly       → poly only
export DEPLOY_ENV DOMAIN VM_IP POSTGRES_ROOT_PASSWORD APP_DB_USER APP_DB_PASSWORD \
  APP_DB_SERVICE_USER APP_DB_SERVICE_PASSWORD CATALOG_FILE \
  LITELLM_MASTER_KEY OPENROUTER_API_KEY \
  GH_OAUTH_CLIENT_ID TAVILY_API_KEY PRIVY_APP_ID PRIVY_USER_WALLETS_APP_ID
# poly drives the payment/custody-gated path.
PAYMENT_NODES="poly"; export PAYMENT_NODES

# shellcheck source=../../setup/lib/reconcile-secrets.sh
source "$REPO_ROOT/scripts/setup/lib/reconcile-secrets.sh"

# ── Stub runtime deps (override the lib / provision definitions) ──────────────
log_info() { :; }
log_step() { :; }
# Fresh provision: nothing in OpenBao yet → forces generate/derive.
bao_get_field() { printf ''; }
# Mimic image-tags.sh host_for_node: non-primary nodes get <node>.<domain>.
host_for_node() { printf '%s.%s' "$1" "$2"; }
# Record every seed as "<node>|<key>|<value>".
seed_kv() { printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$SEED_LOG"; }

pass=0; fail=0
assert() { # <0|1 result> <desc>
  if [[ "$1" -eq 0 ]]; then printf 'OK   %s\n' "$2"; pass=$((pass + 1));
  else printf 'FAIL %s\n' "$2"; fail=$((fail + 1)); fi
}
val_for() { grep -E "^$1\|$2\|" "$SEED_LOG" | head -1 | cut -d'|' -f3-; }
seeded()  { grep -qE "^$1\|$2\|" "$SEED_LOG"; }

# ── Drive the fan-out for two nodes ───────────────────────────────────────────
: >"$SEED_LOG"
seed_node_app_secrets node-template
seed_node_app_secrets oss
seed_node_app_secrets poly

# 1. AUTH_SECRET distinct per node (the headline isolation invariant).
nt_auth=$(val_for node-template AUTH_SECRET); cn_auth=$(val_for oss AUTH_SECRET)
r=0; [[ -n "$nt_auth" && -n "$cn_auth" && "$nt_auth" != "$cn_auth" ]] || r=1
assert "$r" "AUTH_SECRET distinct per node"

# 2. CONNECTIONS_ENCRYPTION_KEY distinct per node (cross-node decryption isolation).
nt_cek=$(val_for node-template CONNECTIONS_ENCRYPTION_KEY); cn_cek=$(val_for oss CONNECTIONS_ENCRYPTION_KEY)
r=0; [[ -n "$cn_cek" && "$nt_cek" != "$cn_cek" ]] || r=1
assert "$r" "CONNECTIONS_ENCRYPTION_KEY distinct per node"

# 3. derive-env binds the node's own FQDN.
r=0; [[ "$(val_for node-template NEXTAUTH_URL)" == "https://node-template.test.cognidao.org" \
   && "$(val_for oss NEXTAUTH_URL)" == "https://oss.test.cognidao.org" ]] || r=1
assert "$r" "NEXTAUTH_URL binds per-node FQDN"

# 4. DATABASE_URL binds the per-node database cogni_<node>.
r=0; [[ "$(val_for node-template DATABASE_URL)" == *"/cogni_node_template?"* \
   && "$(val_for oss DATABASE_URL)" == *"/cogni_oss?"* ]] || r=1
assert "$r" "DATABASE_URL binds cogni_<node>"

r=0; [[ "$(val_for node-template DOLTGRES_URL)" == postgresql://postgres:*"@10.0.0.1:5435/knowledge_node_template?sslmode=disable" \
   && "$(val_for oss DOLTGRES_URL)" == postgresql://postgres:*"@10.0.0.1:5435/knowledge_oss?sslmode=disable" ]] || r=1
assert "$r" "DOLTGRES_URL binds knowledge_<node>"

# 5. Custody: poly-pinned (service:poly) keys NEVER fan to a non-poly node.
r=0; { seeded node-template POLY_WALLET_AEAD_KEY_HEX || seeded oss POLY_WALLET_AEAD_KEY_HEX; } && r=1
assert "$r" "POLY_WALLET_AEAD_KEY_HEX excluded from non-poly nodes"
r=0; seeded oss POLYGON_RPC_URL && r=1
assert "$r" "POLYGON_RPC_URL excluded from non-poly nodes"

# 5b. External integrations: web/llm reach every node; payments/service-pinned
#     reach only poly (the dead-secrets wiring fix).
r=0; [[ "$(val_for node-template GH_OAUTH_CLIENT_ID)" == "gh-oauth-id" \
   && "$(val_for oss GH_OAUTH_CLIENT_ID)" == "gh-oauth-id" \
   && "$(val_for poly GH_OAUTH_CLIENT_ID)" == "gh-oauth-id" ]] || r=1
assert "$r" "GH_OAUTH_CLIENT_ID (appliesTo: web) reaches every node"
r=0; [[ "$(val_for node-template TAVILY_API_KEY)" == "tvly-shared" \
   && "$(val_for poly TAVILY_API_KEY)" == "tvly-shared" ]] || r=1
assert "$r" "TAVILY_API_KEY (appliesTo: llm) reaches every node"
r=0; { seeded node-template PRIVY_APP_ID || seeded oss PRIVY_APP_ID; } && r=1
assert "$r" "PRIVY_APP_ID (appliesTo: payments) excluded from non-poly nodes"
r=0; [[ "$(val_for poly PRIVY_APP_ID)" == "privy-app-id" ]] || r=1
assert "$r" "PRIVY_APP_ID reaches poly"
r=0; { seeded node-template PRIVY_USER_WALLETS_APP_ID || seeded oss PRIVY_USER_WALLETS_APP_ID; } && r=1
assert "$r" "PRIVY_USER_WALLETS_APP_ID (service: poly) excluded from non-poly nodes"
r=0; [[ "$(val_for poly PRIVY_USER_WALLETS_APP_ID)" == "privy-uw-id" ]] || r=1
assert "$r" "PRIVY_USER_WALLETS_APP_ID reaches poly"

# 6. _shared key passes through identically (same LiteLLM master key all nodes).
r=0; [[ "$(val_for node-template LITELLM_MASTER_KEY)" == "sk-cogni-shared-master" \
   && "$(val_for oss LITELLM_MASTER_KEY)" == "sk-cogni-shared-master" ]] || r=1
assert "$r" "LITELLM_MASTER_KEY shared value across nodes"

# 7. human passthrough identical across nodes.
r=0; [[ "$(val_for node-template OPENROUTER_API_KEY)" == "$(val_for oss OPENROUTER_API_KEY)" ]] || r=1
assert "$r" "OPENROUTER_API_KEY shared value across nodes"

# 8. Idempotency: an existing OpenBao value is preserved (no churn → 0 restarts).
bao_get_field() { if [[ "$2" == "AUTH_SECRET" ]]; then printf 'PRESERVED-EXISTING'; else printf ''; fi; }
: >"$SEED_LOG"
seed_node_app_secrets oss
r=0; [[ "$(val_for oss AUTH_SECRET)" == "PRESERVED-EXISTING" ]] || r=1
assert "$r" "existing OpenBao value preserved on re-run"

# 9. Drift guard: every NODE_BASELINE_KEY is classifiable — in the catalog, or
#    one of the two composed DSNs. Catches a baseline key added without a catalog
#    entry (would silently passthrough → shared secret leak).
drift=0
for k in "${NODE_BASELINE_KEYS[@]}"; do
  case "$k" in DATABASE_URL|DATABASE_SERVICE_URL|DOLTGRES_URL) continue ;; esac
  if [[ -z "$(yq -N "(.secrets[] | select(.name == \"$k\") | .name) // \"\"" "$CATALOG_FILE")" ]]; then
    printf '  drift: %s not in catalog\n' "$k"; drift=1
  fi
done
assert "$drift" "every NODE_BASELINE_KEY is catalog-classified (no silent passthrough)"

# ── 10. Catalog-derived pod-key universe (scripts/lib/print-pod-keys.ts) ──────
#    Invariant 14 CATALOG_IS_THE_ONE_READER. Anchors to REAL pod consumers
#    (server-env.ts reads + the dual-consumed OPENROUTER_API_KEY), NOT the legacy
#    hand-list — which is itself buggy (it omits GH_REVIEW_APP_*, the live prod
#    governance-publish miss a correct emitter auto-heals). This is the green-gate
#    for retiring NODE_BASELINE_KEYS in reconcile-secrets.sh (its own PR).
TSX="$REPO_ROOT/node_modules/.bin/tsx"
mapfile -t DERIVED < <(cd "$REPO_ROOT" && "$TSX" scripts/lib/print-pod-keys.ts 2>/dev/null)
in_derived() { local d; for d in "${DERIVED[@]}"; do [[ "$d" == "$1" ]] && return 0; done; return 1; }

assert "$([[ ${#DERIVED[@]} -gt 0 ]] && echo 0 || echo 1)" "print-pod-keys emits a non-empty universe"

# 10a. Authoritative: pod-consumed keys MUST be in the derived set (the five
#      dual-consumed keys + GH_REVIEW_APP_*, silently absent from the hand-list).
for k in OPENROUTER_API_KEY POSTHOG_API_KEY POSTHOG_HOST EVM_RPC_URL POLYGON_RPC_URL \
  GH_REVIEW_APP_ID GH_REVIEW_APP_PRIVATE_KEY_BASE64; do
  r=0; in_derived "$k" || r=1
  assert "$r" "pod key $k ∈ derived universe"
done

# 10b. Cross-check four app duals against ACTUAL server-env.ts reads, not the
#      bash array. (POLYGON_RPC_URL is read in poly adapters, not server-env.)
for k in OPENROUTER_API_KEY POSTHOG_API_KEY POSTHOG_HOST EVM_RPC_URL; do
  r=0; grep -rqw "$k" "$REPO_ROOT"/nodes/*/app/src/shared/env/server-env.ts 2>/dev/null || r=1
  assert "$r" "$k is a real server-env.ts pod read (cross-check)"
done

# 10c. Compose-only credentials MUST NOT leak into the pod universe. DOLTGRES_PASSWORD
#      is materialized per-node for the DOLTGRES_URL composition (like APP_DB_PASSWORD),
#      but the pod consumes only the composed URL — the raw superuser pw is compose-consumed.
for k in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD DOLTGRES_PASSWORD COGNI_NODE_ENDPOINTS; do
  r=0; in_derived "$k" && r=1
  assert "$r" "compose-only $k is NOT pod-derived"
done

# 10d. No regression vs today's hand-list (minus the composed DSNs the catalog
#      cannot value, and minus their per-node password INPUTS — APP_DB_PASSWORD /
#      APP_DB_SERVICE_PASSWORD are materialized to the node path for the DSN
#      composition + db-provision, but are compose-consumed, not pod-derived; 10c
#      asserts exactly that). After the swap, NODE_BASELINE pod keys == DERIVED.
miss=0
for k in "${NODE_BASELINE_KEYS[@]}"; do
  case "$k" in
    DATABASE_URL | DATABASE_SERVICE_URL | DOLTGRES_URL) continue ;;
    APP_DB_PASSWORD | APP_DB_SERVICE_PASSWORD | DOLTGRES_PASSWORD) continue ;;
  esac
  in_derived "$k" || { printf '  regression: baseline %s not derived\n' "$k"; miss=1; }
done
assert "$miss" "derived ⊇ current NODE_BASELINE_KEYS (minus composed DSNs + their pw inputs)"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
