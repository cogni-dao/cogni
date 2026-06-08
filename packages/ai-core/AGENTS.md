# ai-core · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

**AI_CORE_IS_KERNEL:** The runtime kernel for AI graph execution. Contains executor-agnostic primitives, tool execution runtime, and minimal type helpers for cross-process communication. Defines `AiEvent`, `UsageFact`, `ExecutorType`, `RunContext`, `SourceSystem`, and the canonical `createToolRunner` pipeline. Used by Next.js app and all `GraphExecutorPort` adapters (InProc, LangGraph Server, Claude SDK).

## Pointers

- [LangGraph Server Spec](../../docs/spec/langgraph-server.md)
- [Graph Execution](../../docs/spec/graph-execution.md)

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

**External deps:** `json-schema` (types only), `zod`.
**Internal deps:** `@cogni/authorization-core` for the optional tool execution authorization port.

## Public Surface

- **Exports:**
  - `AiEvent` - Union of streaming event types (text_delta, usage_report, assistant_final, done, error)
  - `TextDeltaEvent`, `UsageReportEvent`, `AssistantFinalEvent`, `DoneEvent`, `ErrorEvent` - Individual event types
  - `RunFinalSummary` - Terminal usage + finishReason shape (shared by DoneEvent, Redis terminal event, facade accumulator)
  - `ToolCallStartEvent`, `ToolCallResultEvent` - Tool execution events
  - `UsageFact` - Billing fact emitted per LLM call; inner executors may emit neutral facts and wrapper layers attach billing identity before validation
  - `UsageFactStrictSchema` - Zod schema for billing-authoritative executors (inproc/sandbox; usageUnitId required)
  - `UsageFactHintsSchema` - Zod schema for external/telemetry executors (usageUnitId optional)
  - `ExecutorType` - Executor discriminator ("langgraph_server" | "claude_sdk" | "inproc" | "sandbox")
  - `RunContext` - Run identity provided to relay subscribers
  - `SourceSystem`, `SOURCE_SYSTEMS` - Billing source system enum
  - `ToolSpec` - Canonical tool definition (JSONSchema7 inputSchema)
  - `ToolInvocationRecord` - Tool execution record (timing, result, error)
  - `ToolRedactionConfig` - Redaction config for tool output
  - `createToolRunner` - Canonical tool execution pipeline (policy enforcement, optional AuthorizationPort check, validation, redaction)
  - `ToolPolicy`, `createToolAllowlistPolicy`, `DENY_ALL_POLICY` - Tool policy interface and helpers
  - `BoundToolRuntime` - Minimal runtime interface (no Zod dependency)
  - `ToolSourcePort` - Port interface for tool sources (static, MCP)
  - `StaticToolSource`, `createStaticToolSource`, `createStaticToolSourceFromRecord` - Static tool source implementation
  - `AiSpanPort` - Observability interface for tool span instrumentation
  - `AiExecutionErrorCode`, `AI_EXECUTION_ERROR_CODES` - Canonical error codes and runtime array
  - `AiExecutionError`, `isAiExecutionError` - Structured error class and type guard
  - `isAiExecutionErrorCode`, `normalizeErrorToExecutionCode` - Validation and normalization utilities
  - `LlmError`, `LlmErrorKind`, `isLlmError`, `classifyLlmErrorFromStatus` - LLM adapter error types
  - `GraphId` - Namespaced graph identifier type (format: `${providerId}:${graphName}`)
  - `GraphRunConfig` - Per-run config passed via RunnableConfig.configurable (model, toolIds, etc.)
  - `ToolExecFn`, `ToolExecResult` - Tool execution function signature and result types
- **Files considered API:** `index.ts`, `events/*.ts`, `usage/*.ts`, `context/*.ts`, `billing/*.ts`, `tooling/*.ts`, `tooling/ports/*.ts`, `tooling/sources/*.ts`, `execution/*.ts`, `graph/*.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** none

## Responsibilities

- This directory **does**: Define cross-process AI event, billing, and error types; provide type guards and error normalization utilities; implement the canonical tool execution pipeline (createToolRunner)
- This directory **does not**: Make I/O calls, depend on src/, import LangChain/Langfuse SDKs, perform observability scrubbing (that's adapter responsibility)

## Usage

```bash
pnpm --filter @cogni/ai-core typecheck
pnpm --filter @cogni/ai-core build
```

## Standards

- Types and minimal runtime utilities (type guards, error class, normalization, tool-runner)
- All exports must work in both browser and Node.js
- SINGLE_SOURCE_OF_TRUTH: These types must NOT be redefined elsewhere
- ERROR_NORMALIZATION_ONCE: normalizeErrorToExecutionCode() is the canonical normalizer
- SPAN_METADATA_ONLY: tool-runner emits metadata-only spans; adapters provide scrubbing via spanInput/spanOutput hooks

## Dependency Policy

**Allowed:** `zod` (GraphRunConfig validation), `json-schema` (types), `@cogni/authorization-core` (authz port contract)

**Forbidden:** `@langchain/*`, `langfuse`, `@cogni/ai-tools` (ai-core defines interfaces; ai-tools implements)

**Future:** Post-MVP, consider `ai-core-primitives` (pure types) vs `ai-core-runtime` (Zod, tool-runner) split.

## Dependencies

- **Internal:** `@cogni/authorization-core`
- **External:** `zod` (runtime), `json-schema` (types)

## Change Protocol

- Update this file when public exports change
- Changes require updating `src/types/` re-export shims
- Coordinate with LANGGRAPH_SERVER.md invariants

## Notes

- Per SINGLE_SOURCE_OF_TRUTH invariant: `src/types/` files re-export from this package
- Per PACKAGES_NO_SRC_IMPORTS: This package cannot import from `src/**`
- Package isolation enables LangGraph Server to import these types without Next.js deps
