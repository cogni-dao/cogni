#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/tests/snapshot-overlay-digests.test.sh
#
# Fixture-driven regression for task.0373 self-heal. Cases:
#   1. All four ALL_TARGETS overlays present with `digest:` pin → 4 TSV rows.
#   2. One overlay missing → 3 rows; missing target silently omitted.
#   3. Mixed `digest:` / `newTag:` (no digest yet, e.g. cold-start) → both forms
#      emitted; `newTag:` row is `repo:tag` form.
#
# The full snapshot+rsync-clobber+restore round-trip is exercised by
# candidate-flight.yml's flight job in CI (promote-k8s-image.sh uses GNU
# sed extensions and is not portable to BSD sed on macOS).
#
# Run: bash scripts/ci/tests/snapshot-overlay-digests.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SNAP="${CI_DIR}/snapshot-overlay-digests.sh"

if [ ! -f "$SNAP" ]; then
  echo "[FAIL] required scripts missing" >&2
  exit 1
fi

TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

PASS=0
FAIL=0

emit_overlay() {
  # emit_overlay <env> <app> <digest|tag-marker:value>
  local env="$1" app="$2" pin="$3"
  local dir="$TMPROOT/$env-tree/infra/k8s/overlays/${env}/${app}"
  mkdir -p "$dir"
  if [[ "$pin" == sha256:* ]]; then
    cat >"$dir/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
images:
  - name: ghcr.io/cogni-dao/cogni-template
    newName: ghcr.io/cogni-dao/cogni-template
    digest: "$pin"
EOF
  else
    # tag form
    cat >"$dir/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
images:
  - name: ghcr.io/cogni-dao/cogni-template
    newName: ghcr.io/cogni-dao/cogni-template
    newTag: $pin
EOF
  fi
}

snapshot_in() {
  local tree="$1" env="$2"
  ( cd "$tree" && OVERLAY_ENV="$env" bash "$SNAP" )
}

assert_eq() {
  local name="$1" expected="$2" got="$3"
  if [ "$expected" = "$got" ]; then
    echo "[PASS] $name"
    PASS=$((PASS+1))
  else
    echo "[FAIL] $name"
    echo "  expected: $expected"
    echo "  got:      $got"
    FAIL=$((FAIL+1))
  fi
}

# ── Case 1: all overlays present with digest pins
ENV=candidate-a
TREE="$TMPROOT/$ENV-tree"
rm -rf "$TREE"
emit_overlay "$ENV" node-template    sha256:aaaa
emit_overlay "$ENV" operator         sha256:bbbb
emit_overlay "$ENV" oss              sha256:cccc
emit_overlay "$ENV" scheduler-worker sha256:dddd
out=$(snapshot_in "$TREE" "$ENV")
expected="node-template	ghcr.io/cogni-dao/cogni-template@sha256:aaaa
operator	ghcr.io/cogni-dao/cogni-template@sha256:bbbb
oss	ghcr.io/cogni-dao/cogni-template@sha256:cccc
scheduler-worker	ghcr.io/cogni-dao/cogni-template@sha256:dddd"
assert_eq "case 1: all four targets snapshotted" "$expected" "$out"

# ── Case 2: one overlay missing
TREE="$TMPROOT/case2"
mkdir -p "$TREE"
emit_overlay "$ENV" operator sha256:bbbb
mv "$TMPROOT/$ENV-tree/infra" "$TREE/"
rm -rf "$TREE/infra/k8s/overlays/$ENV/oss"
out=$(snapshot_in "$TREE" "$ENV")
# node-template + operator + scheduler-worker remain
expected="node-template	ghcr.io/cogni-dao/cogni-template@sha256:aaaa
operator	ghcr.io/cogni-dao/cogni-template@sha256:bbbb
scheduler-worker	ghcr.io/cogni-dao/cogni-template@sha256:dddd"
assert_eq "case 2: missing overlay omitted" "$expected" "$out"

# ── Case 3: mixed digest + newTag
TREE="$TMPROOT/case3-tree"
emit_overlay candidate-a node-template    sha256:1111
emit_overlay candidate-a operator         sha256:3333
emit_overlay candidate-a oss              pr-999-abc-oss
emit_overlay candidate-a scheduler-worker sha256:4444
mv "$TMPROOT/candidate-a-tree" "$TREE"  # latest emit_overlay run
out=$(snapshot_in "$TREE" candidate-a)
expected="node-template	ghcr.io/cogni-dao/cogni-template@sha256:1111
operator	ghcr.io/cogni-dao/cogni-template@sha256:3333
oss	ghcr.io/cogni-dao/cogni-template:pr-999-abc-oss
scheduler-worker	ghcr.io/cogni-dao/cogni-template@sha256:4444"
assert_eq "case 3: tag-form preserved" "$expected" "$out"

echo
echo "── snapshot-overlay-digests test summary: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
