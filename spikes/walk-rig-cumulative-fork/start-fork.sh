#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Start a LOCAL anvil fork of Base mainnet for the walk cumulative-distributor
# rig. The prod RPC is read PURELY as the fork SOURCE url; anvil serves a local,
# throwaway chain at http://127.0.0.1:8545 — every write tx the rig sends lands
# there, NEVER on the real Base mainnet RPC.
#
# Usage:
#   bash spikes/walk-rig-cumulative-fork/start-fork.sh
#
# Env overrides:
#   FORK_ENV_FILE  path to the .env with EVM_RPC_URL (default: repo .env.local)
#   FORK_PORT      anvil port (default: 8545)
#   FORK_URL       override the fork source url directly (skips env read)
set -euo pipefail

FORK_PORT="${FORK_PORT:-8545}"
FORK_ENV_FILE="${FORK_ENV_FILE:-/Users/derek/dev/cogni-template/.env.local}"

if [[ -z "${FORK_URL:-}" ]]; then
  if [[ ! -f "$FORK_ENV_FILE" ]]; then
    echo "x No env file at $FORK_ENV_FILE and no FORK_URL set." >&2
    exit 1
  fi
  FORK_URL=$(grep -E '^EVM_RPC_URL=' "$FORK_ENV_FILE" | head -1 | cut -d= -f2-)
fi

if [[ -z "$FORK_URL" ]]; then
  echo "x Could not resolve a fork source URL (EVM_RPC_URL empty)." >&2
  exit 1
fi

# Find anvil (foundry installs to ~/.foundry/bin).
if ! command -v anvil >/dev/null 2>&1; then
  export PATH="$HOME/.foundry/bin:$PATH"
fi
if ! command -v anvil >/dev/null 2>&1; then
  echo "x anvil not found. Install foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup" >&2
  exit 1
fi

REDACTED=$(echo "$FORK_URL" | sed -E 's#(/v2/|alch_)[A-Za-z0-9_-]+#\1<REDACTED>#g')
echo "Forking Base mainnet from: $REDACTED"
echo "Serving local fork at:      http://127.0.0.1:${FORK_PORT}"
echo "(reads from the source url; all WRITES stay on the local fork)"
echo

exec anvil --fork-url "$FORK_URL" --auto-impersonate --port "$FORK_PORT"
