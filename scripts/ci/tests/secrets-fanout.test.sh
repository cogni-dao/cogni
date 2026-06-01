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
APP_DB_USER="app_user"; APP_DB_PASSWORD="pw_app"
APP_DB_SERVICE_USER="app_service"; APP_DB_SERVICE_PASSWORD="pw_svc"
CATALOG_FILE="$REPO_ROOT/infra/secrets-catalog.yaml"
# Passthrough (.env) values — same across nodes by contract.
LITELLM_MASTER_KEY="sk-cogni-shared-master"
OPENROUTER_API_KEY="sk-or-shared"
export DEPLOY_ENV DOMAIN VM_IP APP_DB_USER APP_DB_PASSWORD \
  APP_DB_SERVICE_USER APP_DB_SERVICE_PASSWORD CATALOG_FILE \
  LITELLM_MASTER_KEY OPENROUTER_API_KEY

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
seed_node_app_secrets canary

# 1. AUTH_SECRET distinct per node (the headline isolation invariant).
nt_auth=$(val_for node-template AUTH_SECRET); cn_auth=$(val_for canary AUTH_SECRET)
r=0; [[ -n "$nt_auth" && -n "$cn_auth" && "$nt_auth" != "$cn_auth" ]] || r=1
assert "$r" "AUTH_SECRET distinct per node"

# 2. CONNECTIONS_ENCRYPTION_KEY distinct per node (cross-node decryption isolation).
nt_cek=$(val_for node-template CONNECTIONS_ENCRYPTION_KEY); cn_cek=$(val_for canary CONNECTIONS_ENCRYPTION_KEY)
r=0; [[ -n "$cn_cek" && "$nt_cek" != "$cn_cek" ]] || r=1
assert "$r" "CONNECTIONS_ENCRYPTION_KEY distinct per node"

# 3. derive-env binds the node's own FQDN.
r=0; [[ "$(val_for node-template NEXTAUTH_URL)" == "https://node-template.test.cognidao.org" \
   && "$(val_for canary NEXTAUTH_URL)" == "https://canary.test.cognidao.org" ]] || r=1
assert "$r" "NEXTAUTH_URL binds per-node FQDN"

# 4. DATABASE_URL binds the per-node database cogni_<node>.
r=0; [[ "$(val_for node-template DATABASE_URL)" == *"/cogni_node_template?"* \
   && "$(val_for canary DATABASE_URL)" == *"/cogni_canary?"* ]] || r=1
assert "$r" "DATABASE_URL binds cogni_<node>"

# 5. Custody: poly-pinned (service:poly) keys NEVER fan to a non-poly node.
r=0; { seeded node-template POLY_WALLET_AEAD_KEY_HEX || seeded canary POLY_WALLET_AEAD_KEY_HEX; } && r=1
assert "$r" "POLY_WALLET_AEAD_KEY_HEX excluded from non-poly nodes"
r=0; seeded canary POLYGON_RPC_URL && r=1
assert "$r" "POLYGON_RPC_URL excluded from non-poly nodes"

# 6. _shared key passes through identically (same LiteLLM master key all nodes).
r=0; [[ "$(val_for node-template LITELLM_MASTER_KEY)" == "sk-cogni-shared-master" \
   && "$(val_for canary LITELLM_MASTER_KEY)" == "sk-cogni-shared-master" ]] || r=1
assert "$r" "LITELLM_MASTER_KEY shared value across nodes"

# 7. human passthrough identical across nodes.
r=0; [[ "$(val_for node-template OPENROUTER_API_KEY)" == "$(val_for canary OPENROUTER_API_KEY)" ]] || r=1
assert "$r" "OPENROUTER_API_KEY shared value across nodes"

# 8. Idempotency: an existing OpenBao value is preserved (no churn → 0 restarts).
bao_get_field() { if [[ "$2" == "AUTH_SECRET" ]]; then printf 'PRESERVED-EXISTING'; else printf ''; fi; }
: >"$SEED_LOG"
seed_node_app_secrets canary
r=0; [[ "$(val_for canary AUTH_SECRET)" == "PRESERVED-EXISTING" ]] || r=1
assert "$r" "existing OpenBao value preserved on re-run"

# 9. Drift guard: every NODE_BASELINE_KEY is classifiable — in the catalog, or
#    one of the two composed DSNs. Catches a baseline key added without a catalog
#    entry (would silently passthrough → shared secret leak).
drift=0
for k in "${NODE_BASELINE_KEYS[@]}"; do
  case "$k" in DATABASE_URL|DATABASE_SERVICE_URL) continue ;; esac
  if [[ -z "$(yq -N "(.secrets[] | select(.name == \"$k\") | .name) // \"\"" "$CATALOG_FILE")" ]]; then
    printf '  drift: %s not in catalog\n' "$k"; drift=1
  fi
done
assert "$drift" "every NODE_BASELINE_KEY is catalog-classified (no silent passthrough)"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
