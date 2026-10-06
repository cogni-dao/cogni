#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Fetch and normalize current GitHub facts for the canonical TypeScript
# operator-change classifier. This shell owns no eligibility policy: both CI and
# the deployed operator execute classifyOperatorChangeForMerge from the trusted
# bundle, and that shared classifier invokes the shared byte replay before
# emitting eligible=true.

set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
REPOSITORY="${REPOSITORY:-${GITHUB_REPOSITORY:-}}"
PR_NUMBER_PR="${PR_NUMBER_PR:-}"
PR_HEAD_SHA_PR="${PR_HEAD_SHA_PR:-}"
OUTPUT_FILE="${GITHUB_OUTPUT:-}"
POLICY_ROOT="${FAST_PATH_POLICY_ROOT:-}"

if [[ -z "$OUTPUT_FILE" ]]; then
  echo "classify-operator-change-fast-path: GITHUB_OUTPUT is required" >&2
  exit 2
fi

emit_full_ci() {
  printf '%s\n' \
    'eligible=false' \
    'claimed=false' \
    'invalid=false' \
    'operation=none' \
    'reason=full-ci' >> "$OUTPUT_FILE"
}

if [[ "$EVENT_NAME" != pull_request ]]; then
  emit_full_ci
  echo "operator-change fast path: full CI (${EVENT_NAME:-unknown} event)"
  exit 0
fi
if [[ ! "$PR_NUMBER_PR" =~ ^[0-9]+$ || -z "$REPOSITORY" || ! "$PR_HEAD_SHA_PR" =~ ^[0-9a-f]{40}$ ]]; then
  echo "classify-operator-change-fast-path: invalid repository or PR identity" >&2
  exit 2
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
pr_json="$tmpdir/pr.json"
commit_json="$tmpdir/commit.json"
files_json="$tmpdir/files.json"
registry_json="$tmpdir/registry.json"
trusted_bundle="$tmpdir/operator-change-replay.cjs"

fetch_json() {
  local endpoint="$1" fixture_file="$2" destination="$3"
  if [[ -n "$fixture_file" ]]; then
    cp "$fixture_file" "$destination"
  else
    gh api "$endpoint" > "$destination"
  fi
}

fetch_json "repos/$REPOSITORY/pulls/$PR_NUMBER_PR" "${FAST_PATH_PR_JSON:-}" "$pr_json"
head_sha="$(jq -r '.head.sha // empty' "$pr_json")"
if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "classify-operator-change-fast-path: PR head SHA is missing" >&2
  exit 2
fi
fetch_json "repos/$REPOSITORY/commits/$head_sha" "${FAST_PATH_COMMIT_JSON:-}" "$commit_json"
if [[ -n "${FAST_PATH_FILES_JSON:-}" ]]; then
  cp "$FAST_PATH_FILES_JSON" "$files_json"
else
  gh api --paginate "repos/$REPOSITORY/pulls/$PR_NUMBER_PR/files" --jq '.[]' | jq -s '.' > "$files_json"
fi

registry_path='scripts/ci/operator-change-v1.allowlist.json'
bundle_path='scripts/ci/dist/operator-change-replay.cjs'
if [[ -n "${FAST_PATH_REGISTRY_JSON:-}" ]]; then
  cp "$FAST_PATH_REGISTRY_JSON" "$registry_json"
elif [[ -n "$POLICY_ROOT" ]]; then
  cp "$POLICY_ROOT/$registry_path" "$registry_json"
else
  git show "origin/main:$registry_path" > "$registry_json"
fi
if [[ -n "$POLICY_ROOT" ]]; then
  cp "$POLICY_ROOT/$bundle_path" "$trusted_bundle"
else
  git show "origin/main:$bundle_path" > "$trusted_bundle"
fi

OPERATOR_CHANGE_PR_JSON="$pr_json" \
OPERATOR_CHANGE_COMMIT_JSON="$commit_json" \
OPERATOR_CHANGE_FILES_JSON="$files_json" \
OPERATOR_CHANGE_REGISTRY_JSON="$registry_json" \
REPOSITORY="$REPOSITORY" \
PR_HEAD_SHA_PR="$PR_HEAD_SHA_PR" \
node "$trusted_bundle" classify >> "$OUTPUT_FILE"
