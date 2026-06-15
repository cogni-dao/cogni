---
name: node-template-infra-sync-prs
description: Use this whenever a node-template, node source repo, or Cogni CI/CD contract change must be mirrored across node repos. Trigger for requests to sync node-template infra, port CI/CD workflow updates to nodes, mirror a merged operator PR into source repos, update all node repos, or create one PR per node. This skill is especially important for Cogni-DAO/node-template, cogni-test-org/node-template, cogni-test-org/test-cog, and any repo referenced by infra/catalog source_repo rows.
---

# Node Template Infra Sync PRs

Use this skill to turn one upstream node CI/CD or template infra change into a complete, auditable set of downstream PRs. The default shape is **one target repo, one branch, one PR**. Do not batch multiple node repos into one PR, and do not stop after the obvious production repos; the test org is part of the contract.

## Core Rule

Maintain a 1:1 ledger:

```text
upstream change -> target repo -> mirror branch -> PR URL -> check state -> merge state
```

Save the ledger in `.context/node-template-infra-sync-prs/<upstream-pr-or-sha>.json` while working. Update it whenever a target is discovered, skipped, opened, fixed, merged, or blocked. The ledger is how you avoid missing a repo and how the final answer stays precise.

Use this shape:

```json
{
  "upstream": {
    "repo": "Cogni-DAO/cogni",
    "pr": 1562,
    "merged": true,
    "mergeCommit": "..."
  },
  "canonical": {
    "repo": "Cogni-DAO/node-template",
    "ref": "main",
    "files": [
      ".github/workflows/ci.yaml",
      ".github/workflows/pr-build.yml",
      ".github/workflows/pr-lint.yaml",
      "scripts/check-node-ci-workflow.mjs",
      "package.json",
      "pnpm-lock.yaml"
    ]
  },
  "targets": [
    {
      "repo": "cogni-test-org/test-cog",
      "source": "test-org-scan",
      "classification": "missing-pr-build",
      "branch": "codex/sync-pr-build-pr1562",
      "pr": "https://github.com/cogni-test-org/test-cog/pull/1",
      "state": "open",
      "checks": "pending",
      "notes": "existing PR reused"
    }
  ],
  "skipped": [
    {
      "repo": "cogni-test-org/cogni-monorepo",
      "reason": "monorepo/control-plane fixture, not node-at-root"
    }
  ]
}
```

## Discovery

Start from the upstream change, then enumerate all downstream repos before opening PRs.

1. Inspect the upstream PR or commit.
   - Identify the canonical files or behavior being ported.
   - Record whether files should be byte-for-byte identical or adapted per repo.
   - If the upstream PR has not merged, monitor it and do not mirror final changes until it merges.

2. Enumerate production/control-plane targets.
   - Read `infra/catalog/*.yaml` in the operator repo.
   - Include every row with a remote `source_repo`.
   - Include template repos explicitly: `Cogni-DAO/node-template` and `cogni-test-org/node-template`.
   - Include any repo named directly by the user.
   - Normalize `source_repo` values to `owner/repo`: strip `https://github.com/`, `git@github.com:`, and trailing `.git`.

3. Enumerate the test org.
   - Run `gh repo list cogni-test-org --limit 100 --json nameWithOwner,isArchived,defaultBranchRef`.
   - Exclude archived repos and repos without a usable default branch.
   - Include persistent test repos explicitly: `cogni-test-org/node-template` and `cogni-test-org/test-cog`.
   - Include any test-org repo named directly by the user or referenced by catalog `source_repo`.
   - Do not target every marker-complete test-org repo. Most test-org nodes are throwaway wizard spawns; marker presence is evidence for classification, not inclusion.
   - Always check for `cogni-test-org/test-cog`; do not rely on search alone.
   - Do not treat `cogni-test-org/cogni-monorepo` as a node-at-root repo just because it has workflow drift. It is a monorepo/control-plane fixture unless the user explicitly asks to update it.

4. Scan CI contract state for each candidate.
   - Fetch `.github/workflows/pr-build.yml`, `.github/workflows/ci.yaml`, `.github/workflows/pr-lint.yaml`, `scripts/check-node-ci-workflow.mjs`, and `package.json` when present.
   - Classify each repo as `current`, `missing`, `old-contract`, `adapt-needed`, or `skip-with-reason`.
   - For source-SHA artifact contract syncs, current means the repo publishes `ghcr.io/<owner>/<repo>:sha-<sourceSha>` and does not rely on `pr-*`, `mq-*`, or `*-node` image names for the deployable artifact.

## Useful Commands

Run these from the operator checkout unless the user gives a different repo.

Catalog source repos:

```bash
rg -n '^source_repo:' infra/catalog
```

Test org inventory:

```bash
gh repo list cogni-test-org --limit 100 \
  --json nameWithOwner,isArchived,defaultBranchRef,url,updatedAt
```

Node-at-root marker check for one repo:

```bash
repo=cogni-test-org/test-cog
for path in .cogni Dockerfile package.json pnpm-workspace.yaml app packages; do
  gh api "repos/$repo/contents/$path?ref=main" --silent >/dev/null 2>&1 \
    && echo "present $path" || echo "missing $path"
done
```

Use the marker check only after a repo is already in scope. It is not an instruction to sync every node-looking repo in `cogni-test-org`.

Workflow contract scan:

```bash
gh repo list cogni-test-org --limit 100 \
  --json nameWithOwner,isArchived,defaultBranchRef \
  --jq '.[] | select(.isArchived==false and .defaultBranchRef.name=="main") | .nameWithOwner' |
while IFS= read -r repo; do
  workflow="$(gh api "repos/$repo/contents/.github/workflows/pr-build.yml?ref=main" --jq .content 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [ -z "$workflow" ]; then
    state=no-pr-build
  elif printf '%s' "$workflow" | rg -q 'repo_lc\}-node|IMAGE_TAG="pr-|IMAGE_TAG="mq-'; then
    state=old-contract
  elif printf '%s' "$workflow" | rg -q 'image_name=ghcr\.io/\$\{owner_lc\}/\$\{repo_lc\}|image_tag=sha-\$\{source_sha\}'; then
    state=current-source-sha
  else
    state=unknown
  fi
  printf '%s\t%s\n' "$repo" "$state"
done
```

## Porting

Make one PR per target repo. Use a stable branch name that ties back to the upstream PR, for example `codex/sync-pr-build-pr1562`.

Prefer GitHub API file updates when the change is small; use a local clone only when you need package-manager output or broad mechanical edits. If you use zsh, never use `path` as a loop variable because it mutates zsh command lookup.

When refreshing a node-template fork PR branch, prefer the committed helper:

```bash
PR_TITLE='ci: sync test-cog node CI' \
  scripts/ci/sync-node-template-fork-pr.sh cogni-test-org/test-cog codex/fix-test-cog-image-name
```

Set `WATCH=1` when the user expects you to monitor checks through completion.

For node-template-style repos, the usual mirror set is:

- `.github/workflows/ci.yaml`
- `.github/workflows/pr-build.yml`
- `.github/workflows/pr-lint.yaml`
- `scripts/check-node-ci-workflow.mjs`
- `package.json` scripts/dependencies needed by the workflow checker
- lockfile changes if dependencies changed

When a file should match the canonical template, copy it byte-for-byte from the canonical repo and record that in the ledger. When a repo requires an adaptation, keep it minimal and record exactly why it differs.

Do not remove unrelated existing branch changes unless the user explicitly tells you to clean that PR. If an existing PR already targets the same repo and purpose, update that branch instead of opening a duplicate.

## 1:1 Matching Rules

For each target, identify the exact source of truth and apply it once:

- `Cogni-DAO/node-template` is the canonical source for node-at-root CI files unless the upstream PR changed a different canonical repo.
- `cogni-test-org/node-template` mirrors `Cogni-DAO/node-template`.
- Persistent test-org nodes like `cogni-test-org/test-cog` mirror `Cogni-DAO/node-template` for workflow contract files, but keep their existing app/package changes unless those are required for CI.
- Throwaway test-org spawns are skipped unless the user explicitly names them.
- Catalog `source_repo` rows map to the repo named by that row, not to the parent operator repo.
- If a repo already has an open sync PR, reuse that PR and update its branch. Do not open PR #2 for the same target/purpose.
- If two catalog rows point to the same repo, create one PR for that repo and list both rows in the ledger notes.

For source-SHA artifact builds, the mirror is not green until the target workflow publishes:

```text
ghcr.io/<lower-owner>/<lower-repo>:sha-<sourceSha>
```

Avoid legacy deployable names:

```text
ghcr.io/<owner>/<repo>-node:pr-...
ghcr.io/<owner>/<repo>-node:mq-...
ghcr.io/<owner>/cogni-node-template:sha-...
```

Those names may exist historically, but they are not the deploy coordinate for the artifact-first contract.

## Verification

For every PR:

1. Check changed files and confirm they match the intended mirror set.
2. Confirm semantic PR title passes or update the title.
3. Wait for GitHub checks through `gh pr view --json statusCheckRollup`.
4. If `PR Build` fails, inspect logs with `gh run view` / `gh run watch` / `gh run download` as needed.
5. Distinguish code failures from repo/package permissions. GHCR `write_package` failures are operational blockers; record them explicitly instead of calling the PR green.
6. For merged PRs, check `push: main` workflows too; the source repo must actually publish the `sha-<mainSha>` artifact.

Use this current-state query:

```bash
gh pr view "$number" --repo "$repo" \
  --json url,state,isDraft,mergeable,headRefOid,statusCheckRollup,files
```

If a check is still running, keep monitoring or arm an explicit monitor. Do not final-answer "ready to merge" while the source repo's `PR Build` is pending.

## Final Report

Return a compact table:

```text
repo | PR | state | checks | confidence | notes
```

Include skipped repos with the skip reason when the user asked for all nodes. Call out any remaining operational blocker, especially GHCR permissions or open PRs still waiting on checks.
