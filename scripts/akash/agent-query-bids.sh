#!/usr/bin/env bash
# agent-query-bids.sh <dseq>
#
# KEYLESS. Lists open bids for a deployment, sorted cheapest-first, and prints a
# suggested provider/gseq/oseq to export. Read-only chain query — no key.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
_have_cli; _need AKASH_ACCOUNT_ADDRESS
dseq="${1:?usage: agent-query-bids.sh <dseq>}"

bids="$(provider-services query market bid list \
  --owner "$AKASH_ACCOUNT_ADDRESS" --dseq "$dseq" --state open \
  --node "$AKASH_NODE" --output json)"
echo "$bids" > "$ARTIFACTS/bids-${dseq}.json"

echo "$bids" | jq -r '
  .bids // []
  | map(.bid)
  | sort_by(.price.amount | tonumber)
  | .[]
  | "\(.price.amount)\(.price.denom)\t provider=\(.bid_id.provider) gseq=\(.bid_id.gseq) oseq=\(.bid_id.oseq)"'

echo "---"
echo "cheapest → export these:"
echo "$bids" | jq -r '
  .bids // [] | map(.bid) | sort_by(.price.amount | tonumber) | .[0]
  | "export AKASH_PROVIDER=\(.bid_id.provider) AKASH_GSEQ=\(.bid_id.gseq) AKASH_OSEQ=\(.bid_id.oseq)"'
