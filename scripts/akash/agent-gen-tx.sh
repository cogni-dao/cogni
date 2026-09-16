#!/usr/bin/env bash
# agent-gen-tx.sh <label> <provider-services tx args...>
#
# KEYLESS. Builds an UNSIGNED transaction with --generate-only and writes it to
# artifacts/unsigned-<label>.json for the human to sign. Never touches a key:
# --from is the PUBLIC address, and --generate-only does not sign.
#
# Example:
#   scripts/akash/agent-gen-tx.sh deploy tx deployment create artifacts/deploy.yaml --deposit 5000000uakt
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
_have_cli; _need AKASH_ACCOUNT_ADDRESS

label="${1:?usage: agent-gen-tx.sh <label> <tx args...>}"; shift
out="$ARTIFACTS/unsigned-${label}.json"

provider-services "$@" \
  --from "$AKASH_ACCOUNT_ADDRESS" \
  --node "$AKASH_NODE" --chain-id "$AKASH_CHAIN_ID" \
  --gas "$AKASH_GAS" --gas-adjustment "$AKASH_GAS_ADJUSTMENT" --gas-prices "$AKASH_GAS_PRICES" \
  --generate-only \
  > "$out"

echo "wrote $out  (hand to human → human-sign.sh $label)"
