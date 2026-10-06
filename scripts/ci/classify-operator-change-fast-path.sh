#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Classify the single App-authored generated-change envelope.
#
# Both this file and its registry MUST be read from origin/main by the workflow.
# A claimed but malformed envelope is invalid=true (required jobs fail). A
# structurally valid operation that is not enabled stays on ordinary CI. No
# operation is enabled until its verifier has passed the test-org E2E matrix.

set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
REPOSITORY="${REPOSITORY:-${GITHUB_REPOSITORY:-}}"
PR_NUMBER_PR="${PR_NUMBER_PR:-}"
PR_HEAD_SHA_PR="${PR_HEAD_SHA_PR:-}"
OUTPUT_FILE="${GITHUB_OUTPUT:-}"
readonly CHANGE_TYPE='cogni.operator-change.v1'

if [[ -z "$OUTPUT_FILE" ]]; then
  echo "classify-operator-change-fast-path: GITHUB_OUTPUT is required" >&2
  exit 2
fi

emit() { printf '%s=%s\n' "$1" "$2" >> "$OUTPUT_FILE"; }
emit eligible false
emit claimed false
emit invalid false
emit operation none
emit reason full-ci

if [[ "$EVENT_NAME" != pull_request ]]; then
  echo "operator-change fast path: full CI (${EVENT_NAME:-unknown} event)"
  exit 0
fi
if [[ ! "$PR_NUMBER_PR" =~ ^[0-9]+$ ]] || [[ -z "$REPOSITORY" ]]; then
  echo "classify-operator-change-fast-path: invalid repository or PR identity" >&2
  exit 2
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
pr_json="$tmpdir/pr.json"
commit_json="$tmpdir/commit.json"
files_json="$tmpdir/files.json"
registry_json="$tmpdir/registry.json"

fetch_json() {
  local endpoint="$1" fixture_file="$2" destination="$3"
  if [[ -n "$fixture_file" ]]; then cp "$fixture_file" "$destination"; else gh api "$endpoint" > "$destination"; fi
}

fetch_json "repos/$REPOSITORY/pulls/$PR_NUMBER_PR" "${FAST_PATH_PR_JSON:-}" "$pr_json"
head_sha="$(jq -r '.head.sha // empty' "$pr_json")"
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "classify-operator-change-fast-path: PR head SHA is missing" >&2; exit 2; }
fetch_json "repos/$REPOSITORY/commits/$head_sha" "${FAST_PATH_COMMIT_JSON:-}" "$commit_json"

message_file="$tmpdir/message.txt"
jq -r '.commit.message // ""' "$commit_json" > "$message_file"
if ! grep -qxF "Cogni-Change-Type: $CHANGE_TYPE" "$message_file"; then
  echo "operator-change fast path: full CI (reserved envelope not claimed)"
  exit 0
fi
emit claimed true

reject_claim() {
  emit eligible false
  emit invalid true
  emit reason "$1"
  echo "::error::Invalid signed operator-change claim: $1"
  exit 0
}
ordinary_claim() {
  emit eligible false
  emit invalid false
  emit reason "$1"
  echo "operator-change fast path: full CI ($1)"
  exit 0
}
trailer_value() {
  local key="$1" count
  count="$(grep -c "^${key}: " "$message_file" || true)"
  [[ "$count" == 1 ]] || return 1
  sed -n "s/^${key}: //p" "$message_file"
}

if [[ -n "${FAST_PATH_REGISTRY_JSON:-}" ]]; then
  cp "$FAST_PATH_REGISTRY_JSON" "$registry_json"
else
  registry_path='scripts/ci/operator-change-v1.allowlist.json'
  git cat-file -e "origin/main:$registry_path" 2>/dev/null || reject_claim trusted-registry-unavailable
  git show "origin/main:$registry_path" > "$registry_json"
fi
jq -e --arg version "$CHANGE_TYPE" '.version == $version' "$registry_json" >/dev/null || reject_claim invalid-trusted-registry

repository_key="$(printf '%s' "$REPOSITORY" | tr '[:upper:]' '[:lower:]')"
bot_login="$(jq -r --arg repo "$repository_key" '.repositories[$repo].botLogin // empty' "$registry_json")"
bot_id="$(jq -r --arg repo "$repository_key" '.repositories[$repo].botId // empty' "$registry_json")"
[[ -n "$bot_login" && "$bot_id" =~ ^[0-9]+$ ]] || reject_claim untrusted-repository

node="$(trailer_value Cogni-Node)" || reject_claim duplicate-or-missing-node
operation="$(trailer_value Cogni-Operation)" || reject_claim duplicate-or-missing-operation
base_sha="$(trailer_value Cogni-Base-SHA)" || reject_claim duplicate-or-missing-base-sha
change_type="$(trailer_value Cogni-Change-Type)" || reject_claim duplicate-or-missing-change-type
signed_paths_hash="$(trailer_value Cogni-Changed-Paths-SHA256)" || reject_claim duplicate-or-missing-path-hash
emit operation "$operation"

[[ "$change_type" == "$CHANGE_TYPE" ]] || reject_claim invalid-change-type
[[ "$node" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || reject_claim invalid-node
[[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || reject_claim invalid-base-sha
[[ "$signed_paths_hash" =~ ^[0-9a-f]{64}$ ]] || reject_claim invalid-path-hash
jq -e --arg operation "$operation" '.operations[$operation] != null' "$registry_json" >/dev/null || reject_claim unlisted-operation

jq -e \
  --arg login "$bot_login" --argjson bot_id "$bot_id" --arg repo "$REPOSITORY" --arg base_sha "$base_sha" \
  '.state == "open" and .base.ref == "main" and .base.sha == $base_sha
   and .user.login == $login and .user.id == $bot_id and .user.type == "Bot"
   and ((.head.repo.full_name | ascii_downcase) == ($repo | ascii_downcase))
   and .commits == 1' "$pr_json" >/dev/null || reject_claim invalid-pr-identity
jq -e \
  --arg sha "$head_sha" --arg login "$bot_login" --argjson bot_id "$bot_id" --arg base_sha "$base_sha" \
  '.sha == $sha and .author.login == $login and .author.id == $bot_id
   and .commit.verification.verified == true and .commit.verification.reason == "valid"
   and (.parents | length) == 1 and .parents[0].sha == $base_sha' "$commit_json" >/dev/null || reject_claim invalid-commit-signature
[[ "$head_sha" == "$PR_HEAD_SHA_PR" ]] || reject_claim event-head-mismatch

head_ref="$(jq -r '.head.ref // empty' "$pr_json")"
subject="$(sed -n '1p' "$message_file")"
case "$operation" in
  env.membership)
    expected_trailer_count=7
    env_name="$(trailer_value Cogni-Environment)" || reject_claim duplicate-or-missing-environment
    action="$(trailer_value Cogni-Action)" || reject_claim duplicate-or-missing-action
    [[ "$env_name" =~ ^(candidate-a|preview|production)$ && "$action" =~ ^(add|remove)$ ]] || reject_claim invalid-membership-envelope
    [[ "$head_ref" == "cogni-operator/node-env-$node-$env_name" ]] || reject_claim invalid-branch
    if [[ "$action" == add ]]; then
      [[ "$subject" == "feat(node): add $node to $env_name" ]] || reject_claim invalid-subject
    else
      [[ "$subject" == "feat(node): remove $node from $env_name" ]] || reject_claim invalid-subject
    fi
    ;;
  env.placement)
    expected_trailer_count=7
    env_name="$(trailer_value Cogni-Environment)" || reject_claim duplicate-or-missing-environment
    provider="$(trailer_value Cogni-Provider)" || reject_claim duplicate-or-missing-provider
    [[ "$env_name" =~ ^(candidate-a|preview|production)$ && "$provider" =~ ^(k3s|akash)$ ]] || reject_claim invalid-placement-envelope
    [[ "$head_ref" == "cogni-operator/node-placement-$node-$env_name" ]] || reject_claim invalid-branch
    [[ "$subject" == "feat(node): place $node $env_name on $provider" ]] || reject_claim invalid-subject
    ;;
  env.region)
    expected_trailer_count=8
    env_name="$(trailer_value Cogni-Environment)" || reject_claim duplicate-or-missing-environment
    countries="$(trailer_value Cogni-Countries)" || reject_claim duplicate-or-missing-countries
    generation="$(trailer_value Cogni-Lease-Generation)" || reject_claim duplicate-or-missing-lease-generation
    [[ "$env_name" =~ ^(candidate-a|preview|production)$ && "$countries" =~ ^[A-Z]{2}(,[A-Z]{2})*$ && "$generation" =~ ^[0-9]+$ ]] || reject_claim invalid-region-envelope
    [[ "$head_ref" == "cogni-operator/node-region-$node-$env_name" ]] || reject_claim invalid-branch
    rendered_countries="${countries//,/, }"
    [[ "$subject" == "feat(node): require $node $env_name placement in $rendered_countries" ]] || reject_claim invalid-subject
    ;;
  node.register)
    expected_trailer_count=8
    node_id="$(trailer_value Cogni-Node-Id)" || reject_claim duplicate-or-missing-node-id
    source_repo="$(trailer_value Cogni-Source-Repo)" || reject_claim duplicate-or-missing-source-repo
    source_sha="$(trailer_value Cogni-Source-SHA)" || reject_claim duplicate-or-missing-source-sha
    [[ "$node_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ && "$source_sha" =~ ^[0-9a-f]{40}$ ]] || reject_claim invalid-register-envelope
    fleet_owner="${repository_key%%/*}"
    [[ "${source_repo,,}" == "https://github.com/$fleet_owner/$node.git" ]] || reject_claim invalid-source-repo
    [[ "$head_ref" == "cogni-operator/node-register-$node" && "$subject" == "feat(node): register $node" ]] || reject_claim invalid-register-identity
    ;;
  deployment.declare)
    expected_trailer_count=5
    [[ "$head_ref" == "cogni-operator/declare-deployment-$node" ]] || reject_claim invalid-branch
    [[ "$subject" == "feat(deploy): declare $node node deployment" ]] || reject_claim invalid-subject
    ;;
esac
[[ "$(grep -c '^Cogni-' "$message_file")" == "$expected_trailer_count" ]] || reject_claim unexpected-or-duplicate-trailer

if [[ -n "${FAST_PATH_FILES_JSON:-}" ]]; then
  cp "$FAST_PATH_FILES_JSON" "$files_json"
else
  gh api --paginate "repos/$REPOSITORY/pulls/$PR_NUMBER_PR/files" --jq '.[]' | jq -s '.' > "$files_json"
fi
jq -e 'length > 0 and all(.filename | type == "string") and all(.previous_filename == null)
  and all(.status == "added" or .status == "modified" or .status == "removed")' "$files_json" >/dev/null || reject_claim invalid-file-metadata
changed_paths="$tmpdir/changed-paths.txt"
jq -r '.[].filename' "$files_json" | LC_ALL=C sort -u > "$changed_paths"
[[ "$(jq 'length' "$files_json")" == "$(wc -l < "$changed_paths" | tr -d ' ')" ]] || reject_claim duplicate-file
if command -v sha256sum >/dev/null 2>&1; then actual_paths_hash="$(sha256sum "$changed_paths" | awk '{print $1}')"; else actual_paths_hash="$(shasum -a 256 "$changed_paths" | awk '{print $1}')"; fi
[[ "$actual_paths_hash" == "$signed_paths_hash" ]] || reject_claim changed-path-hash-mismatch

enabled="$(jq -r --arg operation "$operation" --arg repo "$repository_key" '.operations[$operation].enabledRepositories | index($repo) != null' "$registry_json")"
[[ "$enabled" == true ]] || ordinary_claim operation-disabled

verifier="$(jq -r --arg operation "$operation" '.operations[$operation].verifier // empty' "$registry_json")"
[[ "$verifier" == scripts/ci/verifiers/*.sh ]] || reject_claim invalid-verifier
trusted_verifier="$tmpdir/verifier.sh"
git show "origin/main:$verifier" > "$trusted_verifier" 2>/dev/null || reject_claim trusted-verifier-unavailable
chmod +x "$trusted_verifier"
OPERATOR_CHANGE_OPERATION="$operation" OPERATOR_CHANGE_NODE="$node" OPERATOR_CHANGE_BASE_SHA="$base_sha" \
OPERATOR_CHANGE_HEAD_SHA="$head_sha" OPERATOR_CHANGE_PATHS_FILE="$changed_paths" \
  "$trusted_verifier" || reject_claim operation-verification-failed

emit eligible true
emit invalid false
emit reason eligible
echo "operator-change fast path: eligible $operation for $node"
