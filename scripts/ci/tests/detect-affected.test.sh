#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

cat > "$tmpdir/turbo-stub" <<'SH'
#!/usr/bin/env bash
cat <<'JSON'
{"packages":["//","operator","@cogni/scheduler-worker-service"]}
JSON
SH
chmod +x "$tmpdir/turbo-stub"

cat > "$tmpdir/turbo-invalid-json-stub" <<'SH'
#!/usr/bin/env bash
printf '%s\n' 'not-json'
SH
chmod +x "$tmpdir/turbo-invalid-json-stub"

cat > "$tmpdir/turbo-empty-stub" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"packages":[]}'
SH
chmod +x "$tmpdir/turbo-empty-stub"

# bug.5521: worked catalog examples distinguish repository-wide inputs from
# independent Docker contexts. A root-context infra image must still rebuild;
# a remote-source image must never become this repository's build obligation.
fixture="$tmpdir/contexts"
mkdir -p "$fixture/infra/catalog" "$fixture/infra/images/isolated"
cat > "$fixture/infra/catalog/app.yaml" <<'YAML'
name: app
type: node
path_prefix: nodes/app/
YAML
cat > "$fixture/infra/catalog/foreign.yaml" <<'YAML'
name: foreign
type: node
path_prefix: nodes/foreign/
source_repo: other-owner/unrelated
YAML
cat > "$fixture/infra/catalog/isolated.yaml" <<'YAML'
name: isolated
type: infra
path_prefix: infra/images/isolated/
build_context: infra/images/isolated
YAML
cat > "$fixture/infra/catalog/root-infra.yaml" <<'YAML'
name: root-infra
type: infra
path_prefix: infra/images/root-infra/
build_context: ./
YAML
cat > "$fixture/infra/catalog/worker.yaml" <<'YAML'
name: worker
type: service
path_prefix: services/worker/
YAML

assert_context_targets() {
  local expected="$1" output
  shift
  printf '%s\n' "$@" > "$tmpdir/context-paths.txt"
  : > "$tmpdir/context-output.txt"
  output=$(
    COGNI_CATALOG_ROOT="$fixture/infra/catalog" \
    GITHUB_REPOSITORY=cogni-dao/cogni \
    TURBO_BIN="$tmpdir/turbo-invalid-json-stub" \
    GITHUB_OUTPUT="$tmpdir/context-output.txt" \
    CHANGED_PATHS_FILE="$tmpdir/context-paths.txt" \
    bash scripts/ci/detect-affected.sh
  )
  if ! grep -qx "Targets: $expected" <<< "$output"; then
    printf '[FAIL] paths %s: expected %s\n%s\n' "$*" "$expected" "$output" >&2
    exit 1
  fi
  python3 - "$tmpdir/context-output.txt" "$expected" <<'PY'
import json
import sys

with open(sys.argv[1]) as output:
    fields = dict(line.rstrip("\n").split("=", 1) for line in output)
assert fields["targets"] == sys.argv[2], fields
assert json.loads(fields["targets_json"]) == sys.argv[2].split(","), fields
PY
}

for workspace_path in package.json pnpm-workspace.yaml turbo.json tsconfig.json \
  tsconfig.base.json tsconfig.app.json tsconfig.scripts.json config/build.ts \
  .dockerignore pnpm-lock.yaml packages/shared/src/example.ts; do
  assert_context_targets 'app,root-infra,worker' "$workspace_path"
done

# Scoped expansion must union, rather than stop scanning a mixed PR. Lockfile
# deferral is consumed only by a locally built repository-context owner.
for workspace_path in package.json pnpm-lock.yaml packages/shared/src/example.ts; do
  assert_context_targets 'app,isolated,root-infra,worker' \
    "$workspace_path" infra/images/isolated/Dockerfile
  assert_context_targets 'app,isolated,root-infra,worker' \
    infra/images/isolated/Dockerfile "$workspace_path"
done
assert_context_targets 'app,isolated,root-infra,worker' \
  infra/catalog/isolated.yaml pnpm-lock.yaml
assert_context_targets 'app,root-infra,worker' nodes/foreign/src/example.ts pnpm-lock.yaml
assert_context_targets 'app' nodes/app/src/example.ts pnpm-lock.yaml
assert_context_targets 'isolated' infra/images/isolated/Dockerfile
assert_context_targets 'isolated' infra/catalog/isolated.yaml

# Equivalent root spellings and a symlink alias cannot create false negatives.
ln -s "$fixture" "$fixture/root-alias"
for context in './' 'infra/..' 'root-alias' '..'; do
  BUILD_CONTEXT="$context" yq -i '.build_context = strenv(BUILD_CONTEXT)' \
    "$fixture/infra/catalog/root-infra.yaml"
  assert_context_targets 'app,root-infra,worker' package.json
done

# Actual shared build machinery remains conservative across every context.
for machinery_path in scripts/ci/build-and-push-images.sh scripts/ci/detect-affected.sh \
  scripts/ci/lib/image-tags.sh scripts/ci/write-build-manifest.sh \
  .github/workflows/pr-build.yml; do
  assert_context_targets 'app,isolated,root-infra,worker' "$machinery_path"
done

# Explicit full scope still includes independent contexts. Use a disposable
# main checkout so the caller's branch/upstream cannot influence this control.
git -c init.defaultBranch=main init --quiet "$fixture"
full_output=$(
  cd "$fixture"
  COGNI_CATALOG_ROOT="$fixture/infra/catalog" GITHUB_REPOSITORY=cogni-dao/cogni \
    env -u CHANGED_PATHS_FILE -u TURBO_SCM_BASE -u TURBO_SCM_HEAD \
    bash "$ROOT/scripts/ci/detect-affected.sh"
)
grep -qx 'Image build scope: full' <<< "$full_output"
grep -qx 'Targets: app,isolated,root-infra,worker' <<< "$full_output"

printf '%s\n' 'packages/node-contracts/src/foo.ts' > "$tmpdir/changed-paths.txt"

output=$(
  TURBO_BIN="$tmpdir/turbo-stub" \
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/changed-paths.txt" \
  bash scripts/ci/detect-affected.sh
)

grep -q 'Selection reason: turbo-affected-package-change:packages/node-contracts/src/foo.ts' <<< "$output"
grep -q 'Targets: operator,scheduler-worker' <<< "$output"

if grep -q 'litellm\|oss\|node-template' <<< "$output"; then
  echo "[FAIL] package-level turbo affected selected packages absent from turbo output" >&2
  echo "$output" >&2
  exit 1
fi

fallback_output=$(
  TURBO_BIN="$tmpdir/turbo-invalid-json-stub" \
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/changed-paths.txt" \
  bash scripts/ci/detect-affected.sh 2>&1
)

grep -q 'Selection reason: shared-package-change:packages/node-contracts/src/foo.ts:turbo-fallback' <<< "$fallback_output"

expected_fallback_targets=$(
  # shellcheck source=../lib/image-tags.sh
  . scripts/ci/lib/image-tags.sh
  ordered_targets=()
  for target in "${ALL_TARGETS[@]}"; do
    if ! is_built_by_this_repo "$target"; then
      continue
    fi
    [ "$(yq -N '.build_context // "."' "${_image_tags_catalog_root}/${target}.yaml")" = '.' ] || continue
    ordered_targets+=("$target")
  done
  IFS=,
  printf '%s\n' "${ordered_targets[*]}"
)
grep -q "Targets: ${expected_fallback_targets}" <<< "$fallback_output"

empty_output=$(
  TURBO_BIN="$tmpdir/turbo-empty-stub" \
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/changed-paths.txt" \
  bash scripts/ci/detect-affected.sh
)
grep -q 'Selection reason: turbo-no-image-targets:packages/node-contracts/src/foo.ts' <<< "$empty_output"
grep -q 'Targets: none' <<< "$empty_output"

# Substrate machinery: a change to a per-node provisioning script (not an image
# build input) must select the node set so node-substrate re-runs on candidate-a.
printf '%s\n' 'scripts/ci/reconcile-node-substrate.sh' > "$tmpdir/substrate-paths.txt"
substrate_output=$(
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/substrate-paths.txt" \
  bash scripts/ci/detect-affected.sh
)
grep -q 'Selection reason: substrate-machinery:scripts/ci/reconcile-node-substrate.sh' <<< "$substrate_output"

expected_substrate_targets=$(
  # shellcheck source=../lib/image-tags.sh
  . scripts/ci/lib/image-tags.sh
  declare -A is_node=()
  for node in "${NODE_TARGETS[@]}"; do is_node["$node"]=1; done
  ordered_targets=()
  for target in "${ALL_TARGETS[@]}"; do
    [ -n "${is_node[$target]:-}" ] || continue
    is_built_by_this_repo "$target" || continue
    ordered_targets+=("$target")
  done
  IFS=,
  printf '%s\n' "${ordered_targets[*]}"
)
grep -q "Targets: ${expected_substrate_targets}" <<< "$substrate_output"
# Substrate-only change must NOT fan to non-node image targets (no no-op rebuilds
# beyond the node set; deploy-infra / litellm etc. stay out).
grep -q 'Flight targets:' <<< "$substrate_output"

# Edge Caddy reconcile is substrate behavior too: the script mutates VM edge
# routing during node-substrate, so a change must not produce a no-op flight.
printf '%s\n' 'scripts/ci/reconcile-edge-caddy.remote.sh' > "$tmpdir/edge-caddy-paths.txt"
edge_caddy_output=$(
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/edge-caddy-paths.txt" \
  bash scripts/ci/detect-affected.sh
)
grep -q 'Selection reason: substrate-machinery:scripts/ci/reconcile-edge-caddy.remote.sh' <<< "$edge_caddy_output"
grep -q "Targets: ${expected_substrate_targets}" <<< "$edge_caddy_output"

# bug.5299 — the substrate PREFLIGHT ASSERTER and the libs it sources are substrate
# machinery too. A change to them that selects no target ships with the gate never having
# executed once on a flight, which is precisely how a broken or inverted assertion stays
# invisible. Both the asserter and lane-db-residency.sh must select the node set.
for asserter_path in \
  scripts/ci/assert-target-substrate.sh \
  scripts/ci/lib/lane-db-residency.sh; do
  printf '%s\n' "$asserter_path" > "$tmpdir/asserter-paths.txt"
  asserter_output=$(
    TURBO_SCM_BASE=origin/main \
    TURBO_SCM_HEAD=HEAD \
    CHANGED_PATHS_FILE="$tmpdir/asserter-paths.txt" \
    bash scripts/ci/detect-affected.sh
  )
  grep -q "Selection reason: substrate-machinery:${asserter_path}" <<< "$asserter_output"
  grep -q "Targets: ${expected_substrate_targets}" <<< "$asserter_output"
done

# NEGATIVE CONTROL — the rule is an explicit list, not a scripts/ci/** prefix. An unrelated
# CI script must stay out, or "substrate machinery" would mean "any script" and the node set
# would be rebuilt on every CI edit.
printf '%s\n' 'scripts/ci/verify-buildsha.sh' > "$tmpdir/unrelated-paths.txt"
unrelated_output=$(
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/unrelated-paths.txt" \
  bash scripts/ci/detect-affected.sh
)
if grep -q 'Selection reason: substrate-machinery:' <<< "$unrelated_output"; then
  echo "[FAIL] unrelated CI script classified as substrate machinery" >&2
  echo "$unrelated_output" >&2
  exit 1
fi

# The compute-workload controller is deployed by the operator image. A
# controller-manifest-only change must therefore build exactly operator at the
# same source SHA; otherwise candidate flight would pair new manifests with an
# older image or fail because the exact sha-* artifact does not exist.
printf '%s\n' 'infra/k8s/base/compute-workload-controller/rbac.yaml' > "$tmpdir/controller-paths.txt"
controller_output=$(
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/controller-paths.txt" \
  bash scripts/ci/detect-affected.sh
)
grep -q 'Selection reason: operator-image-input:infra/k8s/base/compute-workload-controller/rbac.yaml' <<< "$controller_output"
grep -q '^Targets: operator$' <<< "$controller_output"
grep -q '^Flight targets: operator$' <<< "$controller_output"


# task.5102 — same coupling for the Akash transaction actuator: it is a second process
# artifact inside the SAME operator image, so a manifest-only change must build operator
# at that source SHA rather than flight new manifests against an older artifact.
printf '%s\n' 'infra/k8s/base/akash-tx-actuator/deployment.yaml' > "$tmpdir/actuator-paths.txt"
actuator_output=$(
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/actuator-paths.txt" \
  bash scripts/ci/detect-affected.sh
)
grep -q 'Selection reason: operator-image-input:infra/k8s/base/akash-tx-actuator/deployment.yaml' <<< "$actuator_output"
grep -q '^Targets: operator$' <<< "$actuator_output"
grep -q '^Flight targets: operator$' <<< "$actuator_output"

echo "detect-affected.test.sh OK"
