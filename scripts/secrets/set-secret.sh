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
# Dynamic manual-cell banks: only owned probe PASSWORD and typed applied custody/
# evidence INPUT keys, production only. SET_SECRET_EXPECTED_VERSION is mandatory;
# positive versions use HTTP PATCH CAS only, zero uses proven-absent atomic creation.
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

# Narrow dynamic manual-cell components use the SAME canonical CLI and writer token.
component_node='' component_kind=''
case "$service/$key" in
  *-database-recovery-probe/DATABASE_RECOVERY_PROBE_PASSWORD)
    component_node="${service%-database-recovery-probe}"; component_kind=probe-password ;;
  *-database-cell/DATABASE_CELL_APPLIED_CUSTODY_JSON|*-database-cell/DATABASE_CELL_APPLIED_EVIDENCE_BUNDLE_JSON)
    component_node="${service%-database-cell}"; component_kind=applied-input ;;
esac
if [[ -n "$component_kind" ]]; then
  [[ "$component_node" =~ ^[a-z][a-z0-9-]{0,62}$ && -f "$REPO_ROOT/infra/catalog/${component_node}.yaml" ]] || die "Dynamic component node is not catalog-owned."
  command -v yq >/dev/null 2>&1 || die "yq is required for catalog-owned components."
  [[ "$(yq -r '.type // ""' "$REPO_ROOT/infra/catalog/${component_node}.yaml")" == node ]] || die "Dynamic component owner must be a catalog node."
  [[ "$env_name" == production ]] || die "Manual cell component writes require production."
  [[ "${SET_SECRET_EXPECTED_VERSION:-}" =~ ^(0|[1-9][0-9]*)$ ]] || die "Dynamic component requires explicit SET_SECRET_EXPECTED_VERSION."
fi

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
    if [[ ! -f "$catalog_file" && -z "$component_kind" ]]; then
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

if [[ "$component_kind" == applied-input ]]; then
  command -v yq >/dev/null 2>&1 || die "yq is required for catalog-owned applied input validation."
  component_node_id="$(yq -r '.node_id // ""' "$REPO_ROOT/infra/catalog/${component_node}.yaml")"
  if [[ -z "$component_node_id" ]]; then
    [[ -f "$REPO_ROOT/nodes/${component_node}/.cogni/repo-spec.yaml" ]] || die "Owned node identity unavailable."
    component_node_id="$(yq -r '.node_id // ""' "$REPO_ROOT/nodes/${component_node}/.cogni/repo-spec.yaml")"
  fi
  # Typed validation stdout contains private custody; discard it, never log or echo.
  printf '%s' "$value" | pnpm --dir "$REPO_ROOT" exec tsx "$REPO_ROOT/scripts/lib/materialize-database-cell-placement.ts" --validate-applied-input "$component_node" "$component_node_id" "$key" >/dev/null || die "Owned typed applied input validation refused."
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

# Explicit expected version is mandatory for the three reviewed dynamic input keys.
# Never use read/write fallback: its CAS semantics differ from HTTP PATCH.
if [[ -n "$component_kind" ]]; then
  if [[ "$SET_SECRET_EXPECTED_VERSION" == 0 ]]; then
    existing_rc=0
    existing_out="$(bao kv get -format=json "$bao_path" 2>&1)" || existing_rc=$?
    [[ "$existing_rc" != 0 ]] || die "CAS0 requires a genuinely absent component bank."
    if ! printf '%s' "$existing_out" | grep -qiE 'no value found|does not exist|code: 404'; then
      die "CAS0 absence is unproved; refusing component creation."
    fi
    printf '%s' "$value" | bao kv put -cas=0 "$bao_path" "${key}=-"
  else
    printf '%s' "$value" | bao kv patch -method=patch -cas="$SET_SECRET_EXPECTED_VERSION" "$bao_path" "${key}=-"
  fi
  exit $?
fi

# bug.5068: `cogni/<env>/<service>` is a SHARED multi-key bucket, and `bao kv put`
# REPLACES every key at the path. The old guard (`kv metadata get` fails → put)
# conflated a TRANSIENT metadata-get failure (network churn, token flake) with an
# absent path — a transient failure against a populated bucket would `put` this one
# key and wipe every sibling (the deploy-infra bug.5068 class). Fix: `patch` FIRST
# (merges siblings), and only fall back to a destructive `put` on a POSITIVE
# "does not exist" signal in patch's OWN output. Any other failure exits non-zero
# without clobbering. `bao kv <op> <path> KEY=- reads value from stdin (OpenBao 2.x+).
set +e
patch_out="$(printf '%s' "$value" | BAO_ADDR="$BAO_ADDR" BAO_TOKEN="$BAO_TOKEN" \
  bao kv patch "$bao_path" "${key}=-" 2>&1)"
patch_rc=$?
set -e
if [[ $patch_rc -eq 0 ]]; then
  printf '%s\n' "$patch_out"
  exit 0
fi

# A kv patch on a never-written KV v2 path returns `Code: 404` with an EMPTY raw
# message (no "not found" text) — unambiguous absence on a FRESH node/env, so put
# cannot clobber siblings (mirrors provision seed_kv fix a54f24809b).
if printf '%s' "$patch_out" | grep -qiE 'no value found|does not exist|not found|code: 404'; then
  # Genuinely absent — safe to create; no siblings to clobber.
  printf '%s' "$value" | BAO_ADDR="$BAO_ADDR" BAO_TOKEN="$BAO_TOKEN" \
    bao kv put "$bao_path" "${key}=-"
  exit $?
fi

# Transient/unknown failure — NEVER put (would wipe siblings at this shared path).
printf '%s\n' "$patch_out" >&2
die "bao kv patch on ${bao_path} failed (rc=${patch_rc}) without a positive 'absent' signal; refusing to put (would clobber sibling keys). Retry once OpenBao is reachable."
