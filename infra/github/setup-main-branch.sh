#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Apply Cogni's canonical `main` branch GH config to a node-template-shaped repo.
# Idempotent: re-running converges to the desired state.
#
# Spec: docs/spec/node-ci-cd-contract.md#repo-setup-fixture
# Fixtures:
#   - infra/github/branch-protection.json — required status checks + main-branch rules
#   - infra/github/merge-queue.json       — queue tuning values for the manual UI step
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

# 3. Merge queue toggle — UI-only at time of writing. REST silently drops `required_merge_queue`.
echo "    [3/3] merge queue: REST endpoint cannot enable. Manual UI step required:"
echo
echo "         🔗 https://github.com/$REPO/settings/branches"
echo "             → edit the 'main' rule"
echo "             → check 'Require merge queue'"
echo "             → fill the form using values from infra/github/merge-queue.json"
echo "             → save"
echo

# Verify what was applied via API.
echo "==> Verifying applied state"
gh api "repos/$REPO/branches/main/protection" \
  | jq '{required_checks: .required_status_checks.contexts}'

# Best-effort merge-queue check.
QUEUE_ID=$(gh api graphql -f query="query { repository(owner:\"${REPO%/*}\", name:\"${REPO#*/}\") { mergeQueue(branch:\"main\") { id } } }" \
  --jq '.data.repository.mergeQueue.id // empty' 2>/dev/null || true)

if [ -n "$QUEUE_ID" ]; then
  echo "==> Merge queue: ENABLED (id=$QUEUE_ID)"
else
  echo "==> Merge queue: NOT ENABLED — complete the UI step above"
fi
