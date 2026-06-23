---
id: graph-execution-spec
type: spec
title: Graph Execution Design
status: draft
spec_state: draft
trust: draft
summary: Unified graph execution via GraphExecutorPort — billing, idempotency, streaming, and provider aggregation.
read_when: You are working on graph execution, billing, streaming, or adding a new graph/adapter.
implements:
owner: derekg1729
created: 2026-01-29
verified: 2026-03-18
tags: [ai-graphs, billing, streaming]
---

# Graph Execution Design

> [!CRITICAL]
> All graph execution flows through `GraphExecutorPort`. Billing is run-centric with idempotency enforced by `(source_system, source_reference)` where `source_reference` includes `run_id/attempt`.

## Context

The graph execution system unifies all AI execution paths (in-proc LangGraph, Claude SDK, n8n, sandboxed agents) behind a single `GraphExecutorPort` interface. This enables consistent billing, telemetry, and streaming regardless of the underlying execution engine. Billing is run-centric with idempotency enforced at the database level.

## Goal

Provide a single execution interface (`GraphExecutorPort.runGraph()`) that all graph types flow through, with unified billing via `UsageFact`, provider-agnostic streaming via `RunEventRelay`, and idempotent charge recording via `(source_system, source_reference)`.

## Non-Goals

- Runtime graph discovery/registration (P1/P2 — static catalog in P0)
- Thread/run-shaped API primitives (`createThread()`, `createRun()`, `streamRun()`) — provider-internal in P0
- Per-graph constructor arguments — graphs export compiled artifacts, runtime config via `configurable`

## Core Invariants

1. **UNIFIED_GRAPH_EXECUTOR**: All graphs (in-proc LangGraph, Claude SDK, future n8n/Flowise) execute via `GraphExecutorPort.runGraph()`. No execution path bypasses this interface.

2. **ONE_LEDGER_WRITER**: Only `billing.ts` can call `accountService.recordChargeReceipt()`. Enforced by depcruise rule + stack test.

3. **IDEMPOTENT_CHARGES**: `idempotency_key = ${run_id}/${attempt}/${usage_unit_id}`. Stored in `source_reference`. DB unique constraint on `(source_system, source_reference)`. Adapters own `usage_unit_id` stability.

4. **RUN_SCOPED_USAGE**: `UsageFact` includes `run_id` and `attempt`. Billing ingestion uses these for attribution and idempotency.

5. **GRAPH_LLM_VIA_COMPLETION**: In-proc graphs (executed via `InProcCompletionUnitAdapter`) call `completion.executeStream()` for billing/telemetry centralization. External adapters emit `UsageFact` directly.

6. **GRAPH_FINALIZATION_ONCE**: Graph emits exactly one `done` event and resolves `final` exactly once per run attempt.

7. **USAGE_REPORT_AT_MOST_ONCE_PER_USAGE_UNIT**: Adapter emits at most one `usage_report` per `(runId, attempt, usageUnitId)`. Adapters may emit 1..N `usage_report` events per run depending on execution granularity (see MVP Invariants). DB uniqueness constraint is a safety net, not a substitute for correct event semantics.

8. **BILLING_INDEPENDENT_OF_CLIENT**: Billing validation and eventual commit occur server-side regardless of client connection state. `BillingGraphExecutorDecorator` intercepts enriched `usage_report` events during stream iteration; the caller MUST drain the stream to completion for billing to fire. UI path: `RunEventRelay.pump()` drains to completion regardless of UI disconnect. Scheduled path: `for await` drain in route handler. `stream-drain-enforcement.stack.test.ts` enforces this obligation at all call sites.

8a. **BILLING_ENFORCED_AT_PORT**: Billing is enforced by per-run decorators wrapping `GraphExecutorPort` in bootstrap. `createGraphExecutor()` builds the static inner router. `createScopedGraphExecutor()` adds billing enrichment, billing validation, preflight, and observability for one run. `RunEventRelay` remains a pure UI stream adapter with no billing responsibility.

8b. **CREDITS_ENFORCED_AT_EXECUTION_PORT**: `PreflightCreditCheckDecorator` wraps `GraphExecutorPort` between observability (outer) and billing validation (inner). Credit check runs eagerly in `runGraph()` and gates both stream consumption and `final` resolution. Launchers provide a `PreflightCreditCheckFn` to bootstrap, and bootstrap binds the canonical billing account ID for the run. Rejected runs never reach billing validation.

8c. **BILLING_IDENTITY_OUTSIDE_INNER_EXECUTOR**: Inner providers and stream translators emit neutral `usage_report` facts without `billingAccountId` or `virtualKeyId`. Billing identity is attached by a per-run enrichment decorator in the bootstrap wrapper layer before receipt validation/commit. AsyncLocalStorage no longer carries billing identity for usage-fact emission or wrapper composition, but some providers still use tenant-scoped billingAccountId from ALS for thread/session behavior.

9. **P0_ATTEMPT_FREEZE**: In P0, `attempt` is always 0. No code path increments attempt. Full attempt/retry semantics require run persistence (P1). The `attempt` field exists in schema and `UsageFact` for forward compatibility but is frozen at 0.

10. **RUNID_IS_CANONICAL**: `runId` is the canonical execution identity. `ingressRequestId` is optional delivery-layer correlation (HTTP/SSE/worker/queue). P0: they coincidentally equal (no run persistence). P1: many `ingressRequestId`s per `runId` (reconnect/resume). No business logic relies on `ingressRequestId == runId`. Never use `ingressRequestId` for idempotency.

11. **BILLABLE_AI_THROUGH_EXECUTOR**: Production code paths that emit `UsageFact` must execute via `AiRuntimeService` → `GraphExecutorPort` (or the `completionStream` facade, which starts the same billed `GraphRunWorkflow`). The raw `LlmService` port (`@/ports/llm.port`) is **executor-internal**: it carries no preflight credit gate and no usage-receipt commit (those live in the decorator stack — `PreflightCreditCheckDecorator` + `UsageCommitDecorator`), so direct consumption bypasses fair billing. Its only sanctioned consumers are `features/ai/services/completion.ts` (`executeStream`) and the in-proc completion adapter. `LlmService` exposes only `completionStream` — the non-streaming `completion()` was removed (bug.5042) because it silently post-billed with no credit pre-check; non-streaming callers drain the stream and `await final`. The fence (`executeStream`, `completionStream`, and reintroduction of `completion()`) is enforced by stack test (`no-direct-completion-executestream.stack.test.ts`). **Exception:** platform/system-billed calls (not end-user) require explicit human sign-off and still route through the executor bound to a system billing account — no path skips the executor.

12. **P0_MINIMAL_PORT**: P0 `GraphExecutorPort` exposes `runGraph()` only. Discovery is via separate `AgentCatalogPort.listAgents()`. Thread/run-shaped primitives (`createThread()`, `createRun()`, `streamRun()`) are provider-internal in P0; promote to external port in P1 when run persistence lands. `GraphRunRequest.stateKey` is optional on the port; semantics are adapter-specific (InProc ignores; LangGraph Server requires).

13. **DISCOVERY_NO_EXECUTION_DEPS**: Discovery providers do not require execution infrastructure. `AgentCatalogProvider` implementations read from catalog but cannot execute. Routes use discovery factories, not execution factories.

14. **COMPLETION_UNIT_NOT_PORT**: `InProcCompletionUnitAdapter` is a `CompletionUnitAdapter`, not a `GraphExecutorPort`. It provides `executeCompletionUnit()` for providers but does not implement the full port interface.

15. **GRAPH_ID_NAMESPACED**: Graph IDs are globally unique and stable, namespaced as `${providerId}:${graphName}` (e.g., `langgraph:poet`, `claude_agents:planner`).

16. **ROUTING_BY_NAMESPACE_ONLY**: `NamespaceGraphRouter` parses `graphId.split(":")[0]` once, looks up `Map<string, GraphExecutorPort>`. Providers implement `GraphExecutorPort` directly — no intermediate `GraphProvider` interface. App uses only the router; no facade-level graph conditionals.

17. **CATALOG_COMPILED_EXPORTS**: Catalog entries reference compiled graphs (no constructor args). Runtime config passes via `RunnableConfig.configurable`. Providers invoke compiled graphs; they do not inject LLM/tools at construction.

18. **NO_LANGCHAIN_IN_ADAPTERS_ROOT**: LangChain imports are isolated to `src/adapters/server/ai/langgraph/**`. Other adapter code must not import `@langchain/*`.

19. **TOOL_EXEC_TYPES_IN_AI_CORE**: `ToolExecFn`, `ToolExecResult`, `EmitAiEvent` are canonical in `@cogni/ai-core`. `src/ports` re-exports. Adapters import from `@cogni/ai-core` or `@/ports`.

20. **FANOUT_LOSSINESS**: StreamDriver fans out to subscribers with different guarantees:
    - **Billing subscriber**: Bounded queue with backpressure; if queue fills, driver blocks (never drops billing events). P1: durable spill to worker.
    - **UI subscriber**: Bounded queue, may disconnect; driver continues regardless. Best-effort delivery.
    - **History subscriber**: Bounded queue, may drop on backpressure. Best-effort cache.

21. **USAGE_UNIT_ID_MANDATORY**: For billable paths, adapters MUST provide `usageUnitId` in `UsageFact`. The fallback path (generating `MISSING:${runId}/${callIndex}`) is an ERROR condition that logs `billing.missing_usage_unit_id` metric and must be investigated. This is NOT a normal operation path.

22. **CATALOG_STATIC_IN_P0**: P0 uses static catalog exported by `@cogni/langgraph-graphs`. Runtime graph discovery/registration is deferred to P1/P2. Adding a graph requires updating the package export, not runtime registration.

23. **GRAPH_OWNS_MESSAGES**: Graphs are the single authority for all messages they construct — system prompts, multi-node context, tool instructions, etc. The completion/execution layer (`executeStream`) must pass messages through unmodified — no filtering, no injection. Security filtering of untrusted client input (stripping system messages) happens at the HTTP/API boundary before `GraphExecutorPort.runGraph()` is called, not in the execution layer.

24. **SERVER_FIRST_PARITY**: Prove patterns on `langgraph dev` first. Server behavior is authoritative; InProc implements parity.

25. **CONFIGURABLE_IS_JSON**: `config.configurable` must be JSON-serializable (no functions, no object instances). Executors access non-serializable runtime context via `AsyncLocalStorage`.

26. **TOOLS_BY_ID**: `configurable.toolIds: string[]` is a **capability allowlist**, not a registry lookup. Tool schemas are bound at graph compile time; `toolIds` gates which tools may execute at runtime. `toLangChainTool` wrapper checks this allowlist and returns `policy_denied` (via existing `ToolExecResult`) if tool not in list. OAuth/MCP auth is resolved from ALS runtime context, never from configurable.

27. **EXECUTOR_OWNS_TRANSPORT**: Executor decides LLM routing (CogniCompletionAdapter vs ChatOpenAI). Graph code is transport-agnostic.

28. **RUNTIME_CONTEXT_VIA_ALS**: InProc runtime context (`completionFn`, `tokenSink`) accessed via `AsyncLocalStorage` per run, not global singleton.

29. **RUNID_SERVER_AUTHORITY**: `runId` is generated server-side at ingress. Client-provided `runId` is ignored. No `runId` reuse in P0. This is required for idempotency and attempt-freeze safety.

30. **NO_SECRETS_IN_CONFIGURABLE_OR_CONTEXT**: `configurable` and ALS context must never contain raw secrets (API keys, tokens, credentials). Only opaque reference IDs (e.g., `virtualKeyId`, `connectionId`). Secrets resolved from secure store inside tool runner/runtime at execution time.

31. **BILLING_BOUNDED_BACKPRESSURE**: Billing subscriber uses bounded queue. If backpressure occurs, driver blocks (preserving lossless guarantee) rather than unbounded memory growth. P1: durable event spill or worker-based ingestion.

32. **CONNECTION_IDS_ARE_REFERENCES**: `GraphRunRequest` may carry `connectionIds?: readonly string[]` (P1). These are opaque references resolved by Connection Broker at tool invocation. Per #30, no credentials in request. Per TOOL_USE_SPEC.md #26, same auth path for all tools. See [tenant-connections.md](tenant-connections.md).

33. **UNIFIED_INVOKE_SIGNATURE**: Both adapters (InProc, LangGraph Server) call `graph.invoke(input, { configurable: GraphRunConfig })` with identical input/config shapes. Wiring (LLM, tools) is centralized in shared entrypoint helpers, not per-graph bespoke code.

34. **NO_PER_GRAPH_ENTRYPOINT_WIRING**: Entrypoint logic (LLM creation, tool binding, ALS setup) is implemented once in shared helpers (`createServerEntrypoint`, `createInProcEntrypoint`) and reused by all graphs. Graphs export pure factories only. This prevents drift into two graph ecosystems.

35. **NO_MODEL_IN_ALS**: Model MUST NOT be stored in ALS. Model comes from `configurable.model` only. ALS holds non-serializable deps (functions, sinks), not run parameters.

36. **ALS_ONLY_FOR_NON_SERIALIZABLE_DEPS**: Run-scoped ALS contains ONLY: `completionFn`, `tokenSink`, `toolExecFn`. Never: `model`, `toolIds`, or other serializable config values.

37. **MODEL_READ_FROM_CONFIGURABLE_AT_RUNNABLE_BOUNDARY**: Model resolution happens in `Runnable.invoke()`, reading directly from `config.configurable.model`. Never resolve model inside internal methods (`_generate()`). This enables InProc to use a `Runnable`-based model (not `BaseChatModel`) that reads configurable at the correct boundary.

38. **NODE_KEYED_CONFIG_VIA_FLAT_MAP**: Node-specific overrides use flat keys `<nodeKey>__model` and `<nodeKey>__toolIds` in configurable. Resolution: `configurable[nodeKey__field] ?? configurable[field]`. This keeps configurable JSON-serializable and avoids nested structures that complicate adapter translation.

39. **SHARED_RESOLVERS_FOR_NODE_CONFIG**: Model and toolIds resolution uses shared functions `resolveModel(configurable, nodeKey?)` and `resolveToolIds(configurable, nodeKey?)`. Both `CogniCompletionAdapter` and tool wrappers use these resolvers—no duplicate resolution logic.

40. **NODE_KEY_PROPAGATION**: Nodes that need specific config must receive `nodeKey` at construction and pass it through to LLM/tool invocations. Graph factories are responsible for wiring nodeKey; runtime just resolves.

### External Executor Billing (41-47)

See [external-executor-billing.md](external-executor-billing.md) for full design.

41. **END_USER_CORRELATION**: External executors set `configurable.user = ${runId}/${attempt}` server-side. LiteLLM stores as `end_user`. Reconciler queries by `end_user`.

42. **USAGE_UNIT_IS_PROVIDER_CALL_ID**: `usageUnitId = spend_logs.request_id`. Multiple charge_receipts per run expected for multi-step graphs.

43. **SERVER_SETS_USER_NEVER_CLIENT**: Provider overwrites any client-supplied `configurable.user`. Prevents billing spoofing.

44. **RECONCILE_AFTER_STREAM_COMPLETES**: Reconciliation triggers after stream ends. No grace window for MVP.

45. **STREAM_EVENTS_ARE_UX_ONLY**: External executor `usage_report` events are telemetry hints only. Authoritative billing via reconciliation.

46. **RECONCILER_VIA_COMMIT_USAGE_FACT**: Reconcilers MUST call `commitUsageFact()`. ONE_LEDGER_WRITER applies.

47. **CONFIGURABLE_USER_IN_SERVER_ENTRYPOINT**: `initChatModel` must include `"user"` in `configurableFields` for external executors.

### MVP Invariants (trusted graph execution)

These invariants govern trusted graph execution (no reconciliation needed) like in-proc LangGraph and sandboxed agents:

- **GRAPH_FINALIZATION_ONCE**: Exactly one `done` per runId; completion-units never emit `done`.
- **USAGE_UNIT_GRANULARITY_ADAPTER_DEFINED**: Adapters emit 1..N `usage_report` events per run. InProc emits per-completion-unit (`usageUnitId=litellmCallId`). External adapters (LangGraph Server, Claude SDK, n8n) emit one aggregate (`usageUnitId=provider_run_id` or `message.id`). `USAGE_REPORT_AT_MOST_ONCE_PER_USAGE_UNIT` prevents duplicates; billing handles any valid 1..N sequence.
- **USAGE_UNIT_IS_LITELLM_CALL_ID**: For trusted executors (inproc, sandbox), `usageUnitId` is captured from LiteLLM's `x-litellm-call-id` response header. This value equals `spend_logs.request_id` in LiteLLM's reconciliation API, enabling idempotent billing and forensic correlation. Manually verified 2026-02-07 against dev stack (`charge_receipts.litellm_call_id` matched `GET /spend/logs?request_id=`). Automated test: `tests/stack/ai/litellm-call-id-mapping.stack.test.ts` (skipped; requires system test infra, see `docs/spec/system-test-architecture.md`).
- **BILLING_SEAM_IS_EXECUTE_COMPLETION_UNIT**: No direct provider/LiteLLM SDK calls from langgraph graphs; all billable calls go through `executeCompletionUnit`.
- **REQUEST_ID_FLOW_REQUIRED**: `CompletionResult` must carry `requestId` (or define deterministic mapping) to satisfy `GraphFinal.requestId` + tracing.
- **MODEL_CONSISTENCY**: Model string must be the same through request→LiteLLM→`UsageFact.model`; never infer later.
- **NO_LANGCHAIN_IN_SRC**: `src/**` must not import `@langchain/*`; all LangChain conversions stay in `packages/langgraph-graphs`.
- **ERROR_NORMALIZATION**: Errors normalized to `timeout|aborted|internal` at GraphExecutor boundary (no freeform string leakage).
- **DOCS_MATCH_REALITY**: AGENTS.md/docs must be updated or explicitly marked stale to avoid churn.

### Compiled Graph Entrypoint Invariants

- **PURE_GRAPH_FACTORY**: `graph.ts` has no env/ALS/entrypoint wiring
- **ENTRYPOINT_IS_THIN**: `server.ts` and `cogni-exec.ts` are ~1-liners calling shared helpers
- **LANGGRAPH_JSON_POINTS_TO_SERVER_ONLY**: `langgraph.json` references `server.ts`, never `cogni-exec.ts`
- **NO_CROSSING_THE_STREAMS**: `core/` never imports `runtime/cogni/`; `cogni-exec.ts` never uses `initChatModel`/env

## Schema

**Evolve `charge_receipts`** (no new table):

**New columns:**

| Column    | Type | Notes               |
| --------- | ---- | ------------------- |
| `run_id`  | text | NOT NULL            |
| `attempt` | int  | NOT NULL, default 0 |

**Constraint changes:**

- Remove: `UNIQUE(request_id)`
- Add: `UNIQUE(source_system, source_reference)`

**Index changes:**

- Keep: non-unique index on `request_id` (for correlation queries)
- Add: index on `(run_id, attempt)` (for run-level queries and analytics)

**Column semantics:**

| Column             | Semantics                                                                 |
| ------------------ | ------------------------------------------------------------------------- |
| `source_system`    | Adapter source identifier (e.g., `'litellm'`, `'anthropic_sdk'`)          |
| `source_reference` | Idempotency key within source: `${run_id}/${attempt}/${usage_unit_id}`    |
| `run_id`           | Explicit column for joins/queries (duplicated from source_reference)      |
| `attempt`          | Explicit column for retry analysis (duplicated from source_reference)     |
| `request_id`       | Original request correlation; no longer unique; multiple receipts allowed |

**Why explicit columns?** Burying `run_id` and `attempt` only in `source_reference` makes queries hard. Explicit columns enable:

```sql
-- Easy: explicit columns
SELECT * FROM charge_receipts WHERE run_id = 'run123' AND attempt = 0;

-- Hard: parsing source_reference
SELECT * FROM charge_receipts WHERE source_reference LIKE 'run123/0/%';
```

**Why multiple receipts per request?** A graph can make N LLM calls. Each call = one receipt. Idempotency is now scoped to usage unit, not request.

**Adapter responsibility:** Each adapter must provide a stable `usage_unit_id` in `UsageFact`. Billing does not know or care how adapters derive this ID. See adapter-specific notes for mapping details.

## Design

### 1. GraphExecutorPort Scope

| Executor Type  | Adapter                       | LLM Path                    |
| -------------- | ----------------------------- | --------------------------- |
| **In-proc**    | `InProcCompletionUnitAdapter` | `completion.executeStream`  |
| **Claude SDK** | `ClaudeGraphExecutorAdapter`  | Direct to Anthropic API     |
| **n8n**        | Future adapter                | Via our LLM gateway (ideal) |

**Rule:** All graphs go through `GraphExecutorPort`. In-proc adapter wraps existing code; external adapters emit `UsageFact` directly.

### 2. Execution + Billing Flow

**Decorator stack** (outer → inner):

```
ObservabilityGraphExecutorDecorator    (Langfuse traces)
  └─ PreflightCreditCheckDecorator     (rejects runs with insufficient credits)
       └─ BillingGraphExecutorDecorator (intercepts usage_report → commitUsageFact)
            └─ NamespaceGraphRouter (routes by graphId namespace → Map<string, GraphExecutorPort>)
                 └─ providers...
```

**Call site wiring** (app layer creates closure, bootstrap composes the per-run executor):

```typescript
const preflightCheckFn: PreflightCreditCheckFn = (baId, model, msgs) =>
  preflightCreditCheck({
    billingAccountId: baId,
    messages: [...msgs],
    model,
    accountService,
  });
const executor = createGraphExecutor(
  executeStream,
  userId
);
const scopedExecutor = createScopedGraphExecutor({
  executor,
  billing,
  preflightCheckFn,
);
```

**Flow (both UI and scheduled paths):**

```
┌─────────────────────────────────────────────────────────────────────┐
│ Caller (AiRuntime or internal route handler)                         │
│ ──────────────────────────────────────────────                       │
│ 1. Create preflightCheckFn closure (app layer — CAN import features) │
│ 2. createGraphExecutor(streamFn, userId)                             │
│ 3. createScopedGraphExecutor({ executor, billing, checkFn, ... })   │
│ 4. executor.runGraph(request) → { stream, final }                    │
│ 4. Drain stream to completion (RunEventRelay.pump OR for-await)      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PreflightCreditCheckDecorator (adapters layer — DI only)              │
│ ──────────────────────────────────────────────                        │
│ - Runs credit check eagerly in runGraph() (before stream consumed)   │
│ - Rejected → InsufficientCreditsPortError to stream + final          │
│ - Passed → yield* upstream unchanged                                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ BillingEnrichmentGraphExecutorDecorator (adapters layer — DI only)   │
│ ──────────────────────────────────────────────                       │
│ - Wraps upstream stream with async generator                         │
│ - On usage_report → attach billingAccountId + virtualKeyId          │
│ - All other events → yield through unchanged                         │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ BillingGraphExecutorDecorator (adapters layer — DI only)             │
│ ──────────────────────────────────────────────                       │
│ - Wraps upstream stream with async generator                         │
│ - On usage_report → validate via Zod, continue                       │
│   (strict for inproc/sandbox; hints for external executors)          │
│ - All other events → yield through unchanged                         │
│ - usage_report events consumed — invisible to downstream             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ GraphExecutorAdapter (in-proc or external)                          │
│ ───────────────────────────────────────────                         │
│ - Emit AiEvents (text_delta, tool_call_*, usage_report, done)       │
│ - usage_report carries UsageFact with run_id/attempt/usageUnitId    │
│ - Resolve final with usage_totals                                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ BillingService (billing.ts) — never blocking                        │
│ ─────────────────────────────────────────                           │
│ - commitUsageFact(fact, context, accountService, log)                │
│ - Apply pricing policy: chargedCredits = llmPricingPolicy(costUsd)  │
│ - Compute source_reference = computeIdempotencyKey(fact)            │
│ - Call recordChargeReceipt with source_reference                    │
│ - DB constraint handles duplicates (no-op on conflict)              │
└─────────────────────────────────────────────────────────────────────┘
```

**Pricing policy:** `commitUsageFact()` applies the markup via `llmPricingPolicy.ts`. See [billing-evolution.md](billing-evolution.md) for credit unit standard (`CREDITS_PER_USD = 10_000_000`) and markup factor.

**Why wrapper-owned decorators?** The earlier design put too much billing composition in launchers. The current shape keeps the static provider router reusable while bootstrap owns per-run composition. Launchers pass billing and credit-check inputs once; bootstrap assembles enrichment, validation, preflight, and observability around the run.

**Why run-centric?** Graphs have multiple LLM calls. Billing must be attributed to usage units, not requests. Idempotency key includes run context to prevent cross-run collisions.

### 3. Idempotency Key Format

```
source_reference = "${run_id}/${attempt}/${usage_unit_id}"
```

**Note:** `source` is NOT duplicated in `source_reference` — the `source_system` column already identifies the source. This reduces entropy and simplifies queries.

**Full uniqueness:** `UNIQUE(source_system, source_reference)` enforces global uniqueness.

**Examples:**

| source_system   | source_reference   | Meaning                                      |
| --------------- | ------------------ | -------------------------------------------- |
| `litellm`       | `r1/0/call-abc123` | LiteLLM call (usage_unit_id = litellmCallId) |
| `anthropic_sdk` | `r2/0/msg_xyz`     | Claude SDK (usage_unit_id = message.id)      |
| `anthropic_sdk` | `r3/1/msg_abc`     | Claude SDK retry (attempt=1)                 |
| `external`      | `r4/0/run-456`     | External engine (usage_unit_id = run ID)     |

**Single computation point:** `computeIdempotencyKey(UsageFact)` — used by billing.ts only.

```typescript
// In billing.ts (functions not allowed in types layer)
function computeIdempotencyKey(fact: UsageFact): string {
  return `${fact.runId}/${fact.attempt}/${fact.usageUnitId}`;
}
```

### 4. UsageFact Type

```typescript
export interface UsageFact {
  // Required for idempotency key computation (usageUnitId resolved at commit time)
  readonly runId: string;
  readonly attempt: number;
  readonly usageUnitId?: string; // Adapter-provided stable ID; billing.ts assigns fallback if missing

  // Required for source_system column (NOT in idempotency key)
  readonly source: SourceSystem; // "litellm" | "anthropic_sdk" | ...

  // Billing identity may be attached by a wrapper before validation/commit
  readonly billingAccountId?: string;
  readonly virtualKeyId?: string;

  // Required executor type
  readonly executorType: ExecutorType; // "langgraph_server" | "claude_sdk" | "inproc"

  // Optional provider details
  readonly provider?: string;
  readonly model?: string;

  // Optional usage metrics
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;

  // Raw payload for debugging (adapter can stash native IDs here)
  readonly usageRaw?: Record<string, unknown>;
}
```

**Adapter contract:** Adapters set `usageUnitId` to a stable identifier when available. Inner executors may emit neutral usage facts without billing identity. Billing schemas still require identity at the validation boundary for authoritative executors.

### 5. ONE_LEDGER_WRITER Enforcement

**Enforcement:** Stack test (grep-based). Depcruise rule is impractical because other features legitimately import `AccountService` for read operations (`getBalance`, `creditAccount`, `listCreditLedgerEntries`). The grep test precisely targets `recordChargeReceipt()` call sites.

**Stack test** (`tests/stack/ai/one-ledger-writer.stack.test.ts`):

```typescript
import { execSync } from "child_process";

test("only billing.ts calls recordChargeReceipt", () => {
  // grep for actual call sites (not interface definitions)
  const result = execSync(
    "grep -rn '\\.recordChargeReceipt(' src/ --include='*.ts' || true",
    { encoding: "utf-8" }
  );
  const callSites = result
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.includes("billing.ts"))
    .filter((line) => !line.includes(".port.ts")) // interface def
    .filter((line) => !line.includes(".adapter.ts")); // implementation

  expect(callSites).toEqual([]);
});
```

### 6. GraphExecutorPort Interface

```typescript
export interface GraphExecutorPort {
  // Non-async: returns immediately with stream + final promise
  runGraph(req: GraphRunRequest): GraphRunResult;
}

export interface GraphRunResult {
  readonly stream: AsyncIterable<AiEvent>;
  readonly final: Promise<GraphFinal>;
}
```

**Why non-async?** The method returns a stream handle immediately; actual execution happens as the stream is consumed. Avoids nested `Promise<Promise<...>>`.

**Usage aggregation:** `GraphFinal.totalUsage` aggregates all `usage_report` events for UI/analytics display. Billing uses individual `usage_report` events (1..N per run); `totalUsage` is a convenience summary, not the billing source of truth.

### 7. InProcCompletionUnitAdapter

Wraps existing behavior behind `GraphExecutorPort`. Graph routing is handled by `NamespaceGraphRouter` — this adapter handles only the default single-completion path.

```typescript
export class InProcCompletionUnitAdapter implements GraphExecutorPort {
  constructor(
    private deps: InProcGraphExecutorDeps,
    private completionStream: CompletionStreamFn
    // NOTE: No graphResolver — aggregator handles routing
  ) {}

  runGraph(req: GraphRunRequest): GraphRunResult {
    // Default: single completion path (no graph orchestration)
    // ... transform stream, emit usage_report before done
    return { stream, final };
  }

  // Exposed for LangGraphInProcProvider to call for multi-step runners
  executeCompletionUnit(params: CompletionUnitParams): CompletionUnitResult {
    // Transforms stream, emits usage_report, but NO done event
    // Caller (provider/runner) controls when to emit done
  }
}
```

**Key points:**

- `NamespaceGraphRouter` routes by `graphId` namespace → appropriate provider
- `LangGraphInProcProvider` uses `executeCompletionUnit()` for multi-step graphs
- Facade is graph-agnostic — no `graphResolver` in bootstrap or facade
- Enforces `GRAPH_LLM_VIA_COMPLETION` — all LLM calls go through adapter
- `runId` provided by caller; `attempt` frozen at 0 in P0 (per P0_ATTEMPT_FREEZE)

### 8. executeCompletionUnit Contract

The `executeCompletionUnit()` method must provide a **unified execution boundary** with normalized errors:

1. **Stream never throws** — errors become `ErrorEvent` yields
2. **Final never rejects** — errors become `{ok: false, ...}` results
3. **Single authority** — both derive from same operation, error normalized once

This restores the invariant: `stream + final = unified execution boundary with normalized errors`.

The `CogniCompletionAdapter` in the package layer then doesn't need any special error handling — it just consumes a well-behaved stream/final from the adapter boundary.

**Working Billing Flow (Non-LangGraph InProc Path):**

```
AiRuntime.runChatStream()
        ↓
createGraphExecutor(streamFn, userId)
        ↓
createScopedGraphExecutor({ executor, billing, preflightCheckFn })
        ↓
ObservabilityDecorator → PreflightDecorator → BillingValidationDecorator → BillingEnrichmentDecorator → AggregatingExecutor
        ↓
graphExecutor.runGraph() [InProcCompletionUnitAdapter]
        ↓
createTransformedStream()
        │
        ├─ for await (event of innerStream) { yield events }
        ├─ await final ← AFTER stream completes
        ├─ yield usage_report { fact: UsageFact } ← neutral fact WITH costUsd, litellmCallId
        └─ yield done
        ↓
BillingEnrichmentGraphExecutorDecorator.enrichStream()
        │
        ├─ on usage_report → attach billing identity
        └─ on other events → pass through
        ↓
BillingGraphExecutorDecorator.wrapStreamWithBilling()
        │
        ├─ on usage_report → validate (Zod strict)
        └─ on other events → yield to RunEventRelay (UI stream adapter)
```

**Key insight:** In the working path, `createTransformedStream()`:

1. Fully drains the inner stream
2. THEN awaits final (no dual failure channels)
3. Builds `UsageFact` from final result (has litellmCallId, costUsd, model)
4. Emits `usage_report` then `done`
5. Stream never throws to caller — it's self-contained
6. Bootstrap-owned decorators enrich and validate `usage_report` before `RunEventRelay` sees it

### 9. Adapter-Specific Notes

#### InProcCompletionUnitAdapter

**usage_unit_id source:** `litellmCallId` from LLM response header (`x-litellm-call-id`)

**Ownership clarity:**

| Component                     | Responsibility                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `completion.ts`               | Returns usage fields in final (litellmCallId, costUsd, tokens); yields `ChatDeltaEvent` only             |
| `InProcCompletionUnitAdapter` | Emits `usage_report` AiEvent from final BEFORE `done`; owns `UsageFact` construction                     |
| `billing.ts`                  | Sole ledger writer. Owns `callIndex` counter. Computes fallback `usageUnitId` at commit time if missing. |

**Fallback policy (STRICT):** If `usageUnitId` is missing at `commitUsageFact()` time:

1. **Billing subscriber** maintains a per-run `callIndex` counter (starts at 0)
2. **At commit time**, if `fact.usageUnitId` is undefined:
   - Log ERROR with metric `billing.missing_usage_unit_id`
   - Set `usageUnitId = MISSING:${runId}/${callIndex++}`
3. **This is an ERROR PATH** — investigate and fix provider integration
4. **Do NOT** silently accept missing IDs as normal operation

```typescript
// In billing.ts commitUsageFact() — billing subscriber owns callIndex
// callIndex is per-run state maintained by the billing subscriber
function commitUsageFact(fact: UsageFact, callIndex: number): void {
  let usageUnitId = fact.usageUnitId;

  if (!usageUnitId) {
    log.error(
      { runId: fact.runId, model: fact.model, callIndex },
      "billing.missing_usage_unit_id"
    );
    metrics.increment("billing.missing_usage_unit_id");
    usageUnitId = `MISSING:${fact.runId}/${callIndex}`;
  }

  const sourceReference = computeIdempotencyKey({ ...fact, usageUnitId });
  // ... record charge receipt
}
```

**Why billing-subscriber-assigned callIndex?**

- `usageUnitId` is formed at emission time (in adapter), but the provider may not have returned the ID yet
- Fallback must be computed at commit time by billing.ts (the sole ledger writer)
- `callIndex` is deterministic within a run: same run replayed = same callIndex = same idempotency key = no double billing
- Using `Date.now()` would break idempotency on replay

### 10. P0 Scope Constraints

#### Billable Executor Scope

**P0 ships with `inproc` as the only customer-billable executor.** The `langgraph_server` executor is gated as internal/experimental until it can emit stable `usageUnitId` (prefer `litellmCallId`) + `costUsd` + resolved model.

#### Graph Contract

Graphs export compiled artifacts with no constructor arguments. Runtime config via `RunnableConfig.configurable`:

```typescript
// Graph export (packages/langgraph-graphs/src/graphs/*/graph.ts)
export const myGraph = workflow.compile(); // No args

// Invocation with configurable
await myGraph.invoke(messages, {
  configurable: {
    model: "gpt-4o",
    runId: "run-123",
    toolIds: ["get_current_time", "web_search"],
    // ... GraphRunConfig fields (JSON-serializable)
  },
});
```

**Invariant:** No env reads or provider SDKs in graph code. LLM/tools resolved at invoke time via registry + ALS context.

### Graph Catalog & Provider Architecture

#### File Tree Map

```
packages/
├── ai-core/                                  # Executor-agnostic primitives (NO LangChain)
│   └── src/
│       ├── events/ai-events.ts               # AiEvent union (canonical) ✓
│       ├── usage/usage.ts                    # UsageFact, ExecutorType ✓
│       ├── execution/error-codes.ts          # AiExecutionErrorCode (canonical) ✓
│       ├── tooling/                          # Tool execution types + runtime ✓
│       │   ├── types.ts                      # ToolExecFn, ToolExecResult, EmitAiEvent, BoundToolRuntime
│       │   ├── tool-runner.ts                # createToolRunner (canonical location)
│       │   ├── ai-span.ts                    # AiSpanPort (observability interface)
│       │   └── runtime/tool-policy.ts        # ToolPolicy, createToolAllowlistPolicy
│       └── index.ts                          # Package barrel
│
├── ai-tools/                                 # Pure tool contracts (NO LangChain, NO src imports) ✓
│   └── src/
│       ├── types.ts                          # ToolContract, BoundTool, ToolResult
│       ├── catalog.ts                        # TOOL_CATALOG: Record<string, BoundTool> (canonical registry)
│       └── tools/*.ts                        # Pure tool implementations
│
└── langgraph-graphs/                         # ALL LangChain code lives here ✓
    └── src/
        ├── catalog.ts                        # LANGGRAPH_CATALOG (single source of truth) ✓
        ├── graphs/                           # Compiled graph exports (no-arg)
        │   ├── index.ts                      # Barrel: all compiled graphs
        │   ├── poet/graph.ts                 # export const poetGraph = ...compile()
        │   ├── ponderer/graph.ts             # export const pondererGraph = ...compile()
        │   └── research/graph.ts             # Graph #3 (compiled)
        └── runtime/                          # Runtime utilities ✓
            ├── core/                         # Generic (no ALS)
            │   ├── langchain-tools.ts        # makeLangChainTools, toLangChainToolsCaptured
            │   └── ...
            └── cogni/                        # Cogni executor (uses ALS)
                ├── exec-context.ts           # CogniExecContext, runWithCogniExecContext
                ├── completion-adapter.ts     # CogniCompletionAdapter wraps completionFn
                └── tools.ts                  # toLangChainToolsFromContext

src/
├── ports/
│   ├── agent-catalog.port.ts                 # AgentCatalogPort, AgentDescriptor ✓
│   ├── billing-context.ts                    # BillingContext, BillingResolver, PreflightCreditCheckFn (app-local)
│   │   # GraphExecutorPort now in @cogni/graph-execution-core
│   ├── tool-exec.port.ts                     # Re-export ToolExecFn from ai-core
│   └── index.ts                              # Barrel export
│
├── adapters/server/ai/
│   ├── agent-catalog.provider.ts             # AgentCatalogProvider interface (internal, no canHandle) ✓
│   ├── aggregating-agent-catalog.ts          # AggregatingAgentCatalog ✓
│   ├── inproc-completion-unit.adapter.ts     # CompletionUnitAdapter (NOT GraphExecutorPort)
│   ├── aggregating-executor.ts               # NamespaceGraphRouter (Map<namespace, GraphExecutorPort>)
│   └── langgraph/                            # LangGraph-specific bindings
│       ├── index.ts                          # Barrel export
│       ├── catalog.ts                        # LangGraphCatalog types (references compiled exports)
│       ├── inproc-agent-catalog.provider.ts  # LangGraphInProcAgentCatalogProvider (discovery) ✓
│       └── inproc.provider.ts                # LangGraphInProcProvider with injected catalog
│   # NOTE: NO per-graph files — graphs live in packages/
│   # NOTE: NO tool-registry — graphs import ToolContracts directly; policy via @cogni/ai-core
│
├── features/ai/
│   └── services/
│       ├── ai_runtime.ts                     # Uses NamespaceGraphRouter via GraphExecutorPort (no graph knowledge) ✓
│       ├── billing.ts                        # ONE_LEDGER_WRITER ✓
│       └── preflight-credit-check.ts         # Facade-level credit validation ✓
│   # NOTE: runners/ DELETED — logic absorbed by LangGraphInProcProvider
│
├── bootstrap/
│   ├── container.ts                          # Wires providers + aggregator
│   ├── graph-executor.factory.ts             # Execution factory (requires completion deps)
│   └── agent-discovery.ts                    # Discovery factory (no execution deps) ✓
│
└── app/_facades/ai/
    └── completion.server.ts                  # Graph-agnostic (no graph selection logic)
```

#### Key Interfaces

```typescript
// src/ports/agent-catalog.port.ts (PUBLIC PORT)
interface AgentCatalogPort {
  listAgents(): readonly AgentDescriptor[];
}

interface AgentDescriptor {
  readonly agentId: string; // P0: === graphId
  readonly graphId: string; // Internal routing
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: AgentCapabilities;
}

// src/adapters/server/ai/aggregating-executor.ts
// Providers implement GraphExecutorPort directly — no intermediate interface.
class NamespaceGraphRouter implements GraphExecutorPort {
  constructor(providers: ReadonlyMap<string, GraphExecutorPort>) {}
  // Routes by graphId.split(":")[0] → Map lookup
}

// src/adapters/server/ai/aggregating-agent-catalog.ts
class AggregatingAgentCatalog implements AgentCatalogPort {
  constructor(providers: AgentCatalogProvider[]) {}
  listAgents(): readonly AgentDescriptor[];
}
```

### Agent Discovery

> See [agent-discovery.md](agent-discovery.md) for full discovery architecture.

Discovery is decoupled from execution via `AgentCatalogPort`. Routes use discovery factories that don't require execution infrastructure.

#### Discovery Pipeline

```
Route (/api/v1/ai/agents)
     │
     ▼
listAgentsForApi() [bootstrap/agent-discovery.ts]
     │
     ▼
AggregatingAgentCatalog.listAgents()
     │
     ▼
AgentCatalogProvider[].listAgents() (fanout)
     │
     └──► LangGraphInProcAgentCatalogProvider → reads LANGGRAPH_CATALOG
```

#### Provider Types

| Provider                              | Port                | Purpose   |
| ------------------------------------- | ------------------- | --------- |
| `LangGraphInProcAgentCatalogProvider` | `AgentCatalogPort`  | Discovery |
| `LangGraphInProcProvider`             | `GraphExecutorPort` | Execution |

#### Key Invariants

- **DISCOVERY_NO_EXECUTION_DEPS**: Discovery providers don't require `CompletionStreamFn`
- **REGISTRY_SEPARATION**: Discovery providers never in execution registry
- **COMPLETION_UNIT_NOT_PORT**: `InProcCompletionUnitAdapter` is `CompletionUnitAdapter`, not `GraphExecutorPort`

### Compiled Graph Execution Architecture

**Per-Graph File Structure:**

```
graphs/<name>/
├── graph.ts        # Pure factory: createXGraph({ llm, tools })
├── prompts.ts      # System prompt constant(s)
├── server.ts       # ~1 line: await createServerEntrypoint("name")
└── cogni-exec.ts   # ~1 line: createCogniEntrypoint("name")
```

**Architecture:**

```
graph.ts (pure factory)       → createXGraph({ llm, tools })
    ↓                                ↓
server.ts (langgraph dev)     cogni-exec.ts (Cogni executor)
    ↓                                ↓
await createServerEntrypoint()  createCogniEntrypoint() [sync]
    ↓                                ↓
initChatModel + captured exec   CogniCompletionAdapter + ALS context
    ↓                                ↓
    └──────── graph.invoke(input, { configurable: { model, toolIds } }) ────────┘
```

**Type Placement:**

| Type               | Package                                        | Rationale                                                                              |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GraphRunConfig`   | `@cogni/ai-core`                               | JSON-serializable; shared across all adapters                                          |
| `CogniExecContext` | `packages/langgraph-graphs/src/runtime/cogni/` | LangGraph-specific; holds `completionFn`, `tokenSink`, `toolExecFn` (NO model per #35) |
| `TOOL_CATALOG`     | `@cogni/ai-tools/catalog.ts`                   | Canonical tool registry; `langgraph-graphs` wraps from here                            |

**Tool Wrapper Architecture (single impl, two wrappers):**

```
┌─────────────────────────────────────────────────────────────────────┐
│ makeLangChainTools({ contracts, execResolver })  ← single impl      │
│   execResolver: (config?) => ToolExecFn                             │
│   allowlist check via config.configurable.toolIds                   │
└─────────────────────────────────────────────────────────────────────┘
              ↑                                    ↑
┌──────────────────────────────────┐ ┌────────────────────────────────┐
│ toLangChainToolsCaptured         │ │ toLangChainToolsFromContext    │
│ ({ contracts, toolExecFn })      │ │ ({ contracts })                │
│ execResolver = () => toolExecFn  │ │ execResolver = () =>           │
│ (captured at bind time)          │ │   getCogniExecContext().toolExecFn│
└──────────────────────────────────┘ └────────────────────────────────┘
```

### File Pointers

| File                                                               | Purpose                                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `packages/graph-execution-core/src/graph-executor.port.ts`         | `GraphExecutorPort`, `GraphRunRequest`, `GraphRunResult`, `ExecutionContext` |
| `packages/graph-execution-core/src/execution-context.ts`           | `ExecutionContext` — per-run metadata (actor, session, mask, requestId)      |
| `src/adapters/server/ai/execution-scope.ts`                        | `ExecutionScope` via ALS — billing + abort for static providers              |
| `src/ports/billing-context.ts`                                     | `BillingContext`, `BillingResolver`, `PreflightCreditCheckFn`                |
| `src/adapters/server/ai/inproc-completion-unit.adapter.ts`         | `InProcCompletionUnitAdapter`; emits `usage_report` before `done`            |
| `src/types/usage.ts`                                               | `UsageFact` type                                                             |
| `src/types/billing.ts`                                             | `SOURCE_SYSTEMS` enum                                                        |
| `src/features/ai/types.ts`                                         | `UsageReportEvent` (contains `UsageFact`)                                    |
| `src/features/ai/services/completion.ts`                           | Returns usage in final (no AiEvent emission)                                 |
| `src/features/ai/services/billing.ts`                              | `commitUsageFact()`, `computeIdempotencyKey()`                               |
| `src/adapters/server/ai/billing-executor.decorator.ts`             | `BillingGraphExecutorDecorator` (intercepts usage_report → commitFn)         |
| `src/adapters/server/ai/preflight-credit-check.decorator.ts`       | `PreflightCreditCheckDecorator` (rejects runs with insufficient credits)     |
| `src/types/billing.ts`                                             | `BillingCommitFn` type (DI callback for decorator)                           |
| `src/features/ai/services/ai_runtime.ts`                           | `RunEventRelay` (UI stream adapter; no billing responsibility)               |
| `src/shared/db/schema.billing.ts`                                  | `run_id`, `attempt` columns; uniqueness constraints                          |
| `src/bootstrap/container.ts`                                       | Wires `InProcCompletionUnitAdapter`                                          |
| `src/bootstrap/graph-executor.factory.ts`                          | Factory for adapter creation                                                 |
| `.dependency-cruiser.cjs`                                          | ONE_LEDGER_WRITER rule                                                       |
| `tests/stack/ai/one-ledger-writer.stack.test.ts`                   | Grep for `.recordChargeReceipt(` call sites                                  |
| `tests/stack/ai/billing-idempotency.stack.test.ts`                 | Replay usage_report twice, assert 1 row                                      |
| `tests/stack/ai/billing-disconnect.stack.test.ts`                  | StreamDriver completes billing even if UI disconnects                        |
| `tests/stack/ai/no-direct-completion-executestream.stack.test.ts`  | Grep test for BILLABLE_AI_THROUGH_EXECUTOR                                   |
| `tests/stack/ai/stream-drain-enforcement.stack.test.ts`            | Grep test for CALLER_DRAIN_OBLIGATION (all runGraph callers drain)           |
| `tests/stack/internal/internal-runs-billing.stack.test.ts`         | Regression test: internal runs produce charge_receipts (bug.0005)            |
| `tests/unit/adapters/server/ai/billing-executor-decorator.spec.ts` | Decorator unit tests (validation, error handling, stream wrapping)           |

## Acceptance Checks

**Automated:**

- `pnpm test -- one-ledger-writer` — validates ONE_LEDGER_WRITER invariant
- `pnpm test -- billing-idempotency` — validates IDEMPOTENT_CHARGES
- `pnpm test -- billing-disconnect` — validates BILLING_INDEPENDENT_OF_CLIENT
- `pnpm test -- no-direct-completion-executestream` — validates BILLABLE_AI_THROUGH_EXECUTOR
- `pnpm test -- stream-drain-enforcement` — validates CALLER_DRAIN_OBLIGATION (all runGraph callers drain stream)
- `pnpm test -- billing-executor-decorator` — validates BillingGraphExecutorDecorator behavior
- `pnpm test -- preflight-credit-check` — validates PreflightCreditCheckDecorator behavior
- `pnpm test -- schedules.credit-gate` — validates schedule creation credit gate (paid/free model × balance)
- `pnpm check` — lint + type-check passes

## Open Questions

(none)

## Related

- [agent-discovery.md](agent-discovery.md) — Discovery pipeline, provider types
- [accounts-design.md](accounts-design.md) — Owner vs Actor tenancy rules
- [ai-setup.md](ai-setup.md) — P1 invariants, telemetry
- [langgraph-patterns.md](langgraph-patterns.md) — Graph architecture, anti-patterns
- [tool-use.md](tool-use.md) — Tool execution within graphs
- [billing-evolution.md](billing-evolution.md) — Credit unit standard, pricing policy, markup
- [activity-metrics.md](activity-metrics.md) — Activity dashboard join
- [thread-persistence.md](thread-persistence.md) — UIMessage persistence, AiEvent→UIMessage bridge
- [claude-sdk-adapter.md](claude-sdk-adapter.md) — Claude Agent SDK adapter design
- [n8n-adapter.md](n8n-adapter.md) — n8n workflow execution adapter design
- [tenant-connections.md](tenant-connections.md) — Tenant connections
- [external-executor-billing.md](external-executor-billing.md) — External executor billing design
- [Project: Graph Execution](../../work/projects/proj.graph-execution.md)

## Sources

- https://langchain-ai.github.io/langgraphjs/how-tos/configuration/
- https://github.com/langchain-ai/langgraph/issues/5023
- https://nodejs.org/api/async_context.html
- https://osekelvin22.medium.com/avoid-dependency-injection-drilling-with-async-local-storage-in-nodejs-and-nestjs-22d325ee9ef4
- https://wempe.dev/blog/nodejs-async-local-storage-context
