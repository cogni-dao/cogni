<!--
SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
SPDX-FileCopyrightText: 2025 Cogni-DAO
-->

# infra/github

GitOps source-of-truth for repository-scope GitHub configuration on `main` — branch protection + merge queue. The fixtures here are **node-shape canonical**: any repo cloned/forked from `node-template` should be set up with the same config via [`setup-main-branch.sh`](./setup-main-branch.sh).

The GitHub UI accepts changes anywhere — these files are not auto-applied. They exist so that:

1. The current intended state is reviewable in code (PR diff = config diff).
2. A new fork can re-apply the config from scratch with one command.
3. Drift is detectable (compare API GET vs file).

## Files

| File                     | Status        | Purpose                                                                                                |
| ------------------------ | ------------- | ------------------------------------------------------------------------------------------------------ |
| `branch-protection.json` | **canonical** | `PUT .../branches/main/protection` payload — required status checks + main-branch rules.               |
| `merge-queue.json`       | **canonical** | Merge-queue tuning values. Applied via UI (see below) — REST endpoint is documented but doesn't work.  |
| `setup-main-branch.sh`   | **canonical** | One-command apply for any node-shaped fork: `bash infra/github/setup-main-branch.sh [<owner>/<repo>]`. |

Spec: [`docs/spec/node-ci-cd-contract.md#repo-setup-fixture`](../../docs/spec/node-ci-cd-contract.md#repo-setup-fixture).

## Apply procedure

```bash
# Apply to the current repo (uses gh auth context).
bash infra/github/setup-main-branch.sh

# Apply to an explicit repo (e.g., a fork).
bash infra/github/setup-main-branch.sh my-org/my-fork
```

The script does what's API-doable in three steps:

1. `PATCH /repos/{repo}` — squash-only, auto-merge enabled, delete-branch-on-merge.
2. `PUT /repos/{repo}/branches/main/protection` — required status checks `["unit","component","static","manifest"]`.
3. Prints the **one manual UI step** required for the merge queue. REST silently drops `required_merge_queue` (verified empirically against `cogni-dao/test-repo`, 2026-04-28). Until GitHub exposes this via REST, that toggle is a click in Settings → Branches.

## Why these specific required checks

The required-status-checks set is intentionally narrow because of an empirical constraint: **GitHub Merge Queue waits forever for required checks whose workflows lack a `merge_group:` trigger** (validated on `cogni-dao/test-repo` PR #53). Any check added to this list MUST be produced by a workflow that fires on both `pull_request:` AND `merge_group:` events.

This forces a clear policy: **PR-only workflows (CodeQL default-setup, Validate PR title, etc.) cannot be required.** They run on PRs as advisory signal only. The deeper rationale and the alternatives considered (stub-job pattern, Rulesets) live in [`docs/spec/merge-queue-config.md`](../../docs/spec/merge-queue-config.md).

## Drift detection

```bash
diff <(jq 'with_entries(select(.key | startswith("_") | not))' infra/github/branch-protection.json) \
     <(gh api repos/cogni-dao/cogni/branches/main/protection \
        | jq '{required_status_checks:{strict:.required_status_checks.strict,contexts:.required_status_checks.contexts},
               enforce_admins:null,required_pull_request_reviews:null,restrictions:null,
               required_linear_history:.required_linear_history.enabled,
               allow_force_pushes:.allow_force_pushes.enabled,allow_deletions:.allow_deletions.enabled,
               required_conversation_resolution:.required_conversation_resolution.enabled,
               lock_branch:.lock_branch.enabled,allow_fork_syncing:.allow_fork_syncing.enabled}')
```

## Why this isn't a reconciler workflow yet

A reconciler-on-`push:main` would auto-apply on file change. Skipped for v0:

- Requires a GitHub App with `administration:write`, expanding the App's blast radius.
- File changes are rare (~quarterly).
- One-time apply per change is acceptable.

Revisit if drift becomes a recurring issue or if change frequency rises.

## Related

- [docs/spec/node-ci-cd-contract.md](../../docs/spec/node-ci-cd-contract.md) — node sovereignty + merge-gate composition; this directory is referenced from the `## Repo Setup Fixture` section.
- [docs/spec/merge-queue-config.md](../../docs/spec/merge-queue-config.md) — two-tier model design + the rejected Rulesets path + empirical findings.
- [docs/spec/development-lifecycle.md](../../docs/spec/development-lifecycle.md) — where merge queue fits in the contributor flow.
- [work/items/task.0391.enable-merge-queue.md](../../work/items/task.0391.enable-merge-queue.md) — original adoption rationale.
