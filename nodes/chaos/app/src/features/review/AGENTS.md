# features/review · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

PR review feature: deterministic gate orchestrator evaluates PRs against `.cogni/repo-spec.yaml` gates, dispatches AI rule evaluations via GraphExecutorPort, and formats results as GitHub Check Run summaries and PR comments.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)
- [VCS Integration Spec](../../../../../docs/spec/vcs-integration.md)
- [repo-spec package](../../../../../packages/repo-spec/) (gate + rule schema validation)
- [pr-review graph](../../../../../packages/langgraph-graphs/src/graphs/pr-review/) (LangGraph structured output)
- **Related:** [../../adapters/server/review/](../../adapters/server/review/) (GitHub API adapters), [../../bootstrap/review-adapter.factory.ts](../../bootstrap/review-adapter.factory.ts) (wiring)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["core", "ports", "shared", "types"],
  "must_not_import": ["app", "adapters"]
}
```

## Public Surface

- **Exports (via public.server.ts):**
  - `handlePrReview(ctx, deps)` — orchestrate full review flow: evidence → gates → check run → comment
  - `ReviewHandlerDeps` — injected adapter functions (facade provides concrete implementations)
- **Types (via types.ts):**
  - `GateStatus`, `GateResult`, `ReviewResult` — gate evaluation results
  - `EvidenceBundle` — pre-fetched PR diff + file patches
  - `ReviewContext` — owner/repo/prNumber/headSha/installationId
- **Env/Config keys:** none (all deps injected)
- **Files considered API:** `public.server.ts`, `types.ts`

## Ports

- **Uses ports:** GraphExecutorPort (via injected `executor` in ReviewHandlerDeps)
- **Implements ports:** none

## Responsibilities

- This directory **does:**
  - Run gates in declared order with per-gate timeout (120s) and crash isolation (→ neutral)
  - Aggregate gate results: fail > neutral > pass
  - Evaluate `review-limits` gates (file count + diff size, pure numeric, no LLM)
  - Evaluate `ai-rule` gates (invoke pr-review graph via GraphExecutorPort with structured output, apply `success_criteria` thresholds deterministically)
  - Format Check Run markdown summaries and PR comments (verdict, counts, per-gate sections, blockers, staleness marker)
  - Cache parsed rules per review run
- This directory **does not:**
  - Import adapters (GitHub API calls injected via `ReviewHandlerDeps`)
  - Create Octokit clients or manage GitHub auth
  - Fetch PR evidence (injected `gatherEvidence` adapter)
  - Post comments or create check runs directly

## Notes

- Fire-and-forget execution — errors logged, never block webhook response
- System tenant billing: `COGNI_SYSTEM_BILLING_ACCOUNT_ID` for all LLM calls
- Gate types: `review-limits` (deterministic) and `ai-rule` (LLM + structured output)
- Output format aligned with legacy [cogni-git-review](https://github.com/cogni-dao/cogni-git-review)
