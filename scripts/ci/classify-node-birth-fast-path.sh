#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Classify the reserved, operator-App-authored cogni.node-birth.v1 PR type.
#
# App signature proves who authored the tree, not that the tree is correct. The
# trusted main-branch copy of this classifier binds the exact App identity,
# commit/base/head, canonical envelope, data-only path plan, and birth catalog
# semantics. Generated overlay/AppSet bytes are replayed by the classifier job.

set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
REPOSITORY="${REPOSITORY:-${GITHUB_REPOSITORY:-}}"
PR_NUMBER_PR="${PR_NUMBER_PR:-}"
PR_HEAD_SHA_PR="${PR_HEAD_SHA_PR:-}"
MQ_HEAD_REF="${MQ_HEAD_REF:-}"
OUTPUT_FILE="${GITHUB_OUTPUT:-}"
readonly CHANGE_TYPE='cogni.node-birth.v1'

if [[ -z "$OUTPUT_FILE" ]]; then
  echo "classify-node-birth-fast-path: GITHUB_OUTPUT is required" >&2
  exit 2
fi

emit() { printf '%s=%s\n' "$1" "$2" >> "$OUTPUT_FILE"; }
emit eligible false
emit claimed false
emit reason full-ci

case "$EVENT_NAME" in
  pull_request) pr_number="$PR_NUMBER_PR" ;;
  merge_group)
    mq_leaf="${MQ_HEAD_REF##*/}"
    if [[ "$mq_leaf" =~ ^pr-([0-9]+)- ]]; then
      pr_number="${BASH_REMATCH[1]}"
    else
      echo "classify-node-birth-fast-path: merge-group PR number is not resolvable" >&2
      exit 2
    fi
    ;;
  *)
    echo "node-birth fast path: full CI (${EVENT_NAME:-unknown} event)"
    exit 0
    ;;
esac

if [[ ! "$pr_number" =~ ^[0-9]+$ ]] || [[ -z "$REPOSITORY" ]]; then
  echo "classify-node-birth-fast-path: invalid repository or PR identity" >&2
  exit 2
fi

repository_key="$(printf '%s' "$REPOSITORY" | tr '[:upper:]' '[:lower:]')"
case "$repository_key" in
  cogni-dao/cogni)
    readonly OPERATOR_BOT_LOGIN='cogni-operator[bot]'
    readonly OPERATOR_BOT_ID='265189974'
    readonly FLEET_ORG='cogni-dao'
    ;;
  cogni-test-org/cogni-monorepo)
    readonly OPERATOR_BOT_LOGIN='cogni-operator-test[bot]'
    readonly OPERATOR_BOT_ID='290565426'
    readonly FLEET_ORG='cogni-test-org'
    ;;
  *)
    echo "node-birth fast path: full CI (repository has no trusted operator App identity)"
    exit 0
    ;;
esac

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
pr_json="$tmpdir/pr.json"
commit_json="$tmpdir/commit.json"
files_json="$tmpdir/files.json"

fetch_json() {
  local endpoint="$1" fixture_file="$2" destination="$3"
  if [[ -n "$fixture_file" ]]; then
    cp "$fixture_file" "$destination"
  else
    gh api "$endpoint" > "$destination"
  fi
}

fetch_json "repos/$REPOSITORY/pulls/$pr_number" "${FAST_PATH_PR_JSON:-}" "$pr_json"
head_sha="$(jq -r '.head.sha // empty' "$pr_json")"
if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "classify-node-birth-fast-path: PR head SHA is missing" >&2
  exit 2
fi

# Ordinary and human-edited PRs stay on full CI without additional API calls.
if ! jq -e \
  --arg login "$OPERATOR_BOT_LOGIN" \
  --argjson bot_id "$OPERATOR_BOT_ID" \
  --arg repo "$REPOSITORY" \
  '.user.login == $login
   and .user.id == $bot_id
   and .user.type == "Bot"
   and ((.head.repo.full_name | ascii_downcase) == ($repo | ascii_downcase))
   and (.head.ref | test("^cogni-operator/node-register-"))' \
  "$pr_json" >/dev/null; then
  echo "node-birth fast path: full CI (not an operator node-birth PR)"
  exit 0
fi

fetch_json "repos/$REPOSITORY/commits/$head_sha" "${FAST_PATH_COMMIT_JSON:-}" "$commit_json"
message_file="$tmpdir/message.txt"
jq -r '.commit.message // ""' "$commit_json" > "$message_file"
if ! grep -qxF "Cogni-Change-Type: $CHANGE_TYPE" "$message_file"; then
  echo "node-birth fast path: full CI (reserved signed type not claimed)"
  exit 0
fi
emit claimed true

reject_claim() {
  local reason="$1"
  emit eligible false
  emit reason "$reason"
  echo "::error::Invalid signed node-birth claim: $reason"
  exit 0
}

trailer_value() {
  local key="$1" count
  count="$(grep -c "^${key}: " "$message_file" || true)"
  [[ "$count" == 1 ]] || return 1
  sed -n "s/^${key}: //p" "$message_file"
}

node="$(trailer_value Cogni-Node)" || reject_claim duplicate-or-missing-node
node_id="$(trailer_value Cogni-Node-Id)" || reject_claim duplicate-or-missing-node-id
source_repo="$(trailer_value Cogni-Source-Repo)" || reject_claim duplicate-or-missing-source-repo
source_sha="$(trailer_value Cogni-Source-SHA)" || reject_claim duplicate-or-missing-source-sha
base_sha="$(trailer_value Cogni-Base-SHA)" || reject_claim duplicate-or-missing-base-sha
change_type="$(trailer_value Cogni-Change-Type)" || reject_claim duplicate-or-missing-change-type
signed_paths_hash="$(trailer_value Cogni-Changed-Paths-SHA256)" || reject_claim duplicate-or-missing-path-hash

[[ "$change_type" == "$CHANGE_TYPE" ]] || reject_claim invalid-change-type
[[ "$node" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || reject_claim invalid-node
[[ "$node_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || reject_claim invalid-node-id
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || reject_claim invalid-source-sha
[[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || reject_claim invalid-base-sha
[[ "$signed_paths_hash" =~ ^[0-9a-f]{64}$ ]] || reject_claim invalid-path-hash
expected_source_repo="https://github.com/${FLEET_ORG}/${node}.git"
[[ "${source_repo,,}" == "$expected_source_repo" ]] || reject_claim invalid-source-repo

jq -e \
  --arg login "$OPERATOR_BOT_LOGIN" \
  --argjson bot_id "$OPERATOR_BOT_ID" \
  --arg repo "$REPOSITORY" \
  --arg branch "cogni-operator/node-register-$node" \
  --arg base_sha "$base_sha" \
  '.state == "open"
   and .base.ref == "main"
   and .base.sha == $base_sha
   and .head.ref == $branch
   and .user.login == $login
   and .user.id == $bot_id
   and .user.type == "Bot"
   and ((.head.repo.full_name | ascii_downcase) == ($repo | ascii_downcase))
   and .commits == 1' "$pr_json" >/dev/null || reject_claim invalid-pr-identity

jq -e \
  --arg sha "$head_sha" \
  --arg login "$OPERATOR_BOT_LOGIN" \
  --argjson bot_id "$OPERATOR_BOT_ID" \
  --arg base_sha "$base_sha" \
  '.sha == $sha
   and .author.login == $login
   and .author.id == $bot_id
   and .commit.verification.verified == true
   and .commit.verification.reason == "valid"
   and (.parents | length) == 1
   and .parents[0].sha == $base_sha' "$commit_json" >/dev/null || reject_claim invalid-commit-signature

subject="$(sed -n '1p' "$message_file")"
[[ "$subject" == "feat(node): register $node" ]] || reject_claim invalid-subject
if [[ "$EVENT_NAME" == pull_request ]]; then
  [[ "$head_sha" == "$PR_HEAD_SHA_PR" ]] || reject_claim event-head-mismatch
else
  reject_claim merge-group-not-fast-path
fi

if [[ -n "${FAST_PATH_FILES_JSON:-}" ]]; then
  cp "$FAST_PATH_FILES_JSON" "$files_json"
else
  gh api --paginate "repos/$REPOSITORY/pulls/$pr_number/files" --jq '.[]' | jq -s '.' > "$files_json"
fi

jq -e 'length > 0
  and all(.filename | type == "string")
  and all(.previous_filename == null)
  and all(.status == "added")' "$files_json" >/dev/null || reject_claim invalid-file-metadata

changed_paths="$tmpdir/changed-paths.txt"
jq -r '.[].filename' "$files_json" | LC_ALL=C sort -u > "$changed_paths"
[[ "$(jq 'length' "$files_json")" == "$(wc -l < "$changed_paths" | tr -d ' ')" ]] || reject_claim duplicate-file

if command -v sha256sum >/dev/null 2>&1; then
  actual_paths_hash="$(sha256sum "$changed_paths" | awk '{print $1}')"
else
  actual_paths_hash="$(shasum -a 256 "$changed_paths" | awk '{print $1}')"
fi
[[ "$actual_paths_hash" == "$signed_paths_hash" ]] || reject_claim changed-path-hash-mismatch

expected_paths="$tmpdir/expected-paths.txt"
if [[ -n "${FAST_PATH_BIRTH_PLAN_LIB:-}" ]]; then
  # Hermetic test seam; CI never sets this.
  # shellcheck disable=SC1090
  source "$FAST_PATH_BIRTH_PLAN_LIB"
else
  plan='scripts/ci/lib/node-birth-fast-path-plan.sh'
  git cat-file -e "origin/main:$plan" 2>/dev/null || reject_claim trusted-plan-unavailable
  # shellcheck disable=SC1090
  source <(git show "origin/main:$plan")
fi
node_birth_fast_path_paths "$node" > "$expected_paths"
[[ -s "$expected_paths" ]] || reject_claim trusted-plan-empty
cmp -s "$changed_paths" "$expected_paths" || reject_claim path-plan-mismatch

if [[ -z "${FAST_PATH_SKIP_TREE_DIFF:-}" ]]; then
  tree_paths="$tmpdir/tree-paths.txt"
  git diff-tree --no-commit-id --name-only -r "$head_sha" | LC_ALL=C sort -u > "$tree_paths"
  cmp -s "$changed_paths" "$tree_paths" || reject_claim tree-path-mismatch
fi

catalog_path="infra/catalog/$node.yaml"
catalog_yaml="$tmpdir/catalog.yaml"
catalog_json="$tmpdir/catalog.json"
if [[ -n "${FAST_PATH_HEAD_CATALOG:-}" ]]; then
  cp "$FAST_PATH_HEAD_CATALOG" "$catalog_yaml"
else
  git show "$head_sha:$catalog_path" > "$catalog_yaml" || reject_claim missing-head-catalog
fi
if [[ "${FAST_PATH_BASE_CATALOG_ABSENT:-}" != true ]] && git cat-file -e "$base_sha:$catalog_path" 2>/dev/null; then
  reject_claim catalog-already-exists
fi
yq -o=json '.' "$catalog_yaml" > "$catalog_json" 2>/dev/null || reject_claim invalid-catalog-yaml

# Canonical birth semantics. Formatting/comments are covered by the signed tree;
# overlays/AppSets are byte-replayed by the workflow's trusted renderers.
expected_image_repo="ghcr.io/${FLEET_ORG}/${node}"
if ! jq -e \
  --arg node "$node" \
  --arg node_id "$node_id" \
  --arg source_repo "$expected_source_repo" \
  --arg source_sha "$source_sha" \
  --arg image_repo "$expected_image_repo" '
  type == "object"
  and ((keys | sort) == ([
    "activity_env", "candidate_a_branch", "compute_api", "deployment_provider",
    "dockerfile", "envs", "image_repository", "image_tag_suffix",
    "lease_generation", "migrator_tag_suffix", "name", "node_id", "node_port",
    "owner_wallet", "path_prefix", "port", "preview_branch",
    "production_branch", "source_repo", "source_sha", "type"
  ] | sort))
  and .name == $node
  and .type == "node"
  and .port == 3200
  and (.node_port | type == "number" and . >= 30000 and . <= 32767 and floor == .)
  and .dockerfile == ("nodes/" + $node + "/app/Dockerfile")
  and .image_tag_suffix == ("-" + $node)
  and .migrator_tag_suffix == ("-" + $node + "-migrate")
  and ((.source_repo | ascii_downcase) == $source_repo)
  and .image_repository == $image_repo
  and .source_sha == $source_sha
  and .candidate_a_branch == ("deploy/candidate-a-" + $node)
  and .preview_branch == ("deploy/preview-" + $node)
  and .production_branch == ("deploy/production-" + $node)
  and .envs == ["candidate-a", "production"]
  and .deployment_provider == {"candidate-a":"akash", "production":"akash"}
  and .compute_api == {"candidate-a":"crossplane", "production":"crossplane"}
  and .lease_generation == {"candidate-a":0, "production":0}
  and .activity_env == "production"
  and (.owner_wallet | test("^0x[0-9A-Fa-f]{40}$"))
  and .path_prefix == ("nodes/" + $node + "/")
  and .node_id == $node_id
  ' "$catalog_json" >/dev/null; then
  reject_claim invalid-birth-catalog
fi

# Byte replay uses the checked-out renderers only after the exact path plan has
# proved the PR cannot modify those renderers or any dependency they consume.
# The catalog semantics above are the renderer inputs; every emitted overlay and
# AppSet must match the trusted generator byte-for-byte before eligibility exists.
if [[ -z "${FAST_PATH_SKIP_GENERATED_REPLAY:-}" ]]; then
  for env_name in candidate-a production; do
    for overlay_file in external-secret.yaml kustomization.yaml; do
      generated_path="infra/k8s/overlays/${env_name}/${node}/${overlay_file}"
      [[ -f "$generated_path" ]] || reject_claim missing-generated-overlay
      if ! diff -u "$generated_path" \
        <(bash scripts/ci/render-node-overlays.sh "$env_name" "$node" "$overlay_file") >/dev/null; then
        reject_claim overlay-replay-mismatch
      fi
    done
    appset_path="infra/k8s/argocd/appsets/${FLEET_CONTROL_ENV:-production}/${env_name}-${node}-applicationset.yaml"
    [[ -f "$appset_path" ]] || reject_claim missing-generated-appset
    if ! diff -u "$appset_path" \
      <(bash scripts/ci/render-node-appset.sh "$env_name" "$node") >/dev/null; then
      reject_claim appset-replay-mismatch
    fi
  done
fi

emit eligible true
emit reason eligible
echo "node-birth fast path: eligible signed data-only birth for $node"
