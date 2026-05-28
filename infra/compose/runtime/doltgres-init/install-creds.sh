#!/bin/bash
set -e

# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: infra/compose/runtime/doltgres-init/install-creds.sh
# Purpose: Install DoltHub Dolt creds into the doltgres container BEFORE the
#   server starts, then exec the original docker-entrypoint.sh. Idempotent:
#   when DOLT_CREDS_JWK or DOLT_CREDS_KEYID is unset, this is a pure no-op
#   and the server boots normally with no push capability.
# Scope: Wired as the doltgres service's `entrypoint:` in
#   infra/compose/runtime/docker-compose.yml.
# Invariants:
#   - When invoked, $@ contains the args meant for the original entrypoint.
#   - The doltgres image has no jq/python — JSON merge is pure-bash sed.
#   - Idempotent across container restarts (volume-persistent /root/.dolt/).
#   - Never logs the JWK contents.
# Side-effects: writes /root/.dolt/creds/${KEYID}.jwk and merges user.creds
#   into /root/.dolt/config_global.json (preserves server_uuid).
# Links: docs/runbooks/dolthub-remote-bootstrap.md, task.5069

if [ -n "${DOLT_CREDS_JWK:-}" ] && [ -n "${DOLT_CREDS_KEYID:-}" ]; then
  mkdir -p /root/.dolt/creds
  printf '%s' "$DOLT_CREDS_JWK" > "/root/.dolt/creds/${DOLT_CREDS_KEYID}.jwk"
  chmod 600 "/root/.dolt/creds/${DOLT_CREDS_KEYID}.jwk"

  TARGET=/root/.dolt/config_global.json
  NEW_KV="\"user.creds\":\"${DOLT_CREDS_KEYID}\""

  if [ -f "$TARGET" ]; then
    # Strip any existing user.creds entry (regardless of position), then splice
    # the new one before the closing brace. The config is a flat JSON object
    # (e.g. {"sqlserver.global.server_uuid":"...","user.creds":"..."}) so this
    # sed pair handles the leading/trailing/middle cases.
    CONTENT=$(cat "$TARGET")
    # Strip any existing user.creds in three forms to avoid stray commas:
    # leading-comma → trailing-comma → lone.
    CONTENT=$(echo "$CONTENT" | sed -E 's/,"user\.creds":"[^"]*"//g; s/"user\.creds":"[^"]*",//g; s/"user\.creds":"[^"]*"//g')
    if [ "$CONTENT" = "{}" ]; then
      echo "{${NEW_KV}}" > "$TARGET"
    else
      echo "${CONTENT%\}},${NEW_KV}}" > "$TARGET"
    fi
  else
    mkdir -p /root/.dolt
    echo "{${NEW_KV}}" > "$TARGET"
  fi

  echo "[install-creds] Dolt creds installed (keyid=${DOLT_CREDS_KEYID})"
else
  echo "[install-creds] DOLT_CREDS_JWK/KEYID unset; dolt push to remote disabled"
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
