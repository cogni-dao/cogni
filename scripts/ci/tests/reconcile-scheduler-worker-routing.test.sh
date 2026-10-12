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
ENDPOINTS_SUBPATH="infra/k8s/overlays/candidate-a/scheduler-worker/node-endpoints.patch.yaml"

# Exact live fleet shapes from the rejected a00db9b review: canonical carries
# 7 nodes/14 aliases; the watched test parent carries 9 nodes/18 aliases. The two
# shared aliases (operator/node-template and their UUIDs) agree, producing one
# deterministic 14-node/28-alias composite instead of deleting either roster.
CANONICAL_ENDPOINTS="beacon=http://beacon-node-app:3000,f97f68f2-8406-4a3b-b5a9-d579b779f19d=http://beacon-node-app:3000,levelup=http://levelup-node-app:3000,557d8b59-8e3b-42f0-9aeb-a5c171296556=http://levelup-node-app:3000,node-template=http://node-template-node-app:3000,b927a9dd-6132-4fc9-a51e-e3cee2568e3c=http://node-template-node-app:3000,operator=http://operator-node-app:3000,4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://operator-node-app:3000,poly=https://poly-test.cognidao.org,4b06359a-a859-4399-888e-a8c7a6696f7e=https://poly-test.cognidao.org,red=https://red-test.cognidao.org,921b1d1d-4ded-4a6d-b3f1-f7d6affa406a=https://red-test.cognidao.org,toks5=http://toks5-node-app:3000,f66b260b-4633-41e2-8711-b7c1b8449cc1=http://toks5-node-app:3000"
TEST_PARENT_ENDPOINTS="anotha=http://anotha-node-app:3000,e8ff1874-bde9-46c5-9b62-baee1349735e=http://anotha-node-app:3000,brother=http://brother-node-app:3000,9565871a-cb82-444e-ba18-fed9f6ea3ce1=http://brother-node-app:3000,ghcr=http://ghcr-node-app:3000,21d7ae14-210c-4495-ab6c-6fe5caad34a6=http://ghcr-node-app:3000,node-template=http://node-template-node-app:3000,b927a9dd-6132-4fc9-a51e-e3cee2568e3c=http://node-template-node-app:3000,operator=http://operator-node-app:3000,4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://operator-node-app:3000,spawny-boi=https://spawny-boi-test.cogni-testing.org,d520f82e-486a-40f1-9e4f-c8ef7a016e9a=https://spawny-boi-test.cogni-testing.org,test-cog=http://test-cog-node-app:3000,cea5ddea-a18d-44cd-8ffb-4fdd1fd104ac=http://test-cog-node-app:3000,toks2=http://toks2-node-app:3000,cf909432-5324-4bff-bb2d-7806f545eeda=http://toks2-node-app:3000,yo=http://yo-node-app:3000,bb5abfa8-5435-47e8-8725-3ae5e0762791=http://yo-node-app:3000"

# ── Fixture: an APP_SOURCE with the NEW (post-node-add) base manifests ─────────
APP_SRC="$TMPROOT/app-src"
mkdir -p "$APP_SRC/$SUBPATH" "$(dirname "$APP_SRC/$ENDPOINTS_SUBPATH")"
cat >"$APP_SRC/$SUBPATH/configmap.yaml" <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
data:
  COGNI_NODE_ENDPOINTS: "$CANONICAL_ENDPOINTS"
  TEMPORAL_NAMESPACE: "cogni-staging"
YAML
cat >"$APP_SRC/$ENDPOINTS_SUBPATH" <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
data:
  COGNI_NODE_ENDPOINTS: "$CANONICAL_ENDPOINTS"
YAML
cat >"$APP_SRC/$SUBPATH/deployment.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scheduler-worker
  annotations:
    reloader.stakater.com/auto: "true"
YAML

# Protected-main routing authority of the repository Argo actually watches.
AUTHORITY_DIR="$TMPROOT/test-parent-main"
mkdir -p "$AUTHORITY_DIR/$SUBPATH" "$(dirname "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH")"
cat >"$AUTHORITY_DIR/$SUBPATH/configmap.yaml" <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
data:
  COGNI_NODE_ENDPOINTS: "$TEST_PARENT_ENDPOINTS"
YAML
cat >"$AUTHORITY_DIR/$ENDPOINTS_SUBPATH" <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
data:
  COGNI_NODE_ENDPOINTS: "$TEST_PARENT_ENDPOINTS"
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
    SWR_ROUTE_AUTHORITY_DIR="$AUTHORITY_DIR" \
    SWR_RECONCILE_SUMMARY_FILE="$TMPROOT/summary.json" \
    bash "$RECONCILE" candidate-a
}

# ── 1. First run propagates the new routing ───────────────────────────────────
out1="$(run)" || fail "first reconcile exited non-zero: $out1"
echo "$out1" | grep -q "updated locally" || fail "expected 'updated locally', got: $out1"
COMPOSITE="$(yq -N '.data.COGNI_NODE_ENDPOINTS' "$DEPLOY_DIR/$ENDPOINTS_SUBPATH")"
[ "$(tr ',' '\n' <<<"$COMPOSITE" | wc -l | tr -d ' ')" = 28 ] \
  || fail "expected 28 aliases from the 7+9 node authorities"
for alias in anotha brother ghcr spawny-boi test-cog toks2 yo beacon levelup poly red toks5 operator node-template; do
  tr ',' '\n' <<<"$COMPOSITE" | grep -q "^${alias}=" \
    || fail "composite lost active alias ${alias}"
done
[ -f "$DEPLOY_DIR/$SUBPATH/deployment.yaml" ] \
  || fail "Reloader-annotated deployment.yaml not propagated to deploy branch"
grep -q "reloader.stakater.com/auto" "$DEPLOY_DIR/$SUBPATH/deployment.yaml" \
  || fail "Reloader annotation missing after propagation"
echo "PASS: composes real canonical + test-parent rosters without clobbering either authority"

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

# ── 6. Conflicting ownership of one alias is never last-writer-wins ──────────
sed -i.bak 's#operator=http://operator-node-app:3000#operator=https://foreign.example#' \
  "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH" "$AUTHORITY_DIR/$SUBPATH/configmap.yaml"
if run >/dev/null 2>&1; then
  fail "conflicting route authorities must fail closed"
fi
echo "PASS: route-authority collision fails closed"

echo "PASS: reconcile-scheduler-worker-routing.test.sh"
