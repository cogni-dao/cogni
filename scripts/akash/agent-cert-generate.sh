#!/usr/bin/env bash
# agent-cert-generate.sh
#
# Generates the local client-certificate material used to authenticate to the
# provider gateway (send-manifest / lease-status). This cert is a SESSION cert
# bound to the account address — NOT the wallet signing key. The on-chain
# `cert publish` that follows is a normal tx (unsigned → human signs).
#
# NOTE: `tx cert generate client` writes the cert to the keyring/home. If your
# keyring is human-held, run this step as the human; the cert (not the wallet
# key) is what the agent then uses for the keyless manifest/status calls.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
_have_cli; _need AKASH_ACCOUNT_ADDRESS

provider-services tx cert generate client \
  --from "$AKASH_ACCOUNT_ADDRESS" \
  --node "$AKASH_NODE" --chain-id "$AKASH_CHAIN_ID"

echo "client cert generated for $AKASH_ACCOUNT_ADDRESS"
echo "next: agent-gen-tx.sh cert-publish tx cert publish client  → human-sign → agent-broadcast"
