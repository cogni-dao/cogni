#!/usr/bin/env bash
# agent-broadcast.sh <label>
#
# KEYLESS. Broadcasts artifacts/signed-<label>.json to the chain. A signed tx is
# already authorized by the human; broadcasting needs no key. Prints the tx hash
# and (for a deployment create) the resulting dseq.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
_have_cli

label="${1:?usage: agent-broadcast.sh <label>}"
signed="$ARTIFACTS/signed-${label}.json"
[ -f "$signed" ] || { echo "ERROR: $signed not found (human must sign first)" >&2; exit 2; }

res="$(provider-services tx broadcast "$signed" --node "$AKASH_NODE" --output json)"
echo "$res" > "$ARTIFACTS/broadcast-${label}.json"

hash="$(echo "$res" | jq -r '.txhash // empty')"
code="$(echo "$res" | jq -r '.code // 0')"
[ "$code" = "0" ] || { echo "ERROR: tx failed (code=$code): $(echo "$res" | jq -r '.raw_log')" >&2; exit 1; }
echo "broadcast ok: txhash=$hash"

# Surface the dseq for a deployment-create so the caller can export AKASH_DSEQ.
dseq="$(echo "$res" | jq -r '.logs[]?.events[]? | select(.type=="akash.v1.EventDeploymentCreated" or .type=="deployment-created") | .attributes[]? | select(.key=="dseq" or .key=="DSeq").value' 2>/dev/null | head -1)"
[ -n "${dseq:-}" ] && echo "DSEQ=$dseq"
exit 0
