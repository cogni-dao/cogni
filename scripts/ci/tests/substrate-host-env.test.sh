#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# substrate-host-env.test.sh — `substrate_host_env_for` is the THIRD axis (bug.5299): WHERE a lane's
# Postgres substrate physically lives, distinct from `control_env_for` (reconcile + bank + actuator)
# and `writerFor` (payment). This test proves:
#   1. INERT: with no `substrate_host_env` cell set (every fleet row today), it is byte-identical to
#      `control_env_for` for every (lane, node) — it moves nothing until a cell is stated.
#   2. When a cell IS stated, it returns that env (the substrate host moves; control env is unchanged).
#   3. A malformed cell fails closed — never a silent default.
#   4. A missing catalog file defers to `control_env_for` (its fail-closed / fleet-control contract).

set -euo pipefail

export FLEET_CONTROL_ENV=production

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=scripts/ci/lib/appset-paths.sh
. "$REPO_ROOT/scripts/ci/lib/appset-paths.sh"

fail() { echo "❌ $*" >&2; exit 1; }

# ── 1. INERT: no cell set on any real row => byte-identical to control_env_for ──
export CATALOG_DIR="$REPO_ROOT/infra/catalog"
for node in poly operator beacon toks4 toks5 node-template levelup; do
  [ -f "$CATALOG_DIR/$node.yaml" ] || continue
  for lane in candidate-a preview production; do
    want="$(control_env_for "$lane" "$node")"
    got="$(substrate_host_env_for "$lane" "$node")"
    [ "$got" = "$want" ] \
      || fail "INERT violated for ${lane}/${node}: substrate_host_env_for='${got}' control_env_for='${want}' — an unset cell must move nothing (bug.5299)"
  done
done

# ── Fixture catalog for the stated-cell + malformed + missing-file cases ──
TMPROOT=$(mktemp -d -t substrate-host-env.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT
export CATALOG_DIR="$TMPROOT"

# A node whose candidate-a substrate is relocated to its OWN env VM while control env stays production.
cat > "$TMPROOT/movednode.yaml" <<'YAML'
name: movednode
envs: [candidate-a, preview, production]
deployment_provider:
  candidate-a: akash
  preview: akash
  production: akash
substrate_host_env:
  candidate-a: candidate-a
  preview: preview
YAML

# ── 2. A stated cell returns that env; control_env_for is UNTOUCHED (payment/reconcile don't move) ──
[ "$(substrate_host_env_for candidate-a movednode)" = "candidate-a" ] \
  || fail "stated substrate_host_env.candidate-a not honored"
[ "$(substrate_host_env_for preview movednode)" = "preview" ] \
  || fail "stated substrate_host_env.preview not honored"
# production lane has no cell => falls through to control_env_for (production).
[ "$(substrate_host_env_for production movednode)" = "$(control_env_for production movednode)" ] \
  || fail "unset production cell must fall through to control_env_for"
# The control env for the relocated candidate-a lane is STILL production — proof this is a separate axis.
[ "$(control_env_for candidate-a movednode)" = "production" ] \
  || fail "relocating the DB host must not move the control/reconcile env (bug.5299)"

# ── 3. Malformed cell fails closed ──
cat > "$TMPROOT/badnode.yaml" <<'YAML'
name: badnode
envs: [candidate-a, preview, production]
deployment_provider:
  candidate-a: akash
substrate_host_env:
  candidate-a: staging
YAML
if substrate_host_env_for candidate-a badnode >/dev/null 2>&1; then
  fail "a malformed substrate_host_env value ('staging') must fail closed, not resolve"
fi

# ── 4. Missing catalog file defers to control_env_for (which owns that fail-closed contract) ──
# production == FLEET_CONTROL_ENV, so control_env_for early-returns without needing the file.
[ "$(substrate_host_env_for production ghostnode)" = "production" ] \
  || fail "missing-file production lane must defer to control_env_for's fleet-control early-return"

echo "PASS: substrate-host-env.test.sh"
