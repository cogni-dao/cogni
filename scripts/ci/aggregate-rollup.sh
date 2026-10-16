#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Aggregate per-node deploy branch state into the whole-slot rollup.
# Spec: work/items/task.0376 (CURRENT_SHA_IS_MERGE_BASE,
# ROLLUP_MAP_PRESERVES_UNAFFECTED, AGGREGATOR_CONCURRENCY_GROUP).
#
# Usage: aggregate-rollup.sh <env>   (env ∈ candidate-a, preview, production)
#
# Optional env:
#   ROLLUP_TARGETS_JSON  JSON array of targets selected by the current workflow.
#                        Defaults to ALL_TARGETS only for legacy callers.
#
# Behavior:
#   1. For each resolved target, read origin/deploy/<env>-<node> tip.
#   2. current-sha = git merge-base $(per-node tips). Honest "what's been
#      validated by every node" — release.yml read stays correct.
#   3. Read existing deploy/<env>:.promote-state/source-sha-by-app.json,
#      overwrite affected-node keys from per-node single-entry maps,
#      preserve unaffected entries.
#   4. Push deploy/<env> with rebase-retry (≤5 attempts).
#   5. Write current-sha to /tmp/<env>-current-sha for downstream steps.

set -euo pipefail

ENV="${1:?usage: $0 <env>}"
DEPLOY_BRANCH="deploy/${ENV}"
RETRY_MAX="${RETRY_MAX:-5}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# shellcheck disable=SC1091
. "$repo_root/scripts/ci/lib/image-tags.sh"

REPO_URL="${REPO_URL:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"

work=$(mktemp -d)
# Cleanup must NEVER change the job's exit code. The script cd's into
# "$work/whole" below and git leaves background writers touching .git/objects,
# so a bare `rm -rf "$work"` in the EXIT trap can race and fail
# ("Directory not empty") — which under `set -e` became the job's exit status
# and turned every preview promote RED after the rollup had already succeeded.
# cd out of the temp tree first, and swallow any teardown error (the runner is
# ephemeral and reclaims /tmp regardless).
trap 'cd / && rm -rf "$work" 2>/dev/null || true' EXIT

# --depth=50: rebase-retry on push contention needs enough history to find
# the merge-base of our local commit and origin's advanced tip. depth=1
# would break the retry loop on any concurrent push.
if ! git clone --depth=50 --branch "$DEPLOY_BRANCH" "$REPO_URL" "$work/whole" >/dev/null 2>&1; then
  echo "::error::Cannot clone rollup branch ${DEPLOY_BRANCH}"
  exit 1
fi
cd "$work/whole"
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

if [ -n "${ROLLUP_TARGETS_JSON:-}" ]; then
  mapfile -t rollup_targets < <(printf '%s' "$ROLLUP_TARGETS_JSON" | jq -r '.[]')
else
  rollup_targets=("${ALL_TARGETS[@]}")
fi

if [ "${#rollup_targets[@]}" -eq 0 ]; then
  echo "::error::No rollup targets resolved for ${ENV}"
  exit 1
fi

per_node_shas=()
per_node_branches=()
declare -A per_node_maps=()
for node in "${rollup_targets[@]}"; do
  # Overlay-presence filter (bug.5078): a target with no per-env overlay
  # doesn't deploy to this env, so its per-node branch is not expected
  # to exist. Mirrors promote-and-deploy.yml `Resolve target node list`.
  if [ ! -d "$repo_root/infra/k8s/overlays/${ENV}/${node}" ]; then
    echo "ℹ️  Skipping ${node}: no ${ENV} overlay"
    continue
  fi
  per_branch="deploy/${ENV}-${node}"
  sha=$(git ls-remote "$REPO_URL" "refs/heads/${per_branch}" | cut -f1)
  if [ -z "$sha" ]; then
    echo "::error::Per-node branch ${per_branch} missing on origin"
    exit 1
  fi
  per_node_shas+=("$sha")
  per_node_branches+=("$per_branch")
  if ! git fetch --depth=50 origin "${per_branch}" >/dev/null 2>&1; then
    echo "::error::Cannot fetch per-node branch ${per_branch}"
    exit 1
  fi
  if git cat-file -e "${sha}:.promote-state/source-sha-by-app.json" 2>/dev/null; then
    per_node_maps[$node]=$(git show "${sha}:.promote-state/source-sha-by-app.json")
  fi
done

if [ "${#per_node_shas[@]}" -eq 0 ]; then
  echo "::error::No deploy branch SHAs resolved for ${ENV}"
  exit 1
elif [ "${#per_node_shas[@]}" -eq 1 ]; then
  current_sha="${per_node_shas[0]}"
else
  # Independent deploy branches can have more than 50 promotion commits since
  # their common ancestor. A shallow merge-base exit 1 means missing history,
  # not necessarily unrelated branches. Deepen all selected histories together,
  # boundedly, while keeping the originally observed tips as the rollup inputs.
  deepen_attempt=0
  while true; do
    if current_sha=$(git merge-base "${per_node_shas[@]}"); then
      break
    else
      merge_status=$?
    fi
    if [ "$merge_status" -ne 1 ] || [ "$(git rev-parse --is-shallow-repository)" != true ] || [ "$deepen_attempt" -ge 8 ]; then
      echo "::error::Cannot establish a common ancestor for ${ENV} deployment tips after ${deepen_attempt} history expansions"
      exit 1
    fi
    deepen_attempt=$((deepen_attempt + 1))
    echo "Deepening ${ENV} deployment histories by 200 commits (attempt ${deepen_attempt}/8)"
    if ! git fetch --no-tags --deepen=200 origin "${per_node_branches[@]}" >/dev/null 2>&1; then
      echo "::error::Cannot deepen ${ENV} deployment histories"
      exit 1
    fi
  done
fi
echo "current-sha (merge-base): $current_sha"

mkdir -p .promote-state
echo "$current_sha" > .promote-state/current-sha

existing_map='{}'
if [ -f .promote-state/source-sha-by-app.json ]; then
  existing_map=$(cat .promote-state/source-sha-by-app.json)
fi

merged="$existing_map"
for node in "${!per_node_maps[@]}"; do
  per_node="${per_node_maps[$node]}"
  app_sha=$(printf '%s' "$per_node" | jq -r --arg k "$node" '.[$k] // ""')
  if [ -n "$app_sha" ]; then
    merged=$(printf '%s' "$merged" | jq -c --arg k "$node" --arg v "$app_sha" '. + {($k): $v}')
  fi
done
printf '%s\n' "$merged" | jq . > .promote-state/source-sha-by-app.json

git add -A
if git diff --cached --quiet; then
  echo "✓ Rollup unchanged — nothing to push"
  printf '%s' "$current_sha" > "/tmp/${ENV}-current-sha"
  exit 0
fi
git commit -m "aggregate(${ENV}): current-sha=${current_sha:0:8} via merge-base"

attempt=0
while [ "$attempt" -lt "$RETRY_MAX" ]; do
  attempt=$((attempt + 1))
  if git push origin "HEAD:${DEPLOY_BRANCH}" 2>&1 | tee /tmp/push.out; then
    echo "✓ Pushed on attempt ${attempt}"
    printf '%s' "$current_sha" > "/tmp/${ENV}-current-sha"
    exit 0
  fi
  echo "::warning::push attempt ${attempt} failed; rebasing"
  git fetch origin "$DEPLOY_BRANCH" --depth=10 >/dev/null
  git rebase "origin/${DEPLOY_BRANCH}" || {
    echo "::error::rebase failed — aborting"
    exit 1
  }
done

echo "::error::push exhausted ${RETRY_MAX} attempts on ${DEPLOY_BRANCH}"
exit 1
