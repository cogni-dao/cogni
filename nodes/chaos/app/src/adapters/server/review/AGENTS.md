# review · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

GitHub API adapters for PR review: Check Run lifecycle, PR comment posting with staleness guard, PR evidence gathering, and GitHub App installation token management.

## Pointers

- [VCS Integration Spec](../../../../../../docs/spec/vcs-integration.md)
- [Review Feature](../../../features/review/) (business logic, gate orchestrator)
- [Bootstrap Wiring](../../../bootstrap/review-adapter.factory.ts) (creates adapter closures)
- [GitHub App Webhook Setup](../../../../../../docs/guides/github-app-webhook-setup.md)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["adapters/server", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:**
  - `createCheckRun(octokit, owner, repo, headSha)` — create Check Run (in_progress)
  - `updateCheckRun(octokit, owner, repo, checkRunId, conclusion, summary)` — finalize Check Run with markdown output
  - `gatherEvidence(octokit, owner, repo, prNumber)` — fetch PR diff + file patches with budget truncation
  - `postPrComment(octokit, owner, repo, prNumber, expectedHeadSha, body)` — post comment with staleness guard
  - `createInstallationOctokit(installationId)` — JWT sign → installation token → authenticated Octokit
- **Env/Config keys:** `GH_REVIEW_APP_ID`, `GH_REVIEW_APP_PRIVATE_KEY_BASE64` (via serverEnv)

## Ports

- **Uses ports:** none (direct GitHub API via Octokit)
- **Implements ports:** none (adapter functions injected into `ReviewHandlerDeps` by bootstrap)

## Responsibilities

- This directory **does:**
  - Manage GitHub App JWT signing and installation token exchange
  - Create and update GitHub Check Runs (maps internal pass/fail/neutral → GitHub success/failure/neutral)
  - Fetch PR metadata, diff, and file patches via GitHub REST API
  - Apply budget-aware truncation to large diffs
  - Post PR comments with HEAD SHA staleness guard (skip if SHA changed)
- This directory **does not:**
  - Contain review business logic (owned by `features/review/`)
  - Make LLM calls or evaluate gates
  - Manage webhook routing or signature verification

## Notes

- Check Run name: `"Cogni Git PR Review"` — matches `.allstar/branch_protection.yaml`
- Staleness guard: compares expected HEAD SHA against current before posting, prevents stale comments
- Evidence truncation: max 50 files, max 100KB total patch content
- Requires `checks:write` and `pull_requests:write` GitHub App permissions
