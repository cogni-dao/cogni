# review · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

GitHub App auth + the operator-owned PR-review GitHub plane. Covers Check Run
lifecycle, PR comment posting with staleness guard, PR evidence + root
repo-spec/owning-node routing, node-owned gate/rule loading, and GitHub App
installation tokens.

## Pointers

- [VCS Integration Spec](../../../../../../docs/spec/vcs-integration.md)
- [Review feature](../../../features/review/) (gate evaluation + formatting)
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
  - `createInstallationOctokit(installationId, appId, privateKeyBase64)` — JWT sign → installation token → authenticated Octokit (`github-auth.ts`)
  - `createGithubReviewAdapter({ appId, privateKeyBase64, logger })` → `{ createCheckRun, updateCheckRun, postPrComment, fetchPrContext }` (`github-review.adapter.ts`)
- **Env/Config keys:** `GH_REVIEW_APP_ID`, `GH_REVIEW_APP_PRIVATE_KEY_BASE64` (via serverEnv)

## Ports

- **Uses ports:** none (direct GitHub API via Octokit)
- **Implements ports:** none (resolved by `bootstrap/review/resolve-review-route.ts`)

## Responsibilities

- This directory **does:**
  - Manage GitHub App JWT signing and installation token exchange
  - Create/finalize GitHub Check Runs (maps internal pass/fail/neutral → GitHub success/failure/neutral)
  - Fetch PR metadata + diff + repo-spec + rule files; resolve the owning domain (`extractOwningNode`)
  - Resolve owning node from root repo-spec, then load review gates from the owning node's `.cogni/repo-spec.yaml`
  - Parse rule files carrying per-rule model selection
  - Apply budget-aware truncation to large diffs
  - Post PR comments with HEAD-SHA staleness guard (skip if SHA changed)
- This directory **does not:**
  - Spend AI tokens / evaluate gates (the feature handler does this through GraphExecutorPort)
  - Manage webhook routing or signature verification

## Notes

- Check Run name: `"Cogni Git PR Review"` — matches `.allstar/branch_protection.yaml`
- Staleness guard: compares expected HEAD SHA against current before posting, prevents stale comments
- Evidence truncation: max 30 files, 100KB/file, 500KB total patch content
- Requires `checks:write` and `pull_requests:write` GitHub App permissions
