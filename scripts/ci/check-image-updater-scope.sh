#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# bug.0344 / task.0349 — structural guardrail on image-updater scope.
#
# After task.0349, **no** ApplicationSet under infra/k8s/argocd may carry
# argocd-image-updater.argoproj.io annotations: preview digest promotion is
# CI-owned; candidate-a and production never used Image Updater write-back here.
#
# ALLOWLIST may be repopulated in a future PR that re-introduces updater-backed
# envs with an explicit work item and invariant — until then, the list is
# empty and every *-applicationset.yaml must be annotation-free.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APPSET_DIR="$ROOT_DIR/infra/k8s/argocd/appsets"

# Files permitted to carry argocd-image-updater annotations (empty = none).
ALLOWLIST=()

# Every ApplicationSet file in the tree. The AppSets now live in PER-ENV subdirs
# (appsets/<env>/<env>-<node>-applicationset.yaml, story.5020), so scan RECURSIVELY
# with find rather than a flat glob. NUL-delimited to survive any path quirk.
all_appsets=()
while IFS= read -r -d '' f; do
  all_appsets+=("$f")
done < <(find "$APPSET_DIR" -type f -name '*-applicationset.yaml' -print0 | sort -z)

if [[ ${#all_appsets[@]} -eq 0 ]]; then
  echo "::error::bug.0344 image-updater-scope check: no *-applicationset.yaml files under $APPSET_DIR" >&2
  exit 1
fi

is_allowed() {
  local rel="$1" allowed
  for allowed in "${ALLOWLIST[@]}"; do
    [[ "$rel" == "$allowed" ]] && return 0
  done
  return 1
}

fail=0
for target in "${all_appsets[@]}"; do
  rel="${target#"$ROOT_DIR"/}"

  has_annotation=0
  matches=""
  if matches=$(grep -n 'argocd-image-updater.argoproj.io' "$target"); then
    has_annotation=1
  fi

  # When ALLOWLIST is empty (task.0349), is_allowed is always false — every
  # AppSet must be annotation-free. The branch below only runs when the
  # allowlist is repopulated.
  if is_allowed "$rel"; then
    # Allowed files MUST carry annotations — an empty allowlisted file
    # is suspicious (design intent silently lost). Warn, but don't fail;
    # a design-intent loss that fails closed here would block legitimate
    # rollback PRs.
    if [[ $has_annotation -eq 0 ]]; then
      echo "::warning file=${rel}::bug.0344 image-updater-scope: ${rel} is on the allowlist but carries NO argocd-image-updater annotations. If this is a deliberate descoping, update ALLOWLIST in scripts/ci/check-image-updater-scope.sh." >&2
    fi
    continue
  fi

  if [[ $has_annotation -eq 1 ]]; then
    echo "::error file=${rel}::bug.0344 image-updater-scope: ${rel} is NOT on the image-updater allowlist and must carry zero argocd-image-updater.argoproj.io/* annotations. Adding a new env to the allowlist is a design decision — update ALLOWLIST in scripts/ci/check-image-updater-scope.sh with a rationale commit, don't silently annotate." >&2
    echo "" >&2
    echo "Offending lines in ${rel}:" >&2
    printf '%s\n' "$matches" >&2
    fail=1
  fi
done

if [[ $fail -eq 1 ]]; then
  exit 1
fi

# Friendly summary on success.
echo "bug.0344 image-updater-scope check OK:"
echo "  allowlist (${#ALLOWLIST[@]} file(s)): ${ALLOWLIST[*]}"
echo "  scanned $(printf '%s\n' "${all_appsets[@]}" | wc -l | tr -d ' ') *-applicationset.yaml file(s) under infra/k8s/argocd/"
