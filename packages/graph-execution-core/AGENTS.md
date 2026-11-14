# graph-execution-core · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Run lifecycle and orchestration contracts shared between the Next.js app, Temporal workers, and non-web launchers. Pure interfaces and types — no implementations, no I/O.

## Pointers

- [Unified Graph Launch Spec](https://node-template.cognidao.org/knowledge/graph-run-launch-contract): Core invariants and schema
- [Graph Execution Spec](https://node-template.cognidao.org/knowledge/graph-execution-invariants): Execution ports, billing, streaming
- [Packages Architecture](https://node-template.cognidao.org/knowledge/package-isolation-rules): Package boundaries

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

**External deps:** none. Internal deps: `@cogni/ai-core`.

## Public Surface

- **Exports:**
  - `GraphExecutorPort` — Port interface for graph execution: `runGraph(req, ctx?)`
  - `GraphRunRequest` — Pure business input (runId, graphId, messages, model, stateKey, toolIds)
  - `GraphRunResult` — Stream + promise returned by executor
  - `GraphFinal` — Result after graph completes (ok, usage, error)
  - `ExecutionContext` — Per-run cross-cutting metadata (actorUserId, sessionId, maskContent)
  - `RunStreamPort` — Pub/sub port for Redis Streams event transport
  - `RunStreamEntry` — Single entry in a run's event stream
  - `RUN_STREAM_*` — Stream configuration constants
- **Files considered API:** `index.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** none (defines port interfaces)

## Responsibilities

- This directory **does**: Define port interfaces, execution context type, stream constants, and domain types
- This directory **does not**: Implement execution, carry billing/tracing concerns, or depend on any adapter code

## Usage

```bash
pnpm --filter @cogni/graph-execution-core typecheck
pnpm --filter @cogni/graph-execution-core build
```

## Standards

- Per `NO_BILLING_LEAKAGE`: No billingAccountId, virtualKeyId, or billing types
- Per `NO_TRACING_LEAKAGE`: No traceId — flows via OTel context propagation
- Per `AI_CORE_ONLY_DEP`: Depends only on `@cogni/ai-core`

## Dependencies

- **Internal:** `@cogni/ai-core` (AiEvent, GraphId, AiExecutionErrorCode, Message)
- **External:** none

## Change Protocol

- Update this file when port interfaces or context types change
- Coordinate with https://node-template.cognidao.org/knowledge/graph-run-launch-contract invariants

## Notes

- GraphRunRequest carries only business input; billing/tracing resolved at app layer
- ExecutionContext is optional second arg to runGraph(), not on the request
- Consumers: `apps/operator`, `services/scheduler-worker`, `packages/scheduler-core`
