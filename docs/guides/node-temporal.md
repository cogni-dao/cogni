---
id: guide.node-temporal
type: guide
title: Building recurring & AI workflows in a node
status: draft
trust: draft
summary: "How a node-template node builds recurring and AI workflows on the shared Temporal substrate. The default needs NO node worker: AI work that fits in one graph run is scheduled through GraphRunWorkflow; plain crons are routes. Durable multi-step and human-in-the-loop composition is roadmap work, with per-node workers only as a rare escape hatch."
read_when: "You are a node dev adding scheduled, recurring, AI, or human-in-the-loop work to a node; deciding graph vs route vs own-worker; or wondering whether you need a Temporal worker."
owner: derekg1729
created: 2026-06-18
verified: 2026-06-18
tags: [temporal, langgraph, node-template, scheduling, guide]
---

# Building recurring & AI workflows in a node

Temporal is a provisioned substrate ([substrate-temporal.md](../spec/substrate-temporal.md)).
**One shared worker** runs generic workflows and dispatches the work **into your node**.
You almost never run your own worker — you write a **graph** or a **route**.

## Pick your tier

| You're building…                                                                                                 | You write…                                      | Needs a node worker?        |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------- |
| **AI work that fits inside one run** (ingest → reason → score → branch)                                          | a **LangGraph graph** in your `graphs/` package | **No** — schedule the graph |
| **plain recurring job** (no AI, e.g. metrics ingest)                                                             | a **route** (`defineScheduledJob`)              | **No**                      |
| **durable multi-step / human-in-the-loop** (state between graph runs, approvals, long waits, cross-crash resume) | a **generic durable step-list engine**          | **No by default** — roadmap |
| **custom durable orchestration** the generic engine cannot express                                               | a **Temporal workflow** on your **own worker**  | **Yes** — rare escape hatch |

The first two are the default and the substrate already runs them. Durable composition
between runs is not solved by pretending one graph is the whole answer; it is the roadmap
tier below.

## Default — AI work is a graph (no worker)

If the work can complete inside one graph run, keep the AI pipeline **inside one LangGraph
graph** — LangGraph already handles steps, branching, tools, and loops within that run.
Schedule the graph; the shared worker runs it via `GraphRunWorkflow`, dispatched into your
node's own runtime. Billed + tenant-scoped via `GraphExecutorPort` (per-user
`ExecutionGrant`, RLS). See [langgraph-patterns.md](../spec/langgraph-patterns.md).

```ts
// nodes/<node>/graphs — your node owns this. "300 workflows" = 300 graphs.
export const growthLoop =
  compileGraph(/* ingest → analyze (LLM) → score → draft (LLM) */);
// then schedule it (cron) → GraphRunWorkflow runs it. No worker, no Temporal code.
```

## Default — plain cron is a route (no worker)

```ts
export const metricsIngest = defineScheduledJob({
  id: "metrics-ingest",
  cron: "*/15 * * * *",
  run: async (ctx) => {
    /* the work, inline — no route file, no token, no workflow */
  },
});
```

### beacon walkthrough (v0)

beacon's v0 growth loop is **one graph run** (`ingest engagement → AI summarize → score →
AI draft`) scheduled on a cron. The shared worker fires it; it runs in beacon; results land
in beacon's DB + Loki. No beacon worker, no Temporal authoring, no operator call. This is
the lossy v0 shape, not the durable multi-step/HITL engine.

## Roadmap — durable multi-step and HITL (generic engine, NO per-node worker)

The moment a workflow must carry durable state **between** graph/route steps, or **pause for a
human** (approval, review) across hours or days, a single graph run is the wrong tool. But
this does **not** require a worker per node.

The target is **one generic durable workflow engine on the shared worker** that interprets a
node-supplied step list — `run graph → await human signal → run graph → branch` — where:

- the **human-wait** (`signal` + `await condition`, durable across days and crashes) is
  generic Temporal mechanics, identical for every node — it lives in the shared worker;
- the **node-specific work** (the AI step, the approval surface) is **dispatched into the
  node** (graph run / route), exactly as today;
- a node defines its HITL workflow as **data** (a step list), not Temporal code — like an
  n8n flow. No node worker, no shared-worker redeploy per workflow.

- **Status:** roadmap, arriving soon (HITL shows up fast).
- A **per-node worker** drops to the genuine last resort — only for arbitrary custom durable
  logic the generic engine's step types can't express. Rare; opt-in.

## Later — AI off the app

When InProc graph load on the node app gets heavy, the LangGraph **Server** executor moves
AI execution to a separate runtime (compute isolation + scale). Same graphs, different
executor. Roadmap.

## The rules (hold inside your node)

- `SCHEDULES_OVER_CRON`, `CRUD_AUTHORITY` (app owns create/pause/delete), `TEMPORAL_DETERMINISM`,
  `ACTIVITY_IDEMPOTENCY` — see [temporal-patterns.md](../spec/temporal-patterns.md).
- AI runs **inside graphs/activities**, never in workflow code.
- Dispatch is at-most-once (`maximumAttempts: 1`) for v0 — make routes idempotent.

## References

- [substrate-temporal.md](../spec/substrate-temporal.md) — the shared-worker substrate + roadmap.
- [langgraph-patterns.md](../spec/langgraph-patterns.md) — how graphs are built + executed (the AI layer).
- [temporal-patterns.md](../spec/temporal-patterns.md) — Temporal build rules + the generic workflows.
