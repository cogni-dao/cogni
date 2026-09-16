#!/usr/bin/env bash
# Shared config for the Akash crypto-deploy rail. Sourced by every script.
#
# CUSTODY: nothing in this file is a secret. The signing key lives ONLY in the
# human's keyring; AKASH_KEY_NAME + the keyring passphrase are never used by any
# `agent-*` script — only by `human-sign.sh`.
set -euo pipefail

# --- public network config (safe to share with the agent) -------------------
export AKASH_NODE="${AKASH_NODE:-https://rpc.akashnet.net:443}"
export AKASH_CHAIN_ID="${AKASH_CHAIN_ID:-akashnet-2}"
export AKASH_GAS="${AKASH_GAS:-auto}"
export AKASH_GAS_ADJUSTMENT="${AKASH_GAS_ADJUSTMENT:-1.4}"
export AKASH_GAS_PRICES="${AKASH_GAS_PRICES:-0.025uakt}"

# The public bech32 address of the funding wallet (NOT a secret). Required by
# the keyless generate-only + query steps.
export AKASH_ACCOUNT_ADDRESS="${AKASH_ACCOUNT_ADDRESS:-}"

# Artifact dir: unsigned-*.json / signed-*.json handoff files + the audit trail.
AKASH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ARTIFACTS="${ARTIFACTS:-$AKASH_DIR/artifacts}"
mkdir -p "$ARTIFACTS"

_need() { [ -n "${!1:-}" ] || { echo "ERROR: \$$1 must be set (see docs/guides/akash-crypto-deploy.md)" >&2; exit 2; }; }
_have_cli() { command -v provider-services >/dev/null || { echo "ERROR: provider-services CLI not installed" >&2; exit 3; }; }
