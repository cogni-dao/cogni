---
id: story.5116.handoff
type: handoff
work_item_id: story.5116
status: active
branch: feat/story5116-steward-agent
last_commit: 1aa447a70c
---

# Handoff: Cogni — the shared, hub-grounded mission agent

## Mission

Pickup: you own **Cogni**, the one reusable agent every node runs to advance its mission. It
reads the node's goals + knowledge + work items + git, then files **one EDO decision** about
what to prioritize/refine/create. The decide-state graph is built and behaviorally proven in
local dev; it is **not shipped**, and two structural questions are open (below). Read the
trust note in §Next Actions — the prior session lost the CEO's trust by flip-flopping the
design, bloating the PR, and answering sloppily. Move deliberately, prove locally, keep scope
tight.

## Goal

**End state.** On candidate at one verified SHA, chat and the existing schedule run the shared
Cogni engine; a run gathers deeply across all planes and **files a real `core__edo_decide`
decision that persists** (grounded, goal-cited), proven by a readable trace. Then the engine is
**authoritative in node-template and propagates to nodes** (not operator-only).

- **E2E / candidate proof.** Flight the PR head via `POST /api/v1/vcs/flight` (operator, never a
  personal `gh`), confirm `https://test.cognidao.org/version` `buildSha == head`, run cogni there,
  and read the trace via node-ai-traces-read. Pass = a persisted `core__edo_decide` row grounded
  in deep reads. Production follows existing release gates (two natural schedule ticks: tick 1
  files a goal-cited decision; tick 2 unchanged files no duplicate).
- **Local proof (already done, re-use it).** Register a throwaway agent, run cogni, read the trace
  — see §Start By Reading for the exact recipe. This is the 100x loop; use it before every flight.

## Start By Reading

- `packages/langgraph-graphs/src/graphs/operator/cogni.ts` — the as-built engine. `createCogniProgram`:
  compiled StateGraph `START → gather (createReactAgent over read tools) → decide (dedicated state,
forces native `core\_\_edo_decide`) → file → report`. `buildPreamble` (fail-closed identity + mission
  - governing index), `cogniTelemetry`, `goalsSeen` (NO_GOALS→report).
- `packages/langgraph-graphs/src/catalog.ts` L263-280 — **two entries, one factory:** `cogni`
  (program `cogni`, chat) and `work-prioritizer` (program `work-review`, the live schedule's graph-id
  alias). Both run `createCogniProgram`. `createWorkPrioritizerGraph` (work-prioritizer/graph.ts) is
  now **orphaned/dead** — only its name const is used.
- Harness design (the CEO's correction: these **are** the design — there is no single entry):
  [mission-loop-expert](https://cognidao.org/knowledge/mission-loop-expert) ·
  [agent-infrastructure-expert](https://cognidao.org/knowledge/agent-infrastructure-expert) ·
  [agent-run-lifecycle](https://cognidao.org/knowledge/agent-run-lifecycle) ·
  [agent-development](https://cognidao.org/knowledge/agent-development) ·
  [graph-execution-package-design](https://cognidao.org/knowledge/graph-execution-package-design) ·
  [mission-loop-roadmap](https://cognidao.org/knowledge/mission-loop-roadmap) (R0–R6; cogni = R1/R3).
  `agent-harness-program-tiers` is referenced everywhere but is **404 / an unmerged inbox** — the
  as-built two-phase design is **not in the hub**; writing it is in scope.
- `dao-goals-design` — the decision IS the prioritizer's proposal; `derives_from` a goal directly.

**Local run recipe (verified this session):**

1. `pnpm dev:infra` + `pnpm dev` (local stack; app on :3000). Goals are seeded in local Doltgres.
2. `curl -sX POST localhost:3000/api/v1/agent/register -H 'content-type: application/json' -d '{"name":"cogni-local"}'`
   → returns a `cogni_ag_sk_v1_...` key (also mints user + billing + virtual key). `pnpm dev:seed:money` to fund it.
3. `curl -sN -X POST localhost:3000/api/v1/ai/chat -H "authorization: Bearer <key>" -H 'content-type: application/json' -H 'origin: http://localhost:3000' -d '{"message":"Run the work-review mission loop...","graphName":"cogni","modelRef":{"providerKey":"platform","modelId":"gpt-5.6-luna"}}'`
   — **`providerKey` MUST be `platform`** (not `litellm`); gpt-oss-120b is too weak to call the tool.
4. Read actual tool calls: `grep '"toolName":"core__' sse` ; the filed decision: query local Doltgres
   `knowledge` for `id like 'cogni-%'`.

## Current State

- **PR [#2947](https://github.com/cogni-dao/cogni/pull/2947)**, branch `feat/story5116-steward-agent`,
  head **1aa447a70c** — rebased on `main` (0 behind). Large (+~2390 real src across 44 files: cogni
  graph, work-prioritizer, node-code read adapter, completion-adapter, EDO coverage grader, tests).
- **Done:** decide-state graph (generic, fail-closed, langgraph-dev-transparent). Fresh
  `/review-implementation` **APPROVED the design** as sound/generic; all REQUEST-CHANGES items fixed
  (doc text, prettier, doc-headers DH003/DH004, `organizeImports`). `unit`/`static` were **mine** (not
  pre-existing) and are fixed locally; CI re-running on 1aa447a7. Superseded old-design Cogni test
  block purged (−408 lines) with CEO consent.
- **Proven locally:** one run (gpt-5.6-luna) gathered deeply (26 `knowledge_read`, 14 `work_item_read`,
  8 search, 8 contrib_read, goals) and made a **real `core__edo_decide` call** with a grounded,
  goal-cited Top-5. authz **allowed** (`v0_collaborate`).
- **BLOCKED — the write did not persist.** The EDO write hit a Doltgres branch-session recovery error
  (`commitHash: null`, "do not replay, inspect dolt-op/…") under **concurrency** (the manual run raced
  the seeded schedules). Clean rollback, no corruption. The path has 63 prior successes single-threaded.
  The CEO's point stands: a web service must handle 2 concurrent EDO writes — this is a real
  knowledge-store defect, not local noise.

## Design / Implementation Target

1. **One generic engine, no bespoke/model-specific logic.** Keep `createCogniProgram` as the single
   factory; `cogni` + `work-prioritizer` are program-variant aliases of it. Do **not** add per-model
   fallbacks. The dedicated `decide` state (native forced `core__edo_decide`) is the approved shape.
2. **Decide WHERE it lives — operator vs node-template.** story.5116 scope is node-template-first, then
   operator adopts the published package. It was built/iterated in **operator** `packages/langgraph-graphs`
   (`private: true`, unpublished). Resolve with the CEO: should the engine be authoritative in
   node-template (story.5101) + published (publish-shared-runtime-core), with operator adopting it? The
   propagation rung is **untouched**.
3. **Fix the concurrent-EDO-write defect** (knowledge-store Doltgres branch-session). This blocks the
   "files an EDO" E2E and the scheduled two-tick Done-when. Likely serialize-shared-substrate-promotions
   class. File/own it; do not shrink the Done when to dodge it.
4. **Write the as-built harness design to the hub** (fill the `agent-harness-program-tiers` 404), so the
   two-phase gather→decide engine has one owning design entry. ASD-STE100, refine-in-place.
5. **Finish the convergence:** remove the dead `createWorkPrioritizerGraph` + `cycleScores`; consciously
   accept/retarget the `ai.work_prioritizer.cycle` telemetry-shape change (now carries `cogniTelemetry`).
6. **Must not regress:** compiled StateGraph stays langgraph-dev-transparent; host-owned `sourceContext`
   never model-chosen; fail-closed identity; human-only hub merge; merge via operator `POST /vcs/merge`.

## Next Actions / Risks

- [ ] Re-align with the CEO on #2 (operator vs node-template) and #3 (concurrency bug scope) **before**
      more code — these are the two things that lost trust (built in the wrong place? / ignored a real bug).
- [ ] Re-confirm CI green at 1aa447a7; get a fresh re-approve at head; flight via operator; prove the
      persisted decision on candidate; `/validate-candidate`.
- [ ] Write the harness design to the hub (#4) and finish the convergence (#5).
- **Trust note:** the prior session flip-flopped the graph design (B→A→fallback→dedicated-decide),
  mis-diagnosed CI reds as "pre-existing" when they were its own, and kept stopping on false gates. Move
  in smaller proven steps; answer the CEO's actual question, not a pedantic reframe.
- **Risk:** long runs (>~4 min) get socket-cut; use async submit/read, not a blocking curl.
- **Risk:** `pnpm packages:build` + a stale turbopack cache can wedge the dev app (`async_hooks` bundling
  error); fix = `rm -rf nodes/operator/app/.next/dev` then restart `pnpm dev`.
