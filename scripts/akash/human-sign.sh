#!/usr/bin/env bash
# human-sign.sh <label>
#
# HUMAN-ONLY. This is the ONLY script that touches the wallet key. It signs
# artifacts/unsigned-<label>.json with the human's keyring key and writes
# artifacts/signed-<label>.json. Run this yourself; do NOT give the agent your
# AKASH_KEY_NAME or keyring passphrase.
#
#   AKASH_KEY_NAME=mywallet scripts/akash/human-sign.sh deploy
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
_have_cli; _need AKASH_ACCOUNT_ADDRESS
: "${AKASH_KEY_NAME:?set AKASH_KEY_NAME to your keyring key (human-only, never share)}"
KEYRING_BACKEND="${AKASH_KEYRING_BACKEND:-os}"

label="${1:?usage: human-sign.sh <label>}"
unsigned="$ARTIFACTS/unsigned-${label}.json"
signed="$ARTIFACTS/signed-${label}.json"
[ -f "$unsigned" ] || { echo "ERROR: $unsigned not found (agent must generate it first)" >&2; exit 2; }

echo "Review the tx you are about to sign:" >&2
cat "$unsigned" >&2; echo >&2

provider-services tx sign "$unsigned" \
  --from "$AKASH_KEY_NAME" --keyring-backend "$KEYRING_BACKEND" \
  --node "$AKASH_NODE" --chain-id "$AKASH_CHAIN_ID" \
  --output-document "$signed"

echo "wrote $signed  (hand back to agent → agent-broadcast.sh $label)"
