# graph-execution-host · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

PURE_LIBRARY package providing graph execution decorator infrastructure — billing enrichment, usage commit, observability tracing, preflight credit check, and namespace routing. Consumed by all node apps and future worker-local execution (task.0181).

## Pointers

- [Graph Execution Spec](https://node-template.cognidao.org/knowledge/graph-execution-invariants)
- [Packages Architecture](https://node-template.cognidao.org/knowledge/package-isolation-rules)
- [GraphExecutorPort](../graph-execution-core/src/graph-executor.port.ts)

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

**Internal deps:** `@cogni/ai-core`, `@cogni/graph-execution-core`, `@cogni/node-shared`.

## Public Surface

- **Exports:** BillingEnrichmentGraphExecutorDecorator, UsageCommitDecorator, ObservabilityGraphExecutorDecorator, PreflightCreditCheckDecorator, NamespaceGraphRouter
- **Port types:** LoggerPort, TracingPort, BillingIdentity, CommitUsageFactFn, PreflightCreditCheckFn, PlatformCreditChecker, GetTraceIdFn, CreateTraceWithIOParams, ObservabilityDecoratorConfig

## Responsibilities

- This directory **does**: Provide decorator implementations for billing, observability, and credit enforcement around GraphExecutorPort. Define minimal port interfaces satisfied by app implementations via structural typing.
- This directory **does not**: Read environment variables, manage process lifecycle, implement LLM adapters, or contain graph execution providers. Factory composition and provider registration remain app-local.

## Standards

- PURE_LIBRARY: No env vars, no process lifecycle, no @/ imports
- NO_SRC_IMPORTS: Never imports @/ or src/ paths
- Port interfaces are minimal projections of app-local ports (structural typing, not inheritance)
- No pino, @opentelemetry/api, or node:crypto runtime dependencies

## Dependencies

- **Internal:** @cogni/ai-core, @cogni/graph-execution-core, @cogni/node-shared
- **External:** none (all injected via port interfaces)

## Notes

- Follow-up: extend ObservabilityGraphExecutorDecorator unit tests to the 4 terminal states (node-attribution covered in `observability-executor.decorator.spec.ts`)
- Follow-up: export Message from @cogni/ai-core barrel to eliminate PreflightCreditCheckFn cast in factories

## Change Protocol

- Update this file when **Exports** or **Dependencies** change
- Ensure `pnpm check` passes (includes arch:check for boundary violations)
