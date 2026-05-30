#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/secrets/set-secret.sh — write one secret value to OpenBao at
# cogni/<env>/<service>/<KEY>. The canonical CLI entry point (Spec
# Invariant 9 TOOLING_IS_THE_INTERFACE).
#
# Usage: pnpm secrets:set <env> <service> <KEY>
#   <env>     candidate-a | preview | production
#   <service> a catalog name (infra/catalog/<name>.yaml) OR `_shared`
#             (refuses `_system` — system paths edited by bootstrap only,
#             per Spec Invariant 10 SEED_TOKEN_IS_NEVER_TOUCHED_MANUALLY)
#   <KEY>     env var name; uppercase + digits + underscores
#
# Value: read from secure stdin (never echoed). Pipe input is supported
#        for non-interactive use (CI / bootstrap auto-seed):
#   echo -n "value" | pnpm secrets:set candidate-a node-app FOO
#
# Connectivity: $BAO_ADDR + $BAO_TOKEN must be set by the caller.
#   Operator path: `kubectl port-forward -n openbao svc/openbao 8200:8200`
#                  + `bao login -method=kubernetes role=<your-role>` (or any
#                  short-lived token issuer). NEVER export the bootstrap root
#                  token — that credential lives in the cluster only after
#                  Phase 5b unseal, per spec Invariant NO_OPERATOR_ROOT_TOKEN_
#                  ON_LAPTOP. See docs/guides/secrets-add-new.md.
# Tests stub via $SET_SECRET_BAO (executable path) — see
# scripts/ci/tests/set-secret.test.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

err()  { printf '%s\n' "$*" >&2; }
die()  { err "$@"; exit 2; }

usage() {
  err "Usage: pnpm secrets:set <env> <service> <KEY>"
  err "  env     candidate-a | preview | production"
  err "  service infra/catalog/<name>.yaml, or _shared"
  err "  KEY     uppercase + digits + underscores"
  err ""
  err "Value is read from stdin (interactive prompt or pipe). Never echoed."
  exit 2
}

[[ $# -eq 3 ]] || usage
env_name="$1"; service="$2"; key="$3"

# ── Env validation ──────────────────────────────────────────────────────────
case "$env_name" in
  candidate-a|preview|production) ;;
  *) die "Invalid env: '$env_name'. Must be candidate-a|preview|production." ;;
esac

# ── Service validation ──────────────────────────────────────────────────────
# `_shared` is a sanctioned cross-service namespace per the spec. `_system`
# is hard-refused (bootstrap-only). Other names must match a catalog entry.
case "$service" in
  _system)
    die "Refusing to write to _system/* — system paths are edited by bootstrap only (Spec Invariant 10 SEED_TOKEN_IS_NEVER_TOUCHED_MANUALLY)."
    ;;
  _shared)
    ;;
  _*)
    die "Reserved namespace '$service'. Only _shared is allowed; _system is bootstrap-only."
    ;;
  *)
    catalog_file="$REPO_ROOT/infra/catalog/${service}.yaml"
    if [[ ! -f "$catalog_file" ]]; then
      die "Unknown service '$service' — no infra/catalog/${service}.yaml. List catalog entries: ls infra/catalog/*.yaml"
    fi
    ;;
esac

# ── Key validation ──────────────────────────────────────────────────────────
if ! [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
  die "Invalid KEY '$key'. Must match ^[A-Z][A-Z0-9_]*$ (uppercase + digits + underscores; must start with letter)."
fi

# ── Read value (secure stdin) ───────────────────────────────────────────────
if [[ -t 0 ]]; then
  # Interactive: prompt + read silently.
  printf 'Value for cogni/%s/%s/%s (input hidden): ' "$env_name" "$service" "$key" >&2
  IFS= read -rs value
  printf '\n' >&2
else
  # Pipe / heredoc: read everything from stdin without trimming.
  value="$(cat)"
fi

if [[ -z "$value" ]]; then
  die "Empty value rejected. Run again and provide a non-empty value."
fi

# ── Patch invocation ────────────────────────────────────────────────────────
# The KV v2 path mounted at `cogni/` (see ClusterSecretStore) — `bao kv patch`
# writes to data/<path>. `kv patch` cannot create an absent path, so first
# write uses `kv put`; subsequent writes use `kv patch` (preserves siblings).
# Value is passed via stdin (`key=-`) so it never appears in argv / `ps`.
#
# Execution modes:
#  1. $SET_SECRET_BAO set → invoke that command directly (test shim)
#  2. $BAO_ADDR + $BAO_TOKEN set → invoke `bao` from PATH
# No SSH fallback. Operators must obtain a short-lived OpenBao token
# themselves (port-forward + `bao login -method=kubernetes`, or via the
# future workflow_dispatch path). The bootstrap root token never leaves
# the cluster after Phase 5b — Spec Invariant NO_OPERATOR_ROOT_TOKEN_ON_LAPTOP.

bao_path="cogni/${env_name}/${service}"

if [[ -n "${SET_SECRET_BAO:-}" ]]; then
  # Test shim — bypass real bao. Shim receives: $1=path, $2=key, value via stdin.
  printf '%s' "$value" | "$SET_SECRET_BAO" "$bao_path" "$key"
  exit_code=$?
  exit $exit_code
fi

if [[ -z "${BAO_ADDR:-}" || -z "${BAO_TOKEN:-}" ]]; then
  die "BAO_ADDR + BAO_TOKEN must be set. Obtain a short-lived token:
    kubectl port-forward -n openbao svc/openbao 8200:8200 &
    export BAO_ADDR=http://127.0.0.1:8200
    bao login -method=kubernetes role=<your-role>   # or another short-lived issuer
    export BAO_TOKEN=\$(bao print token)
See docs/guides/secrets-add-new.md."
fi

command -v bao >/dev/null 2>&1 || die "bao CLI not found on PATH (https://openbao.org/docs/install/)."

op="patch"
if ! BAO_ADDR="$BAO_ADDR" BAO_TOKEN="$BAO_TOKEN" bao kv metadata get "$bao_path" >/dev/null 2>&1; then
  op="put"
fi
# bao kv <op> <path> KEY=- reads value from stdin (OpenBao 2.x+).
printf '%s' "$value" | BAO_ADDR="$BAO_ADDR" BAO_TOKEN="$BAO_TOKEN" \
  bao kv "$op" "$bao_path" "${key}=-"
