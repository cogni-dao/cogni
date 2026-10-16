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
#   3. heals the env overlay from the lane substrate authority while preserving
#      the deployed immutable image identity.
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
# candidate rosters contain 3 canonical + 8 watched nodes, sharing operator.
# The 10-node composite must preserve every watched member without polling
# nodes whose catalog envs exclude candidate-a.
CANONICAL_ENDPOINTS="beacon=http://beacon-node-app:3000,f97f68f2-8406-4a3b-b5a9-d579b779f19d=http://beacon-node-app:3000,levelup=http://levelup-node-app:3000,557d8b59-8e3b-42f0-9aeb-a5c171296556=http://levelup-node-app:3000,node-template=http://node-template-node-app:3000,b927a9dd-6132-4fc9-a51e-e3cee2568e3c=http://node-template-node-app:3000,operator=http://operator-node-app:3000,4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://operator-node-app:3000,poly=https://poly-test.cognidao.org,4b06359a-a859-4399-888e-a8c7a6696f7e=https://poly-test.cognidao.org,red=https://red-test.cognidao.org,921b1d1d-4ded-4a6d-b3f1-f7d6affa406a=https://red-test.cognidao.org,toks5=http://toks5-node-app:3000,f66b260b-4633-41e2-8711-b7c1b8449cc1=http://toks5-node-app:3000"
TEST_PARENT_ENDPOINTS="anotha=http://anotha-node-app:3000,e8ff1874-bde9-46c5-9b62-baee1349735e=http://anotha-node-app:3000,brother=http://brother-node-app:3000,9565871a-cb82-444e-ba18-fed9f6ea3ce1=http://brother-node-app:3000,ghcr=http://ghcr-node-app:3000,21d7ae14-210c-4495-ab6c-6fe5caad34a6=http://ghcr-node-app:3000,node-template=http://node-template-node-app:3000,b927a9dd-6132-4fc9-a51e-e3cee2568e3c=http://node-template-node-app:3000,operator=http://operator-node-app:3000,4ff8eac1-4eba-4ed0-931b-b1fe4f64713d=http://operator-node-app:3000,spawny-boi=https://spawny-boi-test.cogni-testing.org,d520f82e-486a-40f1-9e4f-c8ef7a016e9a=https://spawny-boi-test.cogni-testing.org,test-cog=http://test-cog-node-app:3000,cea5ddea-a18d-44cd-8ffb-4fdd1fd104ac=http://test-cog-node-app:3000,toks2=http://toks2-node-app:3000,cf909432-5324-4bff-bb2d-7806f545eeda=http://toks2-node-app:3000,yo=http://yo-node-app:3000,bb5abfa8-5435-47e8-8725-3ae5e0762791=http://yo-node-app:3000"

seed_catalog() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, pathlib, re, sys
root, csv, excluded = pathlib.Path(sys.argv[1]), sys.argv[2], set(sys.argv[3].split(","))
rows = dict(entry.split("=", 1) for entry in csv.split(","))
catalog = root / "infra/catalog"
catalog.mkdir(parents=True, exist_ok=True)
for name, endpoint in rows.items():
    if re.fullmatch(r"[0-9a-f-]{36}", name):
        continue
    ids = [key for key, value in rows.items() if re.fullmatch(r"[0-9a-f-]{36}", key) and value == endpoint]
    assert len(ids) == 1
    row = {"name": name, "type": "node", "node_id": ids[0], "envs": ["production"] if name in excluded else ["candidate-a", "production"]}
    (catalog / (name + ".yaml")).write_text(json.dumps(row))
PY
}

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
  IMAGE_DIGEST: "placeholder"
YAML
cat >"$APP_SRC/$ENDPOINTS_SUBPATH" <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
  annotations:
    reloader.stakater.com/ignore: "true"
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
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: scheduler-worker
          image: ghcr.io/cogni-dao/cogni-template:placeholder
          envFrom:
            - configMapRef:
                name: scheduler-worker-config
          resources:
            limits:
              memory: 1Gi
YAML
cat >"$APP_SRC/$SUBPATH/kustomization.yaml" <<'YAML'
resources:
  - configmap.yaml
  - deployment.yaml
YAML
seed_catalog "$APP_SRC" "$CANONICAL_ENDPOINTS" beacon,levelup,node-template,toks5
cp "$REPO_ROOT/infra/k8s/overlays/candidate-a/scheduler-worker/serial-rollout.patch.yaml" \
  "$APP_SRC/infra/k8s/overlays/candidate-a/scheduler-worker/serial-rollout.patch.yaml"
cp "$REPO_ROOT/infra/k8s/overlays/candidate-a/scheduler-worker/replicas.patch.yaml" \
  "$APP_SRC/infra/k8s/overlays/candidate-a/scheduler-worker/replicas.patch.yaml"

# Routing + lane-bootstrap authorities of the repository Argo actually watches.
AUTHORITY_DIR="$TMPROOT/test-parent-main"
mkdir -p "$AUTHORITY_DIR/$SUBPATH" "$(dirname "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH")"
seed_catalog "$AUTHORITY_DIR" "$TEST_PARENT_ENDPOINTS" anotha
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
cat >"$AUTHORITY_DIR/infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml" <<'YAML'
resources:
  - ../../../base/scheduler-worker
images:
  - name: ghcr.io/cogni-dao/cogni-template
    newName: ghcr.io/cogni-dao/cogni-template
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
patches:
  - target:
      kind: ConfigMap
      name: scheduler-worker-config
    patch: |
      - op: replace
        path: /data/IMAGE_DIGEST
        value: "candidate-a-placeholder-scheduler-worker"
      - op: replace
        path: /data/COGNI_NODE_ENDPOINTS
        value: "operator=http://stale-operator:3000"
  - target: { kind: Service, name: temporal }
    patch: |
      apiVersion: v1
      kind: Service
      metadata:
        name: temporal
      spec:
        type: ExternalName
        externalName: cogni-candidate-a.vm.cognidao.org
YAML
cat >"$APP_SRC/$SUBPATH/temporal.yaml" <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: temporal
spec:
  type: ExternalName
  externalName: placeholder.example
YAML
printf '  - temporal.yaml\n' >> "$APP_SRC/$SUBPATH/kustomization.yaml"

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
    newName: ghcr.io/cogni-dao/cogni-template
    digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
patches:
  - target:
      kind: ConfigMap
      name: scheduler-worker-config
    patch: |
      - op: replace
        path: /data/IMAGE_DIGEST
        value: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  - target: { kind: Service, name: temporal }
    patch: |
      apiVersion: v1
      kind: Service
      metadata:
        name: temporal
      spec:
        type: ExternalName
        externalName: cogni-candidate-a.vm.cogni-testing.org
YAML
mkdir -p "$DEPLOY_DIR/.promote-state"
cat >"$DEPLOY_DIR/.promote-state/source-sha-by-app.json" <<'JSON'
{"scheduler-worker":"cccccccccccccccccccccccccccccccccccccccc"}
JSON

git -C "$DEPLOY_DIR" init -q
git -C "$DEPLOY_DIR" config user.email t@t.t
git -C "$DEPLOY_DIR" config user.name t
git -C "$DEPLOY_DIR" add -A
git -C "$DEPLOY_DIR" commit -q -m "seed deploy branch (old routing)"

run() {
  APP_SOURCE_DIR="$APP_SRC" \
    DEPLOY_BRANCH_DIR="$DEPLOY_DIR" \
    SWR_ROUTE_AUTHORITY_DIR="$AUTHORITY_DIR" \
    SWR_SUBSTRATE_AUTHORITY_DIR="$AUTHORITY_DIR" \
    SWR_RECONCILE_SUMMARY_FILE="$TMPROOT/summary.json" \
    bash "$RECONCILE" candidate-a
}

# ── 1. First run propagates the new routing ───────────────────────────────────
out1="$(run)" || fail "first reconcile exited non-zero: $out1"
echo "$out1" | grep -q "updated locally" || fail "expected 'updated locally', got: $out1"
COMPOSITE="$(yq -N '.data.COGNI_NODE_ENDPOINTS' "$DEPLOY_DIR/$ENDPOINTS_SUBPATH")"
[ "$(tr ',' '\n' <<<"$COMPOSITE" | wc -l | tr -d ' ')" = 20 ] \
  || fail "expected 20 aliases from the 3+8 candidate member authorities"
for alias in brother ghcr spawny-boi test-cog toks2 yo poly red operator node-template; do
  tr ',' '\n' <<<"$COMPOSITE" | grep -q "^${alias}=" \
    || fail "composite lost active alias ${alias}"
done
for alias in anotha beacon levelup toks5; do
  if tr ',' '\n' <<<"$COMPOSITE" | grep -q "^${alias}="; then
    fail "out-of-environment node remained: $alias"
  fi
done
[ -f "$DEPLOY_DIR/$SUBPATH/deployment.yaml" ] \
  || fail "Reloader-annotated deployment.yaml not propagated to deploy branch"
grep -q "reloader.stakater.com/auto" "$DEPLOY_DIR/$SUBPATH/deployment.yaml" \
  || fail "Reloader annotation missing after propagation"
echo "PASS: scopes both actual rosters and preserves all 8 watched candidate members"

RENDERED="$(kubectl kustomize "$(dirname "$OVERLAY")")"
rendered_endpoints="$(yq -N 'select(.kind == "ConfigMap") | .data.COGNI_NODE_ENDPOINTS' <<< "$RENDERED")"
[ "$rendered_endpoints" = "$COMPOSITE" ] || fail "provider endpoint patch is not effective in rendered desired state"
case ",$rendered_endpoints," in
  *",poly=https://poly-test.cognidao.org,"*) : ;;
  *) fail "rendered Poly provider URL was replaced by the base default" ;;
esac
[ "$(yq -N 'select(.kind == "Deployment") | .spec.replicas' <<< "$RENDERED")" = 1 ] || fail "candidate memory footprint override lost"
[ "$(yq -N 'select(.kind == "Deployment") | .spec.paused' <<< "$RENDERED")" = false ] || fail "source must explicitly reconcile an unpaused worker"
[ "$(yq -N 'select(.kind == "Deployment") | .spec.strategy.rollingUpdate.maxSurge' <<< "$RENDERED")" = 0 ] || fail "candidate worker surge remains enabled"
[ "$(yq -N 'select(.kind == "Deployment") | .spec.strategy.rollingUpdate.maxUnavailable' <<< "$RENDERED")" = 1 ] || fail "candidate serial rollout policy changed"
echo "PASS: stale bootstrap topology renders effective provider routing and one-replica serial rollout"

config_checksum() {
  kubectl kustomize "$(dirname "$OVERLAY")" | yq -N \
    'select(.kind == "Deployment") | .spec.template.metadata.annotations."cogni.dev/scheduler-config-sha256"'
}
INITIAL_CHECKSUM="$(config_checksum)"
[[ "$INITIAL_CHECKSUM" =~ ^[0-9a-f]{64}$ ]] || fail "actual composed config has no Podtemplate checksum"
[ "$(yq -N 'select(.kind == "ConfigMap") | .metadata.annotations."reloader.stakater.com/ignore"' <<< "$RENDERED")" = true ] \
  || fail "new ConfigMap update can still reload the old generic-auto Deployment"
for annotation in reloader.stakater.com/auto configmap.reloader.stakater.com/auto; do
  [ "$(yq -N "select(.kind == \"Deployment\") | .metadata.annotations.\"$annotation\"" <<< "$RENDERED")" = false ] \
    || fail "candidate ConfigMap Reloader remains enabled"
done
[ "$(yq -N 'select(.kind == "Deployment") | .metadata.annotations."secret.reloader.stakater.com/auto"' <<< "$RENDERED")" = true ] \
  || fail "Secret rotation lost its existing Reloader transport"
echo "PASS: composed checksum owns config rollout; same-update ignore protects the first transition; Secret reload remains enabled"

# ── 2. Overlay topology heals without changing promoted image identity ────────
grep -q 'externalName: cogni-candidate-a.vm.cognidao.org' "$OVERLAY" \
  || fail "env overlay did not heal from the lane substrate authority"
grep -q 'digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' "$OVERLAY" \
  || fail "env overlay changed the deployed image digest"
[ "$(grep -c 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' "$OVERLAY")" = 2 ] \
  || fail "image digest and observable IMAGE_DIGEST were not restored together"
grep -q 'value: "cccccccccccccccccccccccccccccccccccccccc"' "$OVERLAY" \
  || fail "observable GIT_SHA was not restored from the deploy source-sha map"
! grep -q 'cogni-testing.org' "$OVERLAY" \
  || fail "foreign workload domain remained in the shared substrate overlay"
echo "PASS: substrate topology healed while image identity stayed pinned"

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
git -C "$DEPLOY_DIR" diff --exit-code -- "infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml" || fail "final platform policy was not committed"
[ "$(git -C "$DEPLOY_DIR" show "HEAD:infra/k8s/overlays/candidate-a/scheduler-worker/kustomization.yaml" | yq -N '.replicas[] | select(.name == "scheduler-worker") | .count')" = 1 ] || fail "commit omitted native platform replica transform"

REPLICAS_PATCH=infra/k8s/overlays/candidate-a/scheduler-worker/replicas.patch.yaml
SERIAL_PATCH=infra/k8s/overlays/candidate-a/scheduler-worker/serial-rollout.patch.yaml
cp "$APP_SRC/$REPLICAS_PATCH" "$TMPROOT/replicas-original.yaml"
yq -i '.spec.replicas = 2' "$APP_SRC/$REPLICAS_PATCH"
yq -i '.spec.paused = true | .spec.strategy.rollingUpdate.maxSurge = 1' "$APP_SRC/$SERIAL_PATCH"
run >/dev/null || fail "older reviewed source policy refused"
RENDERED="$(kubectl kustomize "$(dirname "$OVERLAY")")"
[ "$(yq -N 'select(.kind == "Deployment") | .spec.replicas' <<< "$RENDERED")" = 1 ] || fail "stale app restored two workers"
[ "$(yq -N 'select(.kind == "Deployment") | .spec.paused' <<< "$RENDERED")" = false ] || fail "stale app paused worker"
rm "$APP_SRC/$REPLICAS_PATCH" "$APP_SRC/$SERIAL_PATCH"
run >/dev/null || fail "older reviewed source without platform patches refused"
[ "$(kubectl kustomize "$(dirname "$OVERLAY")" | yq -N 'select(.kind == "Deployment") | .spec.replicas')" = 1 ] || fail "missing app patch replaced platform policy"
cp "$TMPROOT/replicas-original.yaml" "$APP_SRC/$REPLICAS_PATCH"
echo "PASS: platform count/startup policy survives stale or absent app patches"

# The digest follows the final composed consumer, not just one routing source.
cp "$APP_SRC/$SUBPATH/configmap.yaml" "$TMPROOT/config-original.yaml"
cp "$APP_SRC/$ENDPOINTS_SUBPATH" "$TMPROOT/reviewed-original.yaml"
cp "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH" "$TMPROOT/watched-original.yaml"
for field in TEMPORAL_NAMESPACE TEMPORAL_ADDRESS; do
  FIELD="$field" yq -i '.data[strenv(FIELD)] = "changed-bootstrap-value"' "$APP_SRC/$SUBPATH/configmap.yaml"
  run >/dev/null || fail "changed bootstrap config refused"
  [ "$(config_checksum)" != "$INITIAL_CHECKSUM" ] || fail "$field absent from effective checksum"
  cp "$TMPROOT/config-original.yaml" "$APP_SRC/$SUBPATH/configmap.yaml"
done
yq -i '.binaryData.STARTUP_HINT = "YmluYXJ5LWNvbmZpZw=="' "$APP_SRC/$SUBPATH/configmap.yaml"
run >/dev/null || fail "binary config refused"
[ "$(config_checksum)" != "$INITIAL_CHECKSUM" ] || fail "binaryData absent from checksum"
cp "$TMPROOT/config-original.yaml" "$APP_SRC/$SUBPATH/configmap.yaml"
yq -i '.data.TEMPORAL_CUSTODIED_NODE_ENDPOINTS = "{\"cogni-preview\":\"foreign=https://foreign.example\"}"' "$APP_SRC/$ENDPOINTS_SUBPATH"
run >/dev/null || fail "custodied config refused"
[ "$(config_checksum)" != "$INITIAL_CHECKSUM" ] || fail "custodied namespace routes absent from checksum"
cp "$TMPROOT/reviewed-original.yaml" "$APP_SRC/$ENDPOINTS_SUBPATH"
for authority in "$APP_SRC" "$AUTHORITY_DIR"; do
  sed -i.bak -e 's#https://poly-test.cognidao.org#https://new-poly.example#g' \
    -e 's#http://brother-node-app:3000#https://new-brother.example#g' "$authority/$ENDPOINTS_SUBPATH"
  run >/dev/null || fail "owned routing update refused"
  [ "$(config_checksum)" != "$INITIAL_CHECKSUM" ] || fail "route authority absent from checksum"
  cp "$TMPROOT/reviewed-original.yaml" "$APP_SRC/$ENDPOINTS_SUBPATH"
  cp "$TMPROOT/watched-original.yaml" "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH"
done
run >/dev/null
[ "$(config_checksum)" = "$INITIAL_CHECKSUM" ] || fail "original effective config digest did not restore"
echo "PASS: actual rendered checksum includes both routing authorities, custody, Temporal bootstrap and binaryData"

python3 - "$APP_SRC/$SUBPATH/configmap.yaml" <<'PY'
import json, subprocess, sys
value = json.loads(subprocess.check_output(["yq", "-o=json", ".", sys.argv[1]]))
value["data"] = dict(reversed(list(value["data"].items())))
open(sys.argv[1], "w").write(json.dumps(value))
PY
run >/dev/null
[ "$(config_checksum)" = "$INITIAL_CHECKSUM" ] || fail "format/key order changed effective checksum"
cp "$TMPROOT/config-original.yaml" "$APP_SRC/$SUBPATH/configmap.yaml"
(
  cd "$DEPLOY_DIR"
  bash "$REPO_ROOT/scripts/ci/promote-k8s-image.sh" --no-commit --env candidate-a --app scheduler-worker \
    --digest ghcr.io/cogni-dao/cogni-template@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd \
    --source-sha eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee >/dev/null
)
run >/dev/null
[ "$(config_checksum)" = "$INITIAL_CHECKSUM" ] || fail "promotion-only GIT_SHA/IMAGE_DIGEST caused checksum drift"
BEFORE_TEMPLATE="$(kubectl kustomize "$(dirname "$OVERLAY")" | yq -o=json -I=0 'select(.kind == "Deployment") | .spec.template')"
yq -i '.data.TEMPORAL_NAMESPACE = "config-only-change"' "$APP_SRC/$SUBPATH/configmap.yaml"
run >/dev/null
AFTER_TEMPLATE="$(kubectl kustomize "$(dirname "$OVERLAY")" | yq -o=json -I=0 'select(.kind == "Deployment") | .spec.template')"
BEFORE_TEMPLATE="$BEFORE_TEMPLATE" AFTER_TEMPLATE="$AFTER_TEMPLATE" python3 - <<'PY' || fail "config update mutated more than the checksum"
import json, os
before, after = (json.loads(os.environ[key]) for key in ("BEFORE_TEMPLATE", "AFTER_TEMPLATE"))
annotation = "cogni.dev/scheduler-config-sha256"
assert before["metadata"]["annotations"].pop(annotation) != after["metadata"]["annotations"].pop(annotation)
assert before == after
PY
cp "$TMPROOT/config-original.yaml" "$APP_SRC/$SUBPATH/configmap.yaml"
echo "PASS: canonical ordering and promotion identities do not churn checksum; config-only change mutates exactly one template annotation"

cp "$APP_SRC/$SUBPATH/deployment.yaml" "$TMPROOT/deployment-original.yaml"
yq -i 'del(.spec.template.spec.containers[0].resources.limits.memory)' "$APP_SRC/$SUBPATH/deployment.yaml"
if run >"$TMPROOT/budget-error" 2>&1; then fail "missing main limit must refuse a fallback startup budget"; fi
grep -q 'explicit main memory limit' "$TMPROOT/budget-error" || fail "wrong missing-main-limit refusal"
cp "$TMPROOT/deployment-original.yaml" "$APP_SRC/$SUBPATH/deployment.yaml"
yq -i '.spec.template.spec.containers[0].envFrom[0].configMapRef.name = "foreign"' "$APP_SRC/$SUBPATH/deployment.yaml"
if run >"$TMPROOT/consumer-error" 2>&1; then fail "unexpected effective config consumer must refuse"; fi
grep -q 'unexpected worker ConfigMap consumer' "$TMPROOT/consumer-error" || fail "wrong unexpected-consumer refusal"
cp "$TMPROOT/deployment-original.yaml" "$APP_SRC/$SUBPATH/deployment.yaml"
echo "PASS: missing main limit and mismatched consumer fail closed before publishing a checksum"

# ── 5. Fail-loud on a missing source ───────────────────────────────────────────
if APP_SOURCE_DIR="$TMPROOT/nope" DEPLOY_BRANCH_DIR="$DEPLOY_DIR" \
   bash "$RECONCILE" candidate-a >/dev/null 2>&1; then
  fail "reconcile should fail-loud when source manifests are absent"
fi
echo "PASS: fail-loud on missing source"

# Missing or duplicate identity is not permission to drop a foreign queue.
mv "$AUTHORITY_DIR/infra/catalog/brother.yaml" "$TMPROOT/brother.yaml"
if run >/dev/null 2>&1; then
  fail "an endpoint without catalog ownership must fail closed"
fi
mv "$TMPROOT/brother.yaml" "$AUTHORITY_DIR/infra/catalog/brother.yaml"
cp "$AUTHORITY_DIR/infra/catalog/ghcr.yaml" "$TMPROOT/ghcr.yaml"
yq -i '.node_id = "9565871a-cb82-444e-ba18-fed9f6ea3ce1"' "$AUTHORITY_DIR/infra/catalog/ghcr.yaml"
if run >/dev/null 2>&1; then
  fail "ambiguous catalog identity must fail closed"
fi
mv "$TMPROOT/ghcr.yaml" "$AUTHORITY_DIR/infra/catalog/ghcr.yaml"
echo "PASS: missing and ambiguous foreign ownership refuse trimming"

mv "$APP_SRC/$ENDPOINTS_SUBPATH" "$TMPROOT/reviewed-provider.yaml"
if run >/dev/null 2>&1; then
  fail "missing reviewed provider map must not fall back to the base map"
fi
mv "$TMPROOT/reviewed-provider.yaml" "$APP_SRC/$ENDPOINTS_SUBPATH"
cp "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH" "$TMPROOT/watched-provider.yaml"
yq -i 'del(.data.COGNI_NODE_ENDPOINTS)' "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH"
if run >/dev/null 2>&1; then
  fail "missing watched provider map must not fall back to the base map"
fi
mv "$TMPROOT/watched-provider.yaml" "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH"
echo "PASS: both authorities require their provider-resolved environment map"

cp "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH" "$TMPROOT/original-watched-provider.yaml"
cp "$AUTHORITY_DIR/$SUBPATH/configmap.yaml" "$TMPROOT/original-watched-base.yaml"
cp "$AUTHORITY_DIR/infra/catalog/operator.yaml" "$TMPROOT/original-watched-operator.yaml"
yq -i '.node_id = "66666666-7777-8888-9999-aaaaaaaaaaaa"' "$AUTHORITY_DIR/infra/catalog/operator.yaml"
sed -i.bak 's/4ff8eac1-4eba-4ed0-931b-b1fe4f64713d/66666666-7777-8888-9999-aaaaaaaaaaaa/g' \
  "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH" "$AUTHORITY_DIR/$SUBPATH/configmap.yaml"
if run >"$TMPROOT/identity-error" 2>&1; then
  fail "same slug and endpoint with different UUIDs must fail closed"
fi
grep -q 'authorities disagree' "$TMPROOT/identity-error" || fail "wrong rejection for cross-authority UUID rebind"
cp "$TMPROOT/original-watched-provider.yaml" "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH"
cp "$TMPROOT/original-watched-base.yaml" "$AUTHORITY_DIR/$SUBPATH/configmap.yaml"
cp "$TMPROOT/original-watched-operator.yaml" "$AUTHORITY_DIR/infra/catalog/operator.yaml"
yq -i '.name = "foreign-operator"' "$AUTHORITY_DIR/infra/catalog/operator.yaml"
sed -i.bak 's#operator=http://operator-node-app:3000#foreign-operator=http://operator-node-app:3000#g' \
  "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH" "$AUTHORITY_DIR/$SUBPATH/configmap.yaml"
if run >"$TMPROOT/identity-error" 2>&1; then
  fail "same UUID and endpoint with different slugs must fail closed"
fi
grep -q 'authorities disagree' "$TMPROOT/identity-error" || fail "wrong rejection for cross-authority slug rebind"
cp "$TMPROOT/original-watched-provider.yaml" "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH"
cp "$TMPROOT/original-watched-base.yaml" "$AUTHORITY_DIR/$SUBPATH/configmap.yaml"
cp "$TMPROOT/original-watched-operator.yaml" "$AUTHORITY_DIR/infra/catalog/operator.yaml"
echo "PASS: same-endpoint cross-authority slug/UUID rebindings refuse"

yq -i '.node_id = "4FF8EAC1-4EBA-4ED0-931B-B1FE4F64713D" | .name = "foreign-operator"' \
  "$AUTHORITY_DIR/infra/catalog/operator.yaml"
sed -i.bak \
  -e 's/4ff8eac1-4eba-4ed0-931b-b1fe4f64713d/4FF8EAC1-4EBA-4ED0-931B-B1FE4F64713D/g' \
  -e 's#operator=http://operator-node-app:3000#foreign-operator=http://operator-node-app:3000#g' \
  "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH" "$AUTHORITY_DIR/$SUBPATH/configmap.yaml"
if run >"$TMPROOT/identity-error" 2>&1; then
  fail "mixed-case semantic UUID under a different slug must fail closed"
fi
grep -q 'missing route authority node identity' "$TMPROOT/identity-error" \
  || fail "noncanonical UUID did not fail at the ownership boundary"
cp "$TMPROOT/original-watched-provider.yaml" "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH"
cp "$TMPROOT/original-watched-base.yaml" "$AUTHORITY_DIR/$SUBPATH/configmap.yaml"
cp "$TMPROOT/original-watched-operator.yaml" "$AUTHORITY_DIR/infra/catalog/operator.yaml"
echo "PASS: mixed-case semantic UUID alias cannot rebind a node"

# ── 6. Conflicting ownership of one alias is never last-writer-wins ──────────
sed -i.bak 's#operator=http://operator-node-app:3000#operator=https://foreign.example#' \
  "$AUTHORITY_DIR/$ENDPOINTS_SUBPATH" "$AUTHORITY_DIR/$SUBPATH/configmap.yaml"
if run >/dev/null 2>&1; then
  fail "conflicting route authorities must fail closed"
fi
echo "PASS: route-authority collision fails closed"

echo "PASS: reconcile-scheduler-worker-routing.test.sh"
