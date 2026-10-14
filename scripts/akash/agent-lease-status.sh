#!/usr/bin/env bash
# agent-lease-status.sh
#
# KEYLESS. Reads the lease status from the winning provider and prints the
# forwarded URIs (your live URL). Requires the client cert (created in step 0).
# Needs: AKASH_DSEQ, AKASH_PROVIDER, AKASH_GSEQ, AKASH_OSEQ.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
_have_cli; _need AKASH_ACCOUNT_ADDRESS; _need AKASH_DSEQ; _need AKASH_PROVIDER

status="$(provider-services lease-status \
  --dseq "$AKASH_DSEQ" --gseq "${AKASH_GSEQ:-1}" --oseq "${AKASH_OSEQ:-1}" \
  --provider "$AKASH_PROVIDER" --from "$AKASH_ACCOUNT_ADDRESS" \
  --node "$AKASH_NODE" 2>/dev/null || true)"
echo "$status" > "$ARTIFACTS/lease-status-${AKASH_DSEQ}.json"

echo "$status" | jq -r '
  (.services // {}) | to_entries[]
  | "service \(.key): \((.value.uris // []) | join(", "))"' 2>/dev/null \
  || { echo "raw status written to $ARTIFACTS/lease-status-${AKASH_DSEQ}.json"; echo "$status"; }
