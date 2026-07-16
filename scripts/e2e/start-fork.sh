#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Standalone anvil Base-mainnet fork for the finalize→mint→claim harness.
# The harness (scripts/e2e/finalize-mint-claim.ts) normally spawns anvil itself;
# use this only to run a long-lived fork by hand (e.g. debugging).
#
# EVM_RPC_URL is read ONLY as anvil's --fork-url source. All harness writes go to
# http://127.0.0.1:8545 (this fork). See finalize-mint-claim.ts § guard-0.
#
#   dotenv -e .env.local -- bash scripts/e2e/start-fork.sh
set -euo pipefail

: "${EVM_RPC_URL:?EVM_RPC_URL required as anvil --fork-url source (real Base RPC)}"

if ! command -v anvil >/dev/null 2>&1; then
  echo "anvil not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup" >&2
  exit 1
fi

echo "Forking Base mainnet (chain 8453) → http://127.0.0.1:8545 ..."
exec anvil --fork-url "$EVM_RPC_URL" --chain-id 8453 --port 8545
