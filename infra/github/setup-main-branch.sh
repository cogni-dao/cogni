#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Apply Cogni's canonical `main` branch GH config to a node-template-shaped repo.
# Idempotent: re-running converges to the desired state.
#
# Spec: docs/spec/node-ci-cd-contract.md#repo-setup-fixture
# Fixtures:
#   - infra/github/branch-protection.json   — required status checks + main-branch rules
#   - infra/github/merge-queue-ruleset.json — `merge_queue` ruleset (queue requirement, config-as-code)
#
# Usage:
#   bash infra/github/setup-main-branch.sh                      # applies to current repo (gh auth context)
#   bash infra/github/setup-main-branch.sh cogni-dao/test-repo  # applies to an explicit repo
#
# Prerequisites:
#   - gh CLI authed as a repo admin
#   - jq available

set -euo pipefail

REPO="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Applying main-branch config to $REPO"

# 1. Repo-level merge settings: squash-only, auto-merge enabled, delete branch on merge.
echo "    [1/3] repo settings (squash-only, auto-merge, delete-on-merge)"
gh api -X PATCH "repos/$REPO" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -F allow_auto_merge=true >/dev/null

# 2. Classic branch protection — required status checks set.
echo "    [2/3] branch protection (required: $(jq -r '.required_status_checks.contexts | join(", ")' "$SCRIPT_DIR/branch-protection.json"))"
jq 'with_entries(select(.key | startswith("_") | not))' "$SCRIPT_DIR/branch-protection.json" \
  | gh api -X PUT "repos/$REPO/branches/main/protection" --input - >/dev/null

# 3. Merge queue — applied as a `merge_queue` repository RULESET (config-as-code).
#    Classic protection's REST drops `required_merge_queue`; the rulesets API carries it. Idempotent:
#    find the ruleset by name, then PUT (update) if it exists or POST (create) if not.
RULESET_NAME="$(jq -r '.name' "$SCRIPT_DIR/merge-queue-ruleset.json")"
echo "    [3/3] merge queue ruleset ($RULESET_NAME)"
RULESET_PAYLOAD="$(jq 'with_entries(select(.key | startswith("_") | not))' "$SCRIPT_DIR/merge-queue-ruleset.json")"
# The fixture is portable and therefore names no installation-specific actor. When this manual
# setup path is used for an operator-managed repo, inject that repo's review App as the sole queue
# bypass actor. `/vcs/merge` spends the bypass only for a classified signed env-manager PR; classic
# required checks remain independent. Runtime convergence performs the same injection automatically.
if [ -n "${COGNI_REVIEW_APP_ID:-}" ]; then
  [[ "$COGNI_REVIEW_APP_ID" =~ ^[1-9][0-9]*$ ]] || {
    echo "ERROR: COGNI_REVIEW_APP_ID must be a positive integer" >&2
    exit 1
  }
  RULESET_PAYLOAD="$(printf '%s' "$RULESET_PAYLOAD" | jq --argjson app_id "$COGNI_REVIEW_APP_ID" '.bypass_actors = [{actor_id: $app_id, actor_type: "Integration", bypass_mode: "always"}]')"
fi
EXISTING_RULESET_ID="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$RULESET_NAME\") | .id" 2>/dev/null | head -1 || true)"
if [ -n "$EXISTING_RULESET_ID" ]; then
  printf '%s' "$RULESET_PAYLOAD" \
    | gh api -X PUT "repos/$REPO/rulesets/$EXISTING_RULESET_ID" --input - >/dev/null
else
  printf '%s' "$RULESET_PAYLOAD" \
    | gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null
fi

# Verify what was applied via API.
echo "==> Verifying applied state"
gh api "repos/$REPO/branches/main/protection" \
  | jq '{required_checks: .required_status_checks.contexts}'

# Confirm the merge queue is live (GraphQL is authoritative — a `merge_queue` ruleset on the default
# branch surfaces here regardless of whether it was enabled via ruleset or the legacy UI checkbox).
QUEUE_ID=$(gh api graphql -f query="query { repository(owner:\"${REPO%/*}\", name:\"${REPO#*/}\") { mergeQueue(branch:\"main\") { id } } }" \
  --jq '.data.repository.mergeQueue.id // empty' 2>/dev/null || true)

if [ -n "$QUEUE_ID" ]; then
  echo "==> Merge queue: ENABLED (id=$QUEUE_ID)"
else
  echo "==> Merge queue: NOT ENABLED — ruleset apply may have failed; check 'gh api repos/$REPO/rulesets'"
fi
