---
id: story.5096.handoff
type: handoff
work_item_id: story.5096
status: active
created: 2026-10-21
updated: 2026-10-21
branch: derekg1729/autonomous-work-plan-align
last_commit: 5db34bc15e
---

# Handoff: Mission-critical work prioritizer (langgraph:work-prioritizer)

## Mission

Pickup: you now own story.5096, Cogni's AI workflow that decides **what we work on**. The operator backlog is inflated: 22 of 27 candidate items and 80 prod items are p0, which leads to entropy. This graph runs on the operator governance schedule. Each cycle it:

- reads the whole actionable backlog, the approved DAO objectives (EDO goals in the hub) and its own prior EDO chain;
- judges every item;
- force-ranks the items under a hard capacity policy;
- writes `priority` and `rank` back conflict-safely;
- records an evidence-bearing EDO decision.

Scope is prioritization plus a learning EDO chain only. The CEO ruled that dispatch/sweep and the agents that do the work are out of scope.

## Goal

- **End state:** candidate-a runs `langgraph:work-prioritizer` every 5 min. A cycle writes priority and rank so that p0 ≤ 3, p1 ≤ 6 and p2 ≤ 12, with every p0/p1 citing an approved objective plus a why-now with evidence. Each cycle files a decision only when the plan changes, and re-reads its prior decision (memoized judgments, a diff vs prior).
- **Done when (approved, verbatim in story.5096 outcome):** On candidate-a at the flighted PR SHA, the governance schedule runs langgraph:work-prioritizer for ≥2 cycles. Each cycle reads the full actionable backlog, the approved objectives and its prior EDO chain, then conflict-safely applies priority and rank under the node's versioned capacity policy. It files a decision only when the plan changes, citing an objective and a why-now for every p0/p1, and checks due hypotheses against their named evidence. An eval at that SHA meets its written thresholds.
- **Candidate-a proof:**
  1. `curl https://test.cognidao.org/version` returns `.buildSha` equal to the PR head.
  2. `EVAL_EXPECTED_SHA=<head> pnpm eval:prioritizer -- --landed-at <ISO> --out <file>` exits 0 (PASS).
  3. ≥2 `system_scheduled` work-prioritizer runs at that SHA (`GET /api/v1/ai/runs?scope=system`).
  4. The candidate backlog (`GET /api/v1/work/items`) shows p0 ≤ 3.
  5. The scorecard is posted on PR #2812 plus a `/validate-candidate` scorecard.
  6. Then operator merge via `POST /api/v1/vcs/merge`.

## Start By Reading

- Design v4, the spec you implement against: hub entry `work-prioritization-design` in inbox https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-5a23154d. It is not merged; a human merges it. The same inbox holds `agent-harness-program-tiers`, the agent-loop vs AI-workflow terminology.
- CTO review that shaped v4 (capacity, apply protocol, EDO evidence, eval): `.context/attachments/x0jMPh/prioritizer-v3-cto-review.md` (local only). Authz direction: `/Users/derek/conductor/workspaces/cogni-template/autonomous-work-plan-align/.context/cto-message.md`.
- Graph: `packages/langgraph-graphs/src/graphs/work-prioritizer/`
  - `graph.ts`: StateGraph snapshot → judge → rank → plan → EDO → apply
  - `rank.ts`: lexicographic heuristic v1, gates, ceilings, hysteresis
  - `plan.ts`
  - `prompts.ts`: PROMPT_VERSION v4.2, compact judge lines
  - `schema.ts`, `guards.ts`
- Eval suite (black box, external lane): `packages/langgraph-graphs/evals/work-prioritizer/{README.md,run.ts,score.ts,thresholds.json,fixture.json}` and the grader tests in `packages/langgraph-graphs/tests/evals/`.
- Policy: `nodes/operator/.cogni/repo-spec.yaml` `work_prioritization:` (v4.0, caps 3/6/12, objectives, `apply.mode` {default: propose, candidate-a: write}) and the `WORK_PRIORITIZER` governance schedule (cron `*/5`). Schema and accessor: `packages/repo-spec/src/{schema,accessors}.ts`.
- Tool authz v0 seam: `packages/ai-core/src/tooling/tool-runner.ts`, where tools declare `requires: "node.collaborate" | AuthzAction`, plus `nodes/operator/app/src/adapters/server/ai/langgraph/inproc.provider.ts`. The design is recorded in the story.5096 outcome.
- Apply path: `core__work_item_apply_priority_plan` (packages/ai-tools) and its operator capability (advisory lock, per-row CAS via `setPriorityRank`, demotions first). The package op is node-template PR https://github.com/cogni-dao/node-template/pull/184, consumed as prerelease `work-items-v0.1.10-rc.1`.
- Governance sync: `packages/scheduler-core/src/services/syncGovernanceSchedules.ts` (graph:/model:/policy, the cron-drift fix) and `nodes/operator/app/src/bootstrap/{startup-reconcile.ts,jobs/syncGovernanceSchedules.job.ts}` (boot `scope:"self"`).

## Current State

- **PR:** https://github.com/cogni-dao/cogni/pull/2812 (draft), head `5db34bc`, MERGEABLE, frozen. Scorecards and the decision history are in PR comments; the latest is the 8886de5 result (11/13).
- **Proven live at 8886de5:**
  - Scheduled cycle at 02:45 UTC on 2026-10-21 applied 24 rows. The candidate backlog went from 22 p0 to 3: bug.5005, bug.5003, bug.5002.
  - Eval checks passed: coverage, ceilings, rationale, gates, stability and apply-match.
- **Fixed after 8886de5, not yet proven live:** these 4 defects are fixed in cef87e3, and 5db34bc adds a no-fork `stale_prior` guard and an observe-only write-mode eval.
  - the canonical duplicate was demoted to p4
  - p0 rank was null
  - the incident was stuck at p2 by the triage gate
  - cron `*/5` never reached Temporal
- **Latest eval at 5db34bc:** attempts 1–2 were INCONCLUSIVE because other PR flights evicted candidate-a. Candidate-a has no lease and the last flight wins. Attempt 3 was running at handoff; its output goes to `.context/eval-5db34bc-3.md`.
- **Lane B:** node-template PR #184 is green in CI with real-Doltgres tests, not merged. Its own candidate is broken by an unrelated LiteLLM key-alias mismatch, so runtime proof comes from operator candidate-a.
- **Model:** `gpt-oss-120b` (free). The system tenant has 0 credits in every environment, so any paid model fails `insufficient_credits`.
- **Work item:** story.5096 holds the v4 Goal/Done when (rev ≥3). task.5282 is the implementation child. The Lane B task was never filed because prod work-item writes were 503 for hours.

## Design / Implementation Target

1. **Capacity policy.** Ceilings, not targets: an empty p0 set is healthy, and p1 is independent of the p0 count. Pins (`priority:pinned`) are never moved.
2. **Judging vs ranking.** The LLM only judges, emitting enums plus evidence ids. Code does eligibility, ranking, ceilings and hysteresis. Titles and summaries are untrusted input, and injection-like items are never p0/p1.
3. **Snapshot completeness.** An incomplete snapshot or missing judgments must never publish a complete-looking ranking. Unjudged items go to p3 and are listed, with unjudged ≤ 10%.
4. **Writes.** Writes happen only in `write` mode, only on scheduled grant-backed runs, and only via the narrow apply op (CAS, lock, replay-safe). Propose mode writes nothing.
5. **EDO chain.** A decision is filed only when the plan changes. Each decision references its prior decision; a fork is aborted as `stale_prior`. Hypotheses are created only when material, each with an observation source plus a predicate, at most 3 per day. Due hypotheses are checked, and are left open if the evidence is insufficient.
6. **Authz.** Do not add OpenFGA tuple writers. Do not add first-party exemptions. Undeclared tools keep the legacy `tool.execute` path. The CTO rejected an auto-tuple attempt.
7. **Shared runtime.** Keep GraphExecutorPort, the governance schedule → GraphRunWorkflow path and the existing scheduler. No new runner or worker.

## Next Actions / Risks

- [ ] Read `.context/eval-5db34bc-3.md`. If it passed, post the scorecard on PR #2812 plus a `/validate-candidate` scorecard, using my judgment of the live p0/p1 table against the mission.
- [ ] If it was evicted again, re-flight (`POST /api/v1/vcs/flight` with nodeId `4ff8eac1-4eba-4ed0-931b-b1fe4f64713d` and the sourceSha) and re-run the eval immediately after landing.
- [ ] Merge node-template #184 via the operator, tag `work-items-v0.1.10`, repin operator off rc.1, then re-flight and re-run the eval.
- [ ] Operator merge of #2812 (`POST /api/v1/vcs/merge`) after validation. Before any prod promote, confirm prod `apply.mode` stays `propose` and pick a sensible prod cron (`*/5` is a candidate-proof setting).
- [ ] Get the hub inbox reviewed and merged by a human, then file the Lane B work item and update task.5282.
- **Risk: candidate eviction.** Parallel sessions flight candidate-a every 10–20 min. The eval exits 3 (INCONCLUSIVE) on eviction; that is not a FAIL.
- **Risk: free-model variance.** harmDays varies between runs; memoization stabilizes it. Any `PROMPT_VERSION` bump invalidates every memoized judgment.
- **Risk: prod work-item API.** It intermittently returns `work_items_busy` 503. Retry it, and never PATCH `outcome` from an empty read, which would wipe the outcome.
- **Gap: Langfuse.** Candidate traces aren't readable with the local keys, which point at a different project. Use Loki events `ai.work_prioritizer.cycle` and `ai.tool_authz.decision`.

## Pointers

| File / Resource                                         | Why it matters                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| https://github.com/cogni-dao/cogni/pull/2812            | Code, CI, eval scorecards (comments)                              |
| https://cognidao.org/work/items/story.5096              | Owned outcome: Goal/Done when verbatim                            |
| https://test.cognidao.org/version                       | Flight-landed ground truth                                        |
| https://github.com/cogni-dao/node-template/pull/184     | `setPriorityRank` CAS op (Lane B)                                 |
| `scripts/loki-query.sh` (+ `COGNI_ENV_FILE=.env.cogni`) | Live cycle/authz/LLM-call events, `namespace="cogni-candidate-a"` |
| `.context/priority-scale-proposal.md`                   | PM worked table (soft precision target)                           |

## Proposed Pivot (pending CEO approval)

Proposed Goal = Recurring brain loop pursues node mission through existing work-item CRUD
Proposed Done when = On candidate-a at the flighted SHA, the scheduled loop runs >=2 cycles reading approved goals plus only p0, unprioritized and changed items (full review at most daily), and sets priority/rank through the existing work-item patch path with no new write op; p0 <= 3, every p0/p1 cites a goal, an unchanged cycle writes nothing, and the eval at that SHA passes.

North-star review findings:

1. node-template #184 duplicates CRUD: the port's patch already sets priority/rank, and core**work_item_transition already has action=patch. The only real gap is that adapter patch is creator-bound. Fix: a small collaborator rule for triage fields (priority, rank, labels) on the existing patch. Drop setPriorityRank, CAS, the advisory lock and core**work_item_apply_priority_plan.
2. A full-backlog read every cycle does not scale. Use a delta scope (p0, unprioritized, changed since the prior decision) plus a full review at most daily.
3. Approved objectives exist only as candidate seeds. On the prod hub, dao-goal-\* returns 404, so prod has no loop root.
4. PR #2812 is 9.7k lines across 74 files. Shrink it to a guarded workflow stage on the shared runtime.

Ladder: v0 prioritize, then v1 research+refine+create (task.5283), then v2 implement via existing CICD flight.

Proposed hub skill = node-mission-loop: engineer a node's recurring brain loop that turns approved goals into ranked, researched, shipped work.
Linked roles: agent-infrastructure-expert, expertise-role-contract, cognition-expert, knowledge-syntropy-expert, edo-loop, node-temporal-substrate, dev-manager-contract, cicd-e2e-required-sequence, validate-candidate.
