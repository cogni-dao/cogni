#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/ci/sync-node-template-fork-pr.sh <owner/repo> <branch>

Env:
  TEMPLATE_REPO   Source template repo. Default: cogni-test-org/node-template
  BASE_BRANCH     Target base branch to fetch. Default: main
  PR_TITLE        Optional title to apply to the branch PR after push.
  WATCH           Set to 1 to watch checks after push.

Example:
  PR_TITLE='ci: sync test-cog node CI' \
    scripts/ci/sync-node-template-fork-pr.sh cogni-test-org/test-cog codex/fix-test-cog-image-name
EOF
}

repo="${1:-}"
branch="${2:-}"
if [[ -z "$repo" || -z "$branch" ]]; then
  usage
  exit 2
fi

template_repo="${TEMPLATE_REPO:-cogni-test-org/node-template}"
base_branch="${BASE_BRANCH:-main}"
work_root="${WORK_ROOT:-.context/node-template-fork-sync}"
safe_repo="${repo//\//__}"
workdir="${work_root}/${safe_repo}"

mkdir -p "$workdir"
if [[ ! -d "${workdir}/.git" ]]; then
  git -C "$workdir" init
  git -C "$workdir" remote add origin "https://github.com/${repo}.git"
else
  git -C "$workdir" remote set-url origin "https://github.com/${repo}.git"
fi
git -C "$workdir" config remote.origin.promisor true
git -C "$workdir" config remote.origin.partialclonefilter blob:none

if git -C "$workdir" remote get-url template >/dev/null 2>&1; then
  git -C "$workdir" remote set-url template "https://github.com/${template_repo}.git"
else
  git -C "$workdir" remote add template "https://github.com/${template_repo}.git"
fi
git -C "$workdir" config remote.template.promisor true
git -C "$workdir" config remote.template.partialclonefilter blob:none

echo "==> Fetching ${repo}:${branch}, ${repo}:${base_branch}, ${template_repo}:${base_branch}"
git -C "$workdir" -c protocol.version=2 fetch --depth=100 --filter=blob:none origin \
  "${base_branch}:refs/remotes/origin/${base_branch}" \
  "${branch}:refs/remotes/origin/${branch}"
git -C "$workdir" -c protocol.version=2 fetch --depth=100 --filter=blob:none template \
  "${base_branch}:refs/remotes/template/${base_branch}"

git -C "$workdir" checkout -B "$branch" "origin/${branch}"

echo "==> Merging template/${base_branch} into ${repo}:${branch}"
if ! git -C "$workdir" merge --no-edit "template/${base_branch}"; then
  conflicts="$(git -C "$workdir" diff --name-only --diff-filter=U)"
  auto_resolved=0

  # Old one-file CI image-name edits are superseded by template PR Build's
  # repo-owned image-name derivation.
  if grep -qx ".github/workflows/ci.yaml" <<<"$conflicts"; then
    git -C "$workdir" checkout --theirs -- .github/workflows/ci.yaml
    git -C "$workdir" add .github/workflows/ci.yaml
    auto_resolved=1
  fi

  remaining="$(git -C "$workdir" diff --name-only --diff-filter=U)"
  if [[ -n "$remaining" ]]; then
    echo "FATAL: merge has unresolved conflicts:" >&2
    printf '%s\n' "$remaining" >&2
    exit 1
  fi

  if [[ "$auto_resolved" == "1" ]]; then
    git -C "$workdir" commit --no-edit
  fi
fi

if [[ -f "${workdir}/scripts/check-node-ci-workflow.mjs" ]]; then
  echo "==> Running workflow invariant"
  git -C "$workdir" status --short
  (cd "$workdir" && node scripts/check-node-ci-workflow.mjs)
fi

echo "==> Pushing ${repo}:${branch}"
git -C "$workdir" push origin "$branch"

pr_number="$(gh pr list --repo "$repo" --head "$branch" --state open --json number --jq '.[0].number // ""' --limit 1)"
pr_url="$(gh pr list --repo "$repo" --head "$branch" --state open --json url --jq '.[0].url // ""' --limit 1)"

if [[ -n "${PR_TITLE:-}" && -n "$pr_number" ]]; then
  gh pr edit "$pr_number" --repo "$repo" --title "$PR_TITLE" >/dev/null
fi

if [[ -n "$pr_number" ]]; then
  echo "PR: ${pr_url}"
  echo "Checks: gh pr checks ${pr_number} --repo ${repo}"
  if [[ "${WATCH:-0}" == "1" ]]; then
    gh pr checks "$pr_number" --repo "$repo" --watch --interval 10
  fi
else
  echo "No open PR found for ${repo}:${branch}."
  echo "Create one with: gh pr create --repo ${repo} --base ${base_branch} --head ${branch}"
fi
