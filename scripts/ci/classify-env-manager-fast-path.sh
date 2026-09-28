#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Classify the reserved, operator-authored env-manager PR type.
#
# The fast path is capability-shaped, not title/label-shaped. A PR qualifies only
# when the exact cogni-operator GitHub App bot authored it, GitHub verifies the
# head commit signature, the signed commit trailers describe the change, and the
# PR file list matches both its signed hash and the env-membership boundary.
# Anything that does not claim the reserved type uses normal CI. A malformed
# claim is emitted as claimed=true/eligible=false so required jobs fail closed.

set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
REPOSITORY="${REPOSITORY:-${GITHUB_REPOSITORY:-}}"
PR_NUMBER_PR="${PR_NUMBER_PR:-}"
PR_HEAD_SHA_PR="${PR_HEAD_SHA_PR:-}"
MQ_HEAD_REF="${MQ_HEAD_REF:-}"
MQ_BASE_SHA="${MQ_BASE_SHA:-}"
MQ_HEAD_SHA="${MQ_HEAD_SHA:-}"
OUTPUT_FILE="${GITHUB_OUTPUT:-}"

readonly CHANGE_TYPE='cogni.env-manager.v1'

if [[ -z "$OUTPUT_FILE" ]]; then
  echo "classify-env-manager-fast-path: GITHUB_OUTPUT is required" >&2
  exit 2
fi

emit() {
  printf '%s=%s\n' "$1" "$2" >> "$OUTPUT_FILE"
}

emit eligible false
emit claimed false
emit reason full-ci

case "$EVENT_NAME" in
  pull_request)
    pr_number="$PR_NUMBER_PR"
    ;;
  merge_group)
    mq_leaf="${MQ_HEAD_REF##*/}"
    if [[ "$mq_leaf" =~ ^pr-([0-9]+)- ]]; then
      pr_number="${BASH_REMATCH[1]}"
    else
      echo "classify-env-manager-fast-path: merge-group PR number is not resolvable" >&2
      exit 2
    fi
    ;;
  *)
    echo "env-manager fast path: full CI (${EVENT_NAME:-unknown} event)"
    exit 0
    ;;
esac

if [[ ! "$pr_number" =~ ^[0-9]+$ ]] || [[ -z "$REPOSITORY" ]]; then
  echo "classify-env-manager-fast-path: invalid repository or PR identity" >&2
  exit 2
fi

# App identity is repository-scoped. Production accepts only the production
# installation; the production-shaped E2E repository accepts only its test App.
# Every other repository stays on full CI rather than inheriting either trust.
repository_key="$(printf '%s' "$REPOSITORY" | tr '[:upper:]' '[:lower:]')"
case "$repository_key" in
  cogni-dao/cogni)
    readonly OPERATOR_BOT_LOGIN='cogni-operator[bot]'
    readonly OPERATOR_BOT_ID='265189974'
    ;;
  cogni-test-org/cogni-monorepo)
    readonly OPERATOR_BOT_LOGIN='cogni-operator-test[bot]'
    readonly OPERATOR_BOT_ID='290565426'
    ;;
  *)
    echo "env-manager fast path: full CI (repository has no trusted operator App identity)"
    exit 0
    ;;
esac

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
pr_json="$tmpdir/pr.json"
commit_json="$tmpdir/commit.json"
files_json="$tmpdir/files.json"

fetch_json() {
  local endpoint="$1"
  local fixture_file="$2"
  local destination="$3"
  if [[ -n "$fixture_file" ]]; then
    cp "$fixture_file" "$destination"
  else
    gh api "$endpoint" > "$destination"
  fi
}

fetch_json \
  "repos/$REPOSITORY/pulls/$pr_number" \
  "${FAST_PATH_PR_JSON:-}" \
  "$pr_json"

head_sha="$(jq -r '.head.sha // empty' "$pr_json")"
if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "classify-env-manager-fast-path: PR head SHA is missing" >&2
  exit 2
fi

# Ordinary human/fork PRs need no commit/files API calls and stay on full CI.
# Only the exact operator bot on one of its reserved branch families can claim
# the capability-bearing signed type below.
if ! jq -e \
  --arg login "$OPERATOR_BOT_LOGIN" \
  --argjson bot_id "$OPERATOR_BOT_ID" \
  --arg repo "$REPOSITORY" \
  '.user.login == $login
   and .user.id == $bot_id
   and .user.type == "Bot"
   and ((.head.repo.full_name | ascii_downcase) == ($repo | ascii_downcase))
   and (.head.ref | test("^cogni-operator/node-env-"))' \
  "$pr_json" >/dev/null; then
  echo "env-manager fast path: full CI (not an operator env-manager PR)"
  exit 0
fi

fetch_json \
  "repos/$REPOSITORY/commits/$head_sha" \
  "${FAST_PATH_COMMIT_JSON:-}" \
  "$commit_json"

message_file="$tmpdir/message.txt"
jq -r '.commit.message // ""' "$commit_json" > "$message_file"
if ! grep -qxF "Cogni-Change-Type: $CHANGE_TYPE" "$message_file"; then
  echo "env-manager fast path: full CI (reserved signed type not claimed)"
  exit 0
fi

emit claimed true

reject_claim() {
  local reason="$1"
  emit eligible false
  emit reason "$reason"
  echo "::error::Invalid signed env-manager claim: $reason"
  exit 0
}

trailer_value() {
  local key="$1"
  local count
  count="$(grep -c "^${key}: " "$message_file" || true)"
  [[ "$count" == "1" ]] || return 1
  sed -n "s/^${key}: //p" "$message_file"
}

node="$(trailer_value Cogni-Node)" || reject_claim duplicate-or-missing-node
env_name="$(trailer_value Cogni-Environment)" || reject_claim duplicate-or-missing-environment
action="$(trailer_value Cogni-Action)" || reject_claim duplicate-or-missing-action
change_type="$(trailer_value Cogni-Change-Type)" || reject_claim duplicate-or-missing-change-type
signed_paths_hash="$(trailer_value Cogni-Changed-Paths-SHA256)" || reject_claim duplicate-or-missing-path-hash

[[ "$change_type" == "$CHANGE_TYPE" ]] || reject_claim invalid-change-type
[[ "$node" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || reject_claim invalid-node
[[ "$env_name" =~ ^(candidate-a|preview|production)$ ]] || reject_claim invalid-environment
[[ "$action" =~ ^(add|remove)$ ]] || reject_claim invalid-action
[[ "$signed_paths_hash" =~ ^[0-9a-f]{64}$ ]] || reject_claim invalid-path-hash

jq -e \
  --arg login "$OPERATOR_BOT_LOGIN" \
  --argjson bot_id "$OPERATOR_BOT_ID" \
  --arg repo "$REPOSITORY" \
  '.state == "open"
   and .base.ref == "main"
   and (.base.sha | test("^[0-9a-f]{40}$"))
   and .user.login == $login
   and .user.id == $bot_id
   and .user.type == "Bot"
   and ((.head.repo.full_name | ascii_downcase) == ($repo | ascii_downcase))
   and .commits == 1' "$pr_json" >/dev/null || reject_claim invalid-pr-identity

jq -e \
  --arg sha "$head_sha" \
  --arg login "$OPERATOR_BOT_LOGIN" \
  --argjson bot_id "$OPERATOR_BOT_ID" \
  '.sha == $sha
   and .author.login == $login
   and .author.id == $bot_id
   and .commit.verification.verified == true
   and .commit.verification.reason == "valid"
   and (.parents | length) == 1' "$commit_json" >/dev/null || reject_claim invalid-commit-signature

head_ref="$(jq -r '.head.ref // empty' "$pr_json")"
subject="$(sed -n '1p' "$message_file")"
case "$action" in
  add)
    [[ "$head_ref" == "cogni-operator/node-env-$node-$env_name" ]] || reject_claim invalid-branch
    [[ "$subject" == "feat(node): add $node to $env_name" ]] || reject_claim invalid-subject
    ;;
  remove)
    [[ "$head_ref" == "cogni-operator/node-env-$node-$env_name" ]] || reject_claim invalid-branch
    [[ "$subject" == "feat(node): remove $node from $env_name" ]] || reject_claim invalid-subject
    ;;
esac

if [[ "$EVENT_NAME" == "pull_request" ]]; then
  [[ "$head_sha" == "$PR_HEAD_SHA_PR" ]] || reject_claim event-head-mismatch
  catalog_base_sha="$(jq -r '.base.sha' "$pr_json")"
  catalog_head_sha="$head_sha"
else
  mq_leaf="${MQ_HEAD_REF##*/}"
  # GitHub names the queue ref `pr-<N>-<base_sha>` (live evidence: #2367/#2368),
  # not with the source head SHA. Queue eviction handles a source force-push;
  # below we independently prove the rebased tree's exact path set.
  [[ "$MQ_BASE_SHA" =~ ^[0-9a-f]{40}$ ]] || reject_claim invalid-merge-group-base
  [[ "$mq_leaf" == pr-"$pr_number"-"$MQ_BASE_SHA"* ]] || reject_claim merge-group-base-mismatch
  [[ "$MQ_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || reject_claim invalid-merge-group-head
  catalog_base_sha="$MQ_BASE_SHA"
  catalog_head_sha="$MQ_HEAD_SHA"
fi

if [[ -n "${FAST_PATH_FILES_JSON:-}" ]]; then
  cp "$FAST_PATH_FILES_JSON" "$files_json"
else
  gh api --paginate "repos/$REPOSITORY/pulls/$pr_number/files" --jq '.[]' | jq -s '.' > "$files_json"
fi

jq -e 'length > 0 and length <= 6
  and all(.filename | type == "string")
  and all(.previous_filename == null)
  and all(.status == "added" or .status == "modified" or .status == "removed")' \
  "$files_json" >/dev/null || reject_claim invalid-file-metadata

changed_paths="$tmpdir/changed-paths.txt"
jq -r '.[].filename' "$files_json" | LC_ALL=C sort -u > "$changed_paths"
file_count="$(jq 'length' "$files_json")"
unique_count="$(wc -l < "$changed_paths" | tr -d ' ')"
[[ "$file_count" == "$unique_count" ]] || reject_claim duplicate-file

if command -v sha256sum >/dev/null 2>&1; then
  actual_paths_hash="$(sha256sum "$changed_paths" | awk '{print $1}')"
else
  actual_paths_hash="$(shasum -a 256 "$changed_paths" | awk '{print $1}')"
fi
[[ "$actual_paths_hash" == "$signed_paths_hash" ]] || reject_claim changed-path-hash-mismatch

base_catalog_yaml="$tmpdir/base-catalog.yaml"
head_catalog_yaml="$tmpdir/head-catalog.yaml"
base_catalog_json="$tmpdir/base-catalog.json"
head_catalog_json="$tmpdir/head-catalog.json"

load_catalog() {
  local sha="$1"
  local fixture_file="$2"
  local destination="$3"
  if [[ -n "$fixture_file" ]]; then
    cp "$fixture_file" "$destination"
  elif ! git show "$sha:infra/catalog/$node.yaml" > "$destination"; then
    return 1
  fi
}

load_catalog "$catalog_base_sha" "${FAST_PATH_BASE_CATALOG:-}" "$base_catalog_yaml" \
  || reject_claim missing-base-catalog
load_catalog "$catalog_head_sha" "${FAST_PATH_HEAD_CATALOG:-}" "$head_catalog_yaml" \
  || reject_claim missing-head-catalog

if ! yq -o=json '.' "$base_catalog_yaml" > "$base_catalog_json" 2>/dev/null \
  || ! yq -o=json '.' "$head_catalog_yaml" > "$head_catalog_json" 2>/dev/null; then
  reject_claim invalid-catalog-yaml
fi

# APPSET_PATH_IS_CONTROL_ENV_SCOPED: ask the one shared resolver where this
# workload lane's AppSet lives. For an Akash non-production lane that is the
# production control cluster, not the workload environment named in the file.
# Load the trusted main-branch definition; it reads the candidate tree's catalog.
resolver_catalog_dir="$tmpdir/resolver-catalog"
mkdir -p "$resolver_catalog_dir"
if [[ "$action" == "remove" ]]; then
  cp "$base_catalog_yaml" "$resolver_catalog_dir/$node.yaml"
else
  cp "$head_catalog_yaml" "$resolver_catalog_dir/$node.yaml"
fi
export CATALOG_DIR="$resolver_catalog_dir"
if [[ -n "${FAST_PATH_APPSET_PATHS_LIB:-}" ]]; then
  # Hermetic test seam; CI never sets this.
  # shellcheck disable=SC1090
  source "$FAST_PATH_APPSET_PATHS_LIB"
else
  # shellcheck disable=SC1090
  source <(git show origin/main:scripts/ci/lib/appset-paths.sh)
fi
expected_appset="$(appset_rel_path "$env_name" "$node")"
expected_appsets_kustomization="$(appsets_kustomization_rel_path "$env_name" "$node")"

catalog_seen=false
appset_seen=false
appset_kustomization_seen=false
while IFS= read -r changed_file; do
  case "$changed_file" in
    "infra/catalog/$node.yaml")
      catalog_seen=true
      ;;
    "infra/k8s/overlays/$env_name/scheduler-worker/node-endpoints.patch.yaml")
      ;;
    "infra/k8s/overlays/$env_name/$node/kustomization.yaml"|\
    "infra/k8s/overlays/$env_name/$node/external-secret.yaml")
      ;;
    "$expected_appset")
      appset_seen=true
      ;;
    "$expected_appsets_kustomization")
      appset_kustomization_seen=true
      ;;
    *)
      reject_claim path-outside-env-manager-boundary
      ;;
  esac
done < "$changed_paths"

[[ "$catalog_seen" == true ]] || reject_claim catalog-not-changed
[[ "$appset_seen" == true && "$appset_kustomization_seen" == true ]] || reject_claim incomplete-membership-change

# SIGNED_TYPE_HAS_EXACT_SEMANTICS: the App signature proves WHO authored the
# tree, not that this capability touched only the catalog cells it names. Prove
# the effective base -> head catalog mutation is exactly one membership change.
# On merge_group we inspect the queued tree, not the stale PR tree, so a rebase
# onto a concurrently changed catalog cannot inherit the fast path by accident.
if ! jq -en \
  --arg node "$node" \
  --arg env "$env_name" \
  --arg action "$action" \
  --slurpfile base "$base_catalog_json" \
  --slurpfile head "$head_catalog_json" '
    def env_rank:
      if . == "candidate-a" then 0
      elif . == "preview" then 1
      elif . == "production" then 2
      else 99 end;
    def canonical_envs:
      type == "array"
      and length > 0
      and all(.[]; type == "string" and test("^(candidate-a|preview|production)$"))
      and (length == (unique | length))
      and (. == (sort_by(env_rank)));
    def without_target_cells:
      del(.envs, .activity_env)
      | del(.deployment_provider[$env], .compute_api[$env], .lease_generation[$env])
      | if .deployment_provider == {} then del(.deployment_provider) else . end
      | if .compute_api == {} then del(.compute_api) else . end
      | if .lease_generation == {} then del(.lease_generation) else . end;
    ($base[0]) as $b
    | ($head[0]) as $h
    | ($b | type == "object" and .name == $node and (.envs | canonical_envs))
      and ($h | type == "object" and .name == $node and (.envs | canonical_envs))
      and (($b | without_target_cells) == ($h | without_target_cells))
      and (if $action == "add" then
        (($b.envs | index($env)) == null)
        and (($h.envs | index($env)) != null)
        and ($h.envs == (($b.envs + [$env]) | sort_by(env_rank)))
        and ($h.activity_env == ($h.envs | last))
        and (if (($h.source_repo // "") | type == "string" and length > 0) then
          (($b.deployment_provider // {}) | has($env) | not)
          and (($b.compute_api // {}) | has($env) | not)
          and (($b.lease_generation // {}) | has($env) | not)
          and $h.deployment_provider[$env] == "akash"
          and $h.compute_api[$env] == "crossplane"
          and ($h.lease_generation[$env] | type == "number" and . >= 0 and floor == .)
        else
          (($b.deployment_provider // {}) | has($env) | not)
          and (($b.compute_api // {}) | has($env) | not)
          and (($b.lease_generation // {}) | has($env) | not)
          and (($h.deployment_provider // {}) | has($env) | not)
          and (($h.compute_api // {}) | has($env) | not)
          and (($h.lease_generation // {}) | has($env) | not)
        end)
      else
        (($b.envs | index($env)) != null)
        and (($h.envs | index($env)) == null)
        and ($h.envs == ($b.envs | map(select(. != $env))))
        and $b.activity_env != $env
        and $h.activity_env == $b.activity_env
        and (($h.deployment_provider // {}) | has($env) | not)
        and (($h.compute_api // {}) | has($env) | not)
        and (($h.lease_generation // {}) | has($env) | not)
      end)
  ' >/dev/null; then
  reject_claim invalid-catalog-delta
fi

# A queue candidate must contain exactly this PR's path set. This catches a
# multi-PR batch and any stale shared-file rewrite before heavy CI is skipped.
if [[ "$EVENT_NAME" == "merge_group" ]]; then
  [[ "$MQ_BASE_SHA" =~ ^[0-9a-f]{40}$ && "$MQ_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || reject_claim invalid-merge-group-shas
  queue_paths="$tmpdir/queue-paths.txt"
  git diff --name-only --no-renames "$MQ_BASE_SHA" "$MQ_HEAD_SHA" | LC_ALL=C sort -u > "$queue_paths"
  cmp -s "$changed_paths" "$queue_paths" || reject_claim merge-group-path-mismatch
fi

emit eligible true
emit reason verified-signed-env-manager-change
emit node "$node"
emit environment "$env_name"
emit action "$action"
echo "env-manager fast path: eligible $action $node/$env_name"
