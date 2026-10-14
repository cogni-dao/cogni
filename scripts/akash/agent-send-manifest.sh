#!/usr/bin/env bash
# agent-send-manifest.sh
#
# KEYLESS (cert-authenticated, not key-signed). Pushes the deployment manifest to
# the winning provider so it starts the workload. Uses the SAME SDL that created
# the deployment. Needs: AKASH_DSEQ, AKASH_PROVIDER.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
_have_cli; _need AKASH_ACCOUNT_ADDRESS; _need AKASH_DSEQ; _need AKASH_PROVIDER

sdl="${1:-$ARTIFACTS/deploy.yaml}"
[ -f "$sdl" ] || { echo "ERROR: SDL $sdl not found (run render-sdl.sh first)" >&2; exit 2; }

provider-services send-manifest "$sdl" \
  --dseq "$AKASH_DSEQ" --provider "$AKASH_PROVIDER" \
  --from "$AKASH_ACCOUNT_ADDRESS" --node "$AKASH_NODE"

echo "manifest sent to $AKASH_PROVIDER for dseq=$AKASH_DSEQ"
echo "next: agent-lease-status.sh  → live URL"
