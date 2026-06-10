---
name: agent-infrastructure-expert
description: Authoritative map of Cogni's AI-agent infrastructure — the substrate that turns a LangGraph graph into a billed, observed, durably-orchestrated, deployable production agent. Use when designing/debugging the graph execution path (InProc vs LangGraph Server), the build-ship-run topology (what's in the app image, how the Temporal worker reaches a graph), evals, or deciding which spec in the sprawling agent/langgraph cluster is authoritative. Routes graph-authoring mechanics to agent-development.md and tool-authoring to tools-authoring.md; this skill owns the infrastructure altitude above them. For all dated status (what's built, InProc↔Server alignment, doc DRY/drift) see agent-infrastructure-scorecard. Triggers — "how does a graph actually run in prod", "agent CI/CD", "does a new graph rebuild the worker", "InProc vs Server", "GraphExecutorPort", "where do evals stand", "which agent spec is canonical", "graph execution topology".
---

# Agent Infrastructure Expert

You own the **infrastructure altitude** of Cogni agents: how a LangGraph graph becomes a production-grade, billed, observable, durably-orchestrated, deployed agent. Graph _authoring_ (factory/prompts/tools/catalog) is one tier below you — route it to `agent-development.md`. You answer: where does it run, what ships it, how is it billed/observed, and is the eval gate real.

> **Stable skill, living scorecard.** This file holds the mental model and rules that don't move. All dated status — InProc↔Server alignment, built-vs-designed, doc DRY/drift/consolidation, doc-map staleness — lives in [`agent-infrastructure-scorecard`](../agent-infrastructure-scorecard/SKILL.md). **When reality moves, update the scorecard, not this skill.**

## Mental Model — Four Planes

| Plane                  | What it does                                                                                                                       | Canonical doc                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Author**             | Write the graph: pure factory, prompts, `toolIds`, catalog entry, `cogni-exec.ts` entrypoint                                       | [`langgraph-patterns.md`](../../../docs/spec/langgraph-patterns.md) + [`agent-development.md`](../../../docs/guides/agent-development.md)   |
| **Execute**            | Run it behind one `GraphExecutorPort` — billing, credit-preflight, observability, ALS, tool-allowlist decorators, all applied once | [`graph-execution.md`](../../../docs/spec/graph-execution.md)                                                                               |
| **Orchestrate + Ship** | Temporal triggers it durably; the graph rides the node app image and runs in-proc; the worker reaches it over HTTP                 | [`unified-graph-launch.md`](../../../docs/spec/unified-graph-launch.md) + [`temporal-patterns.md`](../../../docs/spec/temporal-patterns.md) |
| **Evaluate**           | Score graphs after deploy; gate promotion on quality                                                                               | [`proj.ai-evals-pipeline.md`](../../../work/projects/proj.ai-evals-pipeline.md) + [`ai-evals.md`](../../../docs/spec/ai-evals.md)           |

_(Per-plane build status → scorecard.)_

## Build → Ship → Run Topology (the load-bearing truth)

There is **no separate graph artifact, and the graph package never reaches the Temporal worker.** Verified from code + catalog:

1. **Graph code ships inside the node app image.** `nodes/<node>/app` depends on `@cogni/<node>-graphs` → `@cogni/langgraph-graphs` (`workspace:*`); Next.js bundles them. Adding a graph = affected-only rebuild of the **app** target(s) in `pr-build.yml`. **New graph ⇒ app rebuild only — never a worker rebuild** (`scheduler-worker` is its own `type: service` catalog target with zero graph deps).
2. **The Temporal worker holds no graph code, no DB creds, no LLM keys** (`SHARED_COMPUTE_HOLDS_NO_DB_CREDS`, task.0280). It is a lean durable dispatcher.
3. **The app IS the executor.** Worker activity → `POST {nodeUrl}/api/internal/graphs/:graphId/runs` (bearer `SCHEDULER_API_TOKEN`, `Idempotency-Key`, `nodeId`→URL via `COGNI_NODE_ENDPOINTS`) → the node app runs the graph in-proc via `createScopedGraphExecutor().runGraph()` and pumps events to Redis→SSE (`EXECUTION_VIA_SERVICE_API`).

```
Temporal (schedule/webhook) → GraphRunWorkflow ─HTTP─► node app /api/internal/graphs/:id/runs
   orchestrate (no graph code)                          execute in-proc (graph in image) → Redis → SSE
```

**Known seam (the one B-grade edge):** the worker activity is a synchronous `await fetch()` that blocks for the _entire_ graph and reads the decision body. The expensive, long-running, least-idempotent unit (the LLM graph) executes **outside Temporal's durability** — app crash mid-graph re-runs the whole graph (re-burns tokens), and a multi-minute sync HTTP call is exposed to ingress/LB idle timeouts. Deliberate and documented (graphs return _recomputable_ decision artifacts; material writes happen in post-graph Activities; resume/checkpoint is a named P1 deferral). **Fine for short governance/PR-review graphs; harden to async-start→signal (or a LangGraph checkpointer) before any minutes-long agent rides it.**

## Operating Rules

- **Recall before designing.** This space is dense and partly stale — read the canonical few (scorecard's doc map) before proposing anything; refine in place over adding a parallel doc (sprawl is the standing problem).
- **One executor.** All AI execution flows through `GraphExecutorPort.runGraph()`. No bypass paths. Billing/observability/credit are decorators applied once in app bootstrap — never re-implement them in the worker.
- **`NO_LANGCHAIN_IN_SRC`.** `@langchain/*` only in `packages/langgraph-graphs/**`. App `src/**` must not import graph packages (dependency-cruiser enforced for the Server boundary).
- **Writes behind Temporal.** Graphs return recomputable decision artifacts; material/external writes live in post-graph Activities with business-key idempotency.
- **`graph-execution.md` is the invariant SSOT.** Other specs link to it; they must not restate `GraphExecutorPort` / `AiEvent` / `PACKAGES_NO_SRC_IMPORTS` definitions.
- **Don't overstate the eval gate.** Nothing currently scores or blocks on graph quality. Treat "eval gate" as roadmap, not a control.
- **CICD docs are HELD until the pipeline is green.** No consolidation edits to `ci-cd.md` / `cd-pipeline-*` / `legacy-cicd-to-remove.md`.
