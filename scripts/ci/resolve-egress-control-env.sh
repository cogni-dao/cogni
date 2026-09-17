#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Module: scripts/ci/resolve-egress-control-env.sh
# Purpose: Name the env whose VM firewall must carry a lane's compute-egress
#          allowlist — i.e. WHICH CLUSTER we harden, not which CIDRs we allow.
#
# WHY THIS IS NOT THE LANE (bug.5206, docs/spec/node-ci-cd-contract.md § Lane vs
# control env): the allowlist CONTENTS are the lane's — render-compute-egress-allowlist.sh
# scopes CIDRs by `envs:` + akash placement (bug.5191), and that is correct. But the
# allowlist exists to let an Akash provider NAT reach Postgres/Temporal/Redis/LiteLLM,
# and for a foreign-custodied lane those live on the CONTROL env's VM, never the lane's.
# Hardening the lane's VM opens ports on a machine the workload never dials while leaving
# the substrate it DOES dial firewalled — the lease mints, `/version` answers (the app
# needs nothing to boot), and `/readyz?deep=1` 503s with no local signal.
#
# The host is not the whole story: VM_HOST *and* SSH_DEPLOY_KEY are GitHub-environment
# scoped, so a caller cannot fix this by overriding the host alone — it would present the
# lane's deploy key to a foreign VM. The egress JOB must run in the env this prints.
#
# Fails loud rather than guessing: if one lane's akash rows disagree on control env
# (the cogni-test-org case bug.5208 leaves open), there is no single firewall to harden
# and the caller must split the job — silently picking one would under-open the other.
#
# Usage: resolve-egress-control-env.sh <lane>       # e.g. candidate-a
# Env:   COGNI_CATALOG_ROOT — override catalog dir (tests).
# Links: bug.5206, bug.5191, bug.5208, task.5052
set -euo pipefail

LANE="${1:?usage: resolve-egress-control-env.sh <lane>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CATALOG_ROOT="${COGNI_CATALOG_ROOT:-$REPO_ROOT/infra/catalog}"

command -v yq >/dev/null 2>&1 || { echo "[resolve-egress-control-env] ERROR: yq is required" >&2; exit 1; }
[ -d "$CATALOG_ROOT" ] || { echo "[resolve-egress-control-env] ERROR: catalog root not found: $CATALOG_ROOT" >&2; exit 1; }

# shellcheck source=scripts/ci/lib/image-tags.sh
source "$SCRIPT_DIR/lib/image-tags.sh"
# shellcheck source=scripts/ci/lib/appset-paths.sh
CATALOG_DIR="$CATALOG_ROOT" source "$SCRIPT_DIR/lib/appset-paths.sh"

# SAME row predicate as render-compute-egress-allowlist.sh — deployed to the lane AND
# akash-placed there. Kept identical on purpose: the firewall we harden and the CIDRs we
# write must never be derived from different row sets.
control_envs=""
for catalog_file in "$CATALOG_ROOT"/*.yaml; do
  [ -e "$catalog_file" ] || continue
  row_name="$(yq -N '.name // ""' "$catalog_file")"

  yq -N -e ".envs // [] | contains([\"$LANE\"])" "$catalog_file" >/dev/null 2>&1 || continue

  provider="$(deployment_provider_for_target "$row_name" "$LANE")" || {
    echo "[resolve-egress-control-env] ERROR: unresolvable deployment_provider for '$row_name' in env '$LANE'" >&2
    exit 1
  }
  [ "$provider" = "akash" ] || continue

  ce="$(CATALOG_DIR="$CATALOG_ROOT" control_env_for "$LANE" "$row_name")"
  control_envs="$(printf '%s\n%s' "$control_envs" "$ce")"
done

uniq_envs="$(printf '%s\n' "$control_envs" | sed '/^$/d' | sort -u)"
count="$(printf '%s\n' "$uniq_envs" | sed '/^$/d' | wc -l | tr -d ' ')"

# No akash row in this lane: nothing dials in from a provider NAT, so there is no
# firewall to open. The lane's own env is the correct (no-op) target — the render
# emits an allow-free file and the hardener keeps the public DROP.
if [ "$count" = "0" ]; then printf '%s\n' "$LANE"; exit 0; fi

if [ "$count" != "1" ]; then
  echo "[resolve-egress-control-env] ERROR: lane '$LANE' has akash rows custodied by more than one control env:" >&2
  printf '  %s\n' $uniq_envs >&2
  echo "  One egress job cannot harden two VMs — split the job per control env (bug.5208)." >&2
  exit 1
fi

printf '%s\n' "$uniq_envs"
