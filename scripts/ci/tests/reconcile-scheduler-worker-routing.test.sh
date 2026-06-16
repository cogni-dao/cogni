#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Unit tests for the env-singleton scheduler-worker routing reconcile
# (scripts/ci/reconcile-scheduler-worker-routing.sh) — the deploy-branch half of
# bug.5035/bug.5021. Proves the propagation that makes a node-add reach the worker:
#   1. propagate: copies the catalog-rendered base/scheduler-worker onto the
#      deploy/<env>-scheduler-worker checkout (configmap COGNI_NODE_ENDPOINTS +
#      the Reloader-annotated deployment) and commits it.
#   2. idempotent: a second run with an unchanged source is a no-op (status "noop",
#      no new commit) — so sibling flights don't churn the shared branch.
#   3. preserves the env overlay: the reconcile only touches base/, never the
#      digest-pinning overlay, so promotion state survives.
#   4. emits a structured JSON summary for Grafana.
#
# Uses DEPLOY_BRANCH_DIR (reuse a local checkout, no clone/push) as the test seam,
# exactly the way reconcile-node-dns.test.sh uses a Cloudflare shim — no network.
#
# Run: bash scripts/ci/tests/reconcile-scheduler-worker-routing.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RECONCILE="$REPO_ROOT/scripts/ci/reconcile-scheduler-worker-routing.sh"

TMPROOT=$(mktemp -d -t reconcile-swr.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

SUBPATH="infra/k8s/base/scheduler-worker"

# ── Fixture: an APP_SOURCE with the NEW (post-node-add) base manifests ─────────
APP_SRC="$TMPROOT/app-src"
mkdir -p "$APP_SRC/$SUBPATH"
cat >"$APP_SRC/$SUBPATH/configmap.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
data:
  COGNI_NODE_ENDPOINTS: "operator=http://operator-node-app:3000,4ff8eac1-x=http://operator-node-app:3000,throwaway=http://throwaway-node-app:3000,abcd1234-y=http://throwaway-node-app:3000"
  TEMPORAL_NAMESPACE: "cogni-staging"
YAML
cat >"$APP_SRC/$SUBPATH/deployment.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scheduler-worker
  annotations:
    reloader.stakater.com/auto: "true"
YAML

# ── Fixture: a deploy/<env>-scheduler-worker checkout with the OLD configmap +
#    a digest-pinned overlay that MUST survive the reconcile ────────────────────
DEPLOY_DIR="$TMPROOT/deploy-branch"
mkdir -p "$DEPLOY_DIR/$SUBPATH"
mkdir -p "$DEPLOY_DIR/infra/k8s/overlays/candidate-a/scheduler-worker"
cat >"$DEPLOY_DIR/$SUBPATH/configmap.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
data:
  COGNI_NODE_ENDPOINTS: "operator=http://operator-node-app:3000,4ff8eac1-x=http://operator-node-app:3000"
  TEMPORAL_NAMESPACE: "cogni-staging"
YAML
# deployment.yaml deliberately absent on the deploy branch (pre-#1609 shape) — the
# reconcile must ADD it (proves the Reloader annotation reaches the branch).
OVERLAY="$DEPLOY_DIR/infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml"
cat >"$OVERLAY" <<'YAML'
images:
  - name: ghcr.io/cogni-dao/cogni-template
    digest: "sha256:DEADBEEFpinned"
YAML
OVERLAY_BEFORE="$(cat "$OVERLAY")"

git -C "$DEPLOY_DIR" init -q
git -C "$DEPLOY_DIR" config user.email t@t.t
git -C "$DEPLOY_DIR" config user.name t
git -C "$DEPLOY_DIR" add -A
git -C "$DEPLOY_DIR" commit -q -m "seed deploy branch (old routing)"

run() {
  APP_SOURCE_DIR="$APP_SRC" \
    DEPLOY_BRANCH_DIR="$DEPLOY_DIR" \
    SWR_RECONCILE_SUMMARY_FILE="$TMPROOT/summary.json" \
    bash "$RECONCILE" candidate-a
}

# ── 1. First run propagates the new routing ───────────────────────────────────
out1="$(run)" || fail "first reconcile exited non-zero: $out1"
echo "$out1" | grep -q "updated locally" || fail "expected 'updated locally', got: $out1"
grep -q "throwaway=http://throwaway-node-app:3000" "$DEPLOY_DIR/$SUBPATH/configmap.yaml" \
  || fail "new node endpoint not propagated to deploy-branch configmap"
[ -f "$DEPLOY_DIR/$SUBPATH/deployment.yaml" ] \
  || fail "Reloader-annotated deployment.yaml not propagated to deploy branch"
grep -q "reloader.stakater.com/auto" "$DEPLOY_DIR/$SUBPATH/deployment.yaml" \
  || fail "Reloader annotation missing after propagation"
echo "PASS: propagates new routing + Reloader-annotated deployment"

# ── 2. Overlay digest preserved (reconcile only touches base/) ─────────────────
[ "$(cat "$OVERLAY")" = "$OVERLAY_BEFORE" ] \
  || fail "env overlay was modified — digest-pin must be preserved"
echo "PASS: env overlay (pinned digest) preserved"

# ── 3. Summary JSON is structured + status=updated-local ───────────────────────
[ -f "$TMPROOT/summary.json" ] || fail "no summary JSON written"
python3 - "$TMPROOT/summary.json" <<'PY' || fail "summary JSON malformed / wrong status"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["type"] == "scheduler_worker_routing_reconcile", d
assert d["status"] == "updated-local", d
assert d["deploy_env"] == "candidate-a", d
assert d["branch"] == "deploy/candidate-a-scheduler-worker", d
PY
echo "PASS: structured summary JSON"

# ── 4. Idempotent: second run is a no-op, no new commit ────────────────────────
commits_before="$(git -C "$DEPLOY_DIR" rev-list --count HEAD)"
out2="$(run)" || fail "second reconcile exited non-zero: $out2"
echo "$out2" | grep -qi "no-op" || fail "expected idempotent no-op, got: $out2"
commits_after="$(git -C "$DEPLOY_DIR" rev-list --count HEAD)"
[ "$commits_before" = "$commits_after" ] || fail "no-op run created a commit ($commits_before → $commits_after)"
python3 - "$TMPROOT/summary.json" <<'PY' || fail "second-run summary status != noop"
import json, sys
assert json.load(open(sys.argv[1]))["status"] == "noop"
PY
echo "PASS: idempotent (second run is a clean no-op)"

# ── 5. Fail-loud on a missing source ───────────────────────────────────────────
if APP_SOURCE_DIR="$TMPROOT/nope" DEPLOY_BRANCH_DIR="$DEPLOY_DIR" \
   bash "$RECONCILE" candidate-a >/dev/null 2>&1; then
  fail "reconcile should fail-loud when source manifests are absent"
fi
echo "PASS: fail-loud on missing source"

echo "PASS: reconcile-scheduler-worker-routing.test.sh"
