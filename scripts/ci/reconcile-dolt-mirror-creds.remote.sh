#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-dolt-mirror-creds.remote.sh — VM-side render of the DoltHub knowledge-
# mirror creds into the runtime .env + hash-gated force-recreate of the doltgres
# Compose service so its entrypoint (install-creds.sh) re-installs the Dolt creds.
#
# WHY THIS EXISTS (Option B — substrate lane, not deploy-infra):
#   The doltgres service reads DOLT_CREDS_JWK/KEYID from the VM runtime .env via
#   install-creds.sh at container start. deploy-infra used to be the only writer of
#   those .env keys, but an app-only promote runs skip_infra and skips deploy-infra,
#   so the mirror never came up on the normal flow. reconcile-node-substrate.sh
#   (the ALWAYS-run lane, ci-cd.md Axiom 22) invokes this helper on every flight/
#   promote — the same shape bug.5041 used to fold the Alloy config re-push into the
#   always-on lane. See docs/spec/secrets-management.md (Sequencing wrinkle) +
#   docs/runbooks/dolthub-remote-bootstrap.md.
#
# SECURITY / INVARIANTS:
#   - Values arrive base64-encoded (env DOLT_CREDS_JWK_B64 / DOLT_CREDS_KEYID_B64 /
#     DOLTHUB_OWNER_B64 / DOLTHUB_API_TOKEN_B64). base64 keeps the single-line-JSON
#     JWK off any sed/interpolation path (no injection, no accidental echo). We
#     decode into shell vars and write via a clean grep/printf upsert — never
#     sed-substitute the VALUE into a pattern.
#   - Idempotent + hash-gated: an unchanged cred set is a no-op (no doltgres churn).
#     Only a genuine change (first install or rotation) recreates the container.
#   - This helper is invoked ONLY when the caller has confirmed the JWK+KEYID are
#     present in OpenBao; absent creds ⇒ the caller skips this entirely and the
#     mirror stays disabled (fail-closed, install-creds.sh no-ops on unset). NEVER
#     a hardcoded fallback.
#   - Never logs a value. Logs key names + a redacted change/no-op verdict only.
#
# Required env:
#   RUNTIME_ENV        path to the runtime .env (e.g. /opt/cogni-template-runtime/.env)
#   RUNTIME_COMPOSE_BIN docker-compose invocation string for the runtime project
#   HASH_DIR           dir for the change-detection marker (e.g. /var/lib/cogni)
#   DOLT_CREDS_JWK_B64, DOLT_CREDS_KEYID_B64  (required — caller gates on presence)
# Optional env:
#   DOLTHUB_OWNER_B64, DOLTHUB_API_TOKEN_B64  (app-level push job; rendered if set)

set -euo pipefail

# MODE=render (default) installs the creds; MODE=purge strips them (bug.5003 —
# non-prod must never hold the prod-capable DoltHub push cred).
MODE="${MODE:-render}"

: "${RUNTIME_ENV:?RUNTIME_ENV required}"
: "${RUNTIME_COMPOSE_BIN:?RUNTIME_COMPOSE_BIN required}"
: "${HASH_DIR:?HASH_DIR required}"

read -r -a RUNTIME_COMPOSE <<< "$RUNTIME_COMPOSE_BIN"

# PURGE MODE (bug.5003): non-prod must not hold the prod-capable mirror creds. Strip
# the four keys from the runtime .env; if any were present, force-recreate doltgres so
# install-creds.sh re-runs and no-ops (mirror goes dark). No values are ever passed in;
# a .env that already lacks them is a pure no-op (no doltgres churn on healthy re-flights).
if [[ "$MODE" == "purge" ]]; then
  touch "$RUNTIME_ENV"
  removed=""; tmp="$(mktemp)"; cp "$RUNTIME_ENV" "$tmp"
  for k in DOLT_CREDS_JWK DOLT_CREDS_KEYID DOLTHUB_OWNER DOLTHUB_API_TOKEN; do
    grep -qE "^${k}=" "$tmp" && removed="$removed $k"
    grep -vE "^${k}=" "$tmp" > "${tmp}.n" || true
    mv "${tmp}.n" "$tmp"
  done
  cat "$tmp" > "$RUNTIME_ENV"; rm -f "$tmp"
  # Drop the render marker so a future prod render is never falsely hash-skipped.
  rm -f "${HASH_DIR}/dolt-mirror-creds.hash"
  if [[ -n "$removed" ]]; then
    echo "[dolt-mirror-creds] purged from runtime .env:${removed}"
    if "${RUNTIME_COMPOSE[@]}" config --services 2>/dev/null | grep -q '^doltgres$'; then
      echo "[dolt-mirror-creds] recreating doltgres so install-creds.sh re-runs (mirror dark)"
      "${RUNTIME_COMPOSE[@]}" up -d --force-recreate doltgres >/dev/null
    fi
  else
    echo "[dolt-mirror-creds] no mirror creds present in runtime .env — purge is a no-op"
  fi
  exit 0
fi

: "${DOLT_CREDS_JWK_B64:?DOLT_CREDS_JWK_B64 required}"
: "${DOLT_CREDS_KEYID_B64:?DOLT_CREDS_KEYID_B64 required}"

# Clean upsert of KEY=VALUE into an env file. The VALUE is written via printf into
# a fresh file (grep-out the old line, append the new one) — it is NEVER interpolated
# into a sed pattern, so a JWK containing {,",} cannot corrupt the file or inject.
upsert_env() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    grep -vE "^${key}=" "$file" > "$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  # Preserve perms if the target already exists; default to 600 for a new file.
  if [[ -f "$file" ]]; then cat "$tmp" > "$file"; else install -m 600 "$tmp" "$file"; fi
  rm -f "$tmp"
}

b64d() { printf '%s' "$1" | base64 -d; }

touch "$RUNTIME_ENV"

jwk="$(b64d "$DOLT_CREDS_JWK_B64")"
keyid="$(b64d "$DOLT_CREDS_KEYID_B64")"
upsert_env "$RUNTIME_ENV" DOLT_CREDS_JWK "$jwk"
upsert_env "$RUNTIME_ENV" DOLT_CREDS_KEYID "$keyid"
rendered="DOLT_CREDS_JWK DOLT_CREDS_KEYID"

if [[ -n "${DOLTHUB_OWNER_B64:-}" ]]; then
  upsert_env "$RUNTIME_ENV" DOLTHUB_OWNER "$(b64d "$DOLTHUB_OWNER_B64")"
  rendered="$rendered DOLTHUB_OWNER"
fi
if [[ -n "${DOLTHUB_API_TOKEN_B64:-}" ]]; then
  upsert_env "$RUNTIME_ENV" DOLTHUB_API_TOKEN "$(b64d "$DOLTHUB_API_TOKEN_B64")"
  rendered="$rendered DOLTHUB_API_TOKEN"
fi

echo "[dolt-mirror-creds] rendered to runtime .env: ${rendered}"

# Hash-gate the doltgres recreate on the KEYID + a hash of the JWK, so an unchanged
# cred set is a pure no-op (no container churn on healthy re-flights). install-creds.sh
# runs at container start, so a genuine change needs a recreate (not a graceful reload)
# to re-run the entrypoint. Mirrors the Alloy/edge hash-gate idiom (bug.5041, task.5078).
mkdir -p "$HASH_DIR"
marker="${HASH_DIR}/dolt-mirror-creds.hash"
jwk_hash="$(printf '%s' "$jwk" | sha256sum | awk '{print $1}')"
new_hash="${keyid}:${jwk_hash}"
old_hash="$(cat "$marker" 2>/dev/null || true)"

if [[ "$new_hash" == "$old_hash" ]]; then
  echo "[dolt-mirror-creds] creds unchanged — doltgres recreate skipped (no-op)"
  exit 0
fi

# config --services can be empty if this env has no doltgres (guard, symmetric with
# the caller's grep gate). Only recreate when the service exists.
if "${RUNTIME_COMPOSE[@]}" config --services 2>/dev/null | grep -q '^doltgres$'; then
  echo "[dolt-mirror-creds] creds changed — force-recreating doltgres to re-run install-creds.sh"
  "${RUNTIME_COMPOSE[@]}" up -d --force-recreate doltgres >/dev/null
  printf '%s' "$new_hash" > "$marker"
else
  echo "[dolt-mirror-creds] doltgres service not present in this env — skipping recreate"
fi
