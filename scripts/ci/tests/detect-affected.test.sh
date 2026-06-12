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

printf '%s\n' 'packages/node-contracts/src/foo.ts' > "$tmpdir/changed-paths.txt"

output=$(
  TURBO_BIN="$tmpdir/turbo-stub" \
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/changed-paths.txt" \
  bash scripts/ci/detect-affected.sh
)

echo "$output" | grep -q 'Selection reason: turbo-affected-package-change:packages/node-contracts/src/foo.ts'
echo "$output" | grep -q 'Targets: operator,scheduler-worker'

if echo "$output" | grep -q 'litellm\|oss\|node-template'; then
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

echo "$fallback_output" | grep -q 'Selection reason: shared-package-change:packages/node-contracts/src/foo.ts:turbo-fallback'

expected_fallback_targets=$(
  # shellcheck source=../lib/image-tags.sh
  . scripts/ci/lib/image-tags.sh
  ordered_targets=()
  for target in "${ALL_TARGETS[@]}"; do
    if ! is_built_by_this_repo "$target"; then
      continue
    fi
    ordered_targets+=("$target")
  done
  IFS=,
  printf '%s\n' "${ordered_targets[*]}"
)
echo "$fallback_output" | grep -q "Targets: ${expected_fallback_targets}"

empty_output=$(
  TURBO_BIN="$tmpdir/turbo-empty-stub" \
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/changed-paths.txt" \
  bash scripts/ci/detect-affected.sh
)
echo "$empty_output" | grep -q 'Selection reason: turbo-no-image-targets:packages/node-contracts/src/foo.ts'
echo "$empty_output" | grep -q 'Targets: none'

# Substrate machinery: a change to a per-node provisioning script (not an image
# build input) must select the node set so node-substrate re-runs on candidate-a.
printf '%s\n' 'scripts/ci/reconcile-node-substrate.sh' > "$tmpdir/substrate-paths.txt"
substrate_output=$(
  TURBO_SCM_BASE=origin/main \
  TURBO_SCM_HEAD=HEAD \
  CHANGED_PATHS_FILE="$tmpdir/substrate-paths.txt" \
  bash scripts/ci/detect-affected.sh
)
echo "$substrate_output" | grep -q 'Selection reason: substrate-machinery:scripts/ci/reconcile-node-substrate.sh'

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
echo "$substrate_output" | grep -q "Targets: ${expected_substrate_targets}"
# Substrate-only change must NOT fan to non-node image targets (no no-op rebuilds
# beyond the node set; deploy-infra / litellm etc. stay out).
echo "$substrate_output" | grep -q 'Flight targets:'

echo "detect-affected.test.sh OK"
