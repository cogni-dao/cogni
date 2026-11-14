# features/review · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

PR review feature: deterministic gate orchestrator evaluates PRs against `.cogni/repo-spec.yaml` gates, dispatches AI rule evaluations via GraphExecutorPort, and formats results as GitHub Check Run summaries and PR comments.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Architecture](https://node-template.cognidao.org/knowledge/hexagonal-layering-contract)
- [VCS Integration Spec](https://cognidao.org/knowledge/pr-review-grounded-gate)
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
- **Goal-metric calculators (`review-kpis.ts`, task.5450):** `review.merge-coverage@1` and `review.fail-fix-rate@1` (unit `ratio`, param `days`, default 7) over `ReviewKpiSourcePort`; registered in `bootstrap/capabilities/goal-metrics.ts`. Count only check runs the review App wrote; neutral is not a pass; unknown is unavailable, never 0.
- **Review timing (`review.duration@1`, spike.5018):** completed check `startedAt` to `completedAt`, in minutes; `days` and `quantile` (50/90/95). `ReviewDurationSourcePort` discovers immutable heads from retained Temporal review identities, then reads all App checks on those heads. Deduplicates check IDs, includes all conclusions, and reports pending/sample counts. Missing timing, incomplete reads and empty windows are unavailable.
- **Merge-queue verdict copy (`queue-verdict.ts`, task.5438):** pure `extractQueuePush`, `parseQueueRef`, `selectHeadVerdictRun`, `decideQueueVerdict` — copies the PR head's `Cogni Git PR Review` verdict (review App only) onto the queue commit so the check can be GitHub-required on the operator repo. Never neutral, never silently skipped; no LLM.
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
