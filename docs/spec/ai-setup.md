---
id: ai-setup-spec
type: spec
title: AI Setup Spec
status: active
trust: draft
summary: End-to-end AI correlation ID propagation from Next.js through LangGraph to LiteLLM and Langfuse
read_when: Setting up AI pipelines, correlation IDs, or reproducibility tracking
owner: derekg1729
created: 2026-02-05
verified: 2026-02-05
tags: [ai]
---

# AI Setup Spec

> [!CRITICAL]
> All AI calls must have end-to-end correlation IDs (request_id + trace_id) propagated from Next.js → LangGraph → LiteLLM → ai_invocation_summaries → Langfuse.

## Core Invariants

1. **Reproducibility**: Every AI run must capture: graph_name, graph_version (git SHA), prompt_hash (content hash), router_policy_version, resolved provider+model.

2. **Correlation**: `request_id` + `trace_id` propagate end-to-end; store `litellm_call_id` and `langfuse_trace_id` as join keys.

3. **Data Handling**: Prod redacts prompts/responses; eval runs must persist full prompt/response artifacts for debugging (local files or Langfuse datasets).

4. **Billing Separation**: `charge_receipts` stays minimal for billing/audit. `ai_invocation_summaries` captures telemetry summaries.

---

## Contracts

### Reproducibility Keys (per run/span)

| Key                     | Source                | Purpose             |
| ----------------------- | --------------------- | ------------------- |
| `graph_name`            | Graph module constant | Which workflow ran  |
| `graph_version`         | Git SHA at build      | Exact code version  |
| `prompt_hash`           | Content hash          | Detect prompt drift |
| `router_policy_version` | Semver or SHA         | Model routing logic |
| `provider` + `model`    | LiteLLM response      | Resolved target     |

### Correlation ID Map

| ID                  | Scope                     | Purpose                                                  |
| ------------------- | ------------------------- | -------------------------------------------------------- |
| `request_id`        | One per inbound request   | Primary join across all systems                          |
| `trace_id`          | One per distributed trace | OTel backbone; 32-hex                                    |
| `span_id`           | One per operation         | Tracing UI only; **do NOT persist as durable join key**  |
| `invocation_id`     | One per LLM call attempt  | Idempotency key; UNIQUE in ai_invocation_summaries       |
| `graph_run_id`      | One per graph execution   | Groups multiple LLM calls within a request               |
| `langfuse_trace_id` | Langfuse-specific         | Equals trace_id when valid 32-hex; logged for debug join |
| `litellm_call_id`   | LiteLLM call ID           | Join to /spend/logs; may be null on errors               |

### Langfuse Visibility Contract

**Purpose:** Langfuse is canonical for prompt/response visibility + tool usage. Logs contain IDs only; Langfuse contains scrubbed content.

**Invariants:**

- **LANGFUSE_IS_VISIBILITY_SURFACE:** Prompts/responses visible ONLY in Langfuse (scrubbed), never in Loki
- **LANGFUSE_TRACE_ID_STRATEGY:** Use OTel `trace_id` as Langfuse trace ID if valid 32-hex; otherwise generate + store otelTraceId in metadata
- **LANGFUSE_TOOL_VISIBILITY:** Every tool execution creates Langfuse span with scrubbed args/result and policy decision
- **LANGFUSE_NON_NULL_IO:** Root trace must have non-null input (on create) and output (on terminal)

**What Langfuse Captures (that logs do not):**

| Data                  | Langfuse           | Loki Logs   |
| --------------------- | ------------------ | ----------- |
| Last user message     | Scrubbed text      | Hash only   |
| Assistant response    | Scrubbed text      | Hash only   |
| Tool args/results     | Scrubbed summaries | Never       |
| Tool policy decisions | Per-span metadata  | Never       |
| Token usage           | On generation      | Counts only |

**Tool Span Contract:**

| Field      | Content                                                              |
| ---------- | -------------------------------------------------------------------- |
| `name`     | `tool:<toolName>`                                                    |
| `input`    | Scrubbed args + argHash + bytes                                      |
| `output`   | Scrubbed result + resultHash + bytes OR `{decision: 'deny', reason}` |
| `metadata` | `{toolCallId, effect, durationMs, policyDecision}`                   |
| `level`    | `DEFAULT` / `WARNING` (deny) / `ERROR`                               |

**See:** [Observability](OBSERVABILITY.md#langfuse-integration-ai-trace-visibility) for full implementation checklist

**ID Categories:**

| Category                        | IDs                                           | Notes                                                 |
| ------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| **Essential (always required)** | `request_id`, `trace_id`, `invocation_id`     | Must be non-null on every ai_invocation_summaries row |
| **Essential for graphs**        | `graph_run_id`, `graph_name`, `graph_version` | Required when LLM call is within a graph execution    |
| **Nice-to-have**                | `langfuse_trace_id`, `litellm_call_id`        | Nullable; depends on external service availability    |

**ID Strategy:**

- One stable `request_id` per user-initiated request—do NOT generate new IDs per layer
- `trace_id` for distributed tracing; `span_id` changes per operation (never persist span_id)
- `request_id` attached as OTel span attribute AND forwarded in LiteLLM metadata
- `invocation_id` generated per LLM call attempt (idempotency key for retries)

### Eval Artifact Policy

| Environment   | Prompts/Responses       | Full Artifacts | Storage                          |
| ------------- | ----------------------- | -------------- | -------------------------------- |
| **prod**      | Redacted (never logged) | No             | N/A                              |
| **eval/CI**   | Full capture required   | Yes            | Local files or Langfuse datasets |
| **local dev** | Console only            | Optional       | Never committed                  |

---

## Implementation Checklist

### P0: MVP - Observability Foundation

- [x] Enforce Node runtime for AI routes (`export const runtime = 'nodejs'`)
- [x] OTel instrumentation with explicit root span at request entry (do not rely on auto-instrumentation)
- [x] Store `trace_id` deterministically from root span into RequestContext
- [x] Direct Langfuse SDK integration (not OTel exporter) to reliably obtain `langfuse_trace_id`
- [x] Propagate `reqId` + `trace_id` in LiteLLM metadata
- [x] Create `ai_invocation_summaries` table (see schema below)
- [x] Write correlation IDs to ai_invocation_summaries on every AI call

#### P0 Known Issues

- [x] Stack test for telemetry writes (`tests/stack/ai/ai-telemetry.stack.test.ts` validates `ai_invocation_summaries` rows)

#### Chores

- [x] Observability instrumentation [observability.md](../../.claude/commands/observability.md)
- [x] Documentation updates (`/implement` docs pass)

### P1: LangGraph Server Integration

Deploy LangGraph Server as external runtime; implement adapter; preserve unified billing. See [LangGraph Server](langgraph-server.md) for full spec.

**Runtime architecture:**

- **Next.js:** Uses assistant-ui Data Stream Protocol
- **LangGraph Server:** External process executes graphs, owns thread state
- **Adapter:** `LangGraphServerAdapter` translates server streams → AiEvents

#### P1 Deliverables

**P1 instance:** `apps/langgraph-service/src/graphs/chat/chat.graph.ts`

- [ ] Create `apps/langgraph-service/` with LangGraph Server + Postgres checkpointer
- [ ] Move graph definitions from `src/features/ai/graphs/` to langgraph-service
- [ ] Implement `LangGraphServerAdapter` implementing `GraphExecutorPort`
- [ ] Add `executorType` to `UsageFact` (required field)
- [x] Create `src/features/ai/services/ai_runtime.ts` as single AI entrypoint (generates `runId`, uses GraphExecutorPort)
- [x] Create `src/features/ai/tool-runner.ts` for tool execution + AiEvent emission (InProc adapter only)
- [x] Integrate chat route: consumes AiEvents from runtime, maps to Data Stream Protocol

#### P1 Invariants (Blocking for Merge)

**Runtime Boundary:**

- [ ] **RUNTIME_IS_EXTERNAL**: Next.js never imports graph modules. All graph code in `apps/langgraph-service/`. `LangGraphServerAdapter` calls external service.
- [ ] **THREAD_ID_TENANT_SCOPED**: `thread_id` derived server-side as `${accountId}:${stateKey}`. Never accept raw thread_id from client.
- [ ] **EXECUTOR_TYPE_REQUIRED**: `UsageFact.executorType` is required. All billing/history logic must be executor-agnostic.

**Billing & Telemetry:**

- [ ] **GRAPH_CALLER_TYPE_REQUIRED**: Use distinct caller types: `LlmCaller` (no graphRunId) vs `GraphLlmCaller` (extends LlmCaller with REQUIRED `graphRunId`, `graphName`, `graphVersion`).
- [ ] **GRAPH_METADATA_ENFORCED**: If `caller.graphRunId` is present, then `graph_name` and `graph_version` must be non-null on `ai_invocation_summaries` rows.
- [x] **AI_RUNTIME_EMITS_AIEVENTS**: ai_runtime emits AiEvents only. Route layer maps AiEvents → Data Stream Protocol using official assistant-ui helper.
- [x] **RUNTIME_STREAMS_ASYNC_ITERABLE**: ai_runtime must return `AsyncIterable<AiEvent>`, yielding immediately. No buffering.

**Protocol:**

- [ ] **DATA_STREAM_PROTOCOL_ONLY**: Chat route maps AiEvents to assistant-ui Data Stream Protocol chunks via official helper; never invent custom SSE vocabulary.
- [ ] **GRAPH_FINALIZATION_ONCE**: Adapter emits exactly one `done` event and resolves `final` exactly once per run.

**InProc Adapter Only** (not applicable to LangGraph Server):

- [ ] **TOOLCALL_ID_STABLE**: Tool calls use model-provided `tool_call.id` or UUID from tool-runner. Same `toolCallId` persists across start→result.
- [ ] **TOOLRUNNER_ALLOWLIST_HARD_FAIL**: Redaction uses explicit allowlist per tool. Missing allowlist → emit error.
- [ ] **TOOLRUNNER_RESULT_SHAPE**: `toolRunner.exec()` returns `{ok:true, value}` | `{ok:false, errorCode, safeMessage}`.
- [ ] **PROMPT_HASH_VERSION_IN_PAYLOAD**: `prompt_hash_version: 'v1'` embedded in canonical payload for hashing.

#### P1 File Pointers

| File                                                   | Purpose                                                  |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `apps/langgraph-service/`                              | LangGraph Server deployment directory                    |
| `apps/langgraph-service/src/graphs/chat/chat.graph.ts` | Chat graph definition (LangGraph native)                 |
| `src/adapters/server/ai/langgraph-server.adapter.ts`   | `LangGraphServerAdapter` implementing GraphExecutorPort  |
| `src/types/usage.ts`                                   | Add `executorType` required field to `UsageFact`         |
| `src/features/ai/services/ai_runtime.ts`               | Single AI entrypoint; derives thread_id; selects adapter |
| `src/features/ai/tool-runner.ts`                       | Tool execution (InProc adapter only)                     |
| `src/app/api/v1/ai/chat/route.ts`                      | Consumes AiEvents; maps to Data Stream Protocol          |
| `src/adapters/server/ai/litellm.adapter.ts`            | `promptHash` computation (InProc adapter path)           |

---

### Streaming & Tool UI Integration

#### Tool UI Mapping

- Tool names are stable API identifiers (snake_case, versioned if needed)
- Every tool must have Zod `inputSchema` and `outputSchema` for UI rendering and eval validation
- Frontend components registered by `toolName` (e.g., `knowledge_search` → `<KnowledgeSearchUI />`)
- Always provide `ToolFallback` for unregistered tools

#### ToolCallId Provenance

**Model-initiated tool calls:** Use `tool_call.id` from model response (e.g., OpenAI's `call_123abc`)

**Graph-initiated tool calls:** Generate UUID at tool-runner boundary; persist as `toolCallId` across all stream chunks

**Invariant:** Same `toolCallId` must appear in start→args→result chunks; enables UI to correlate tool lifecycle without relay on internal span_id.

#### Stream Redaction Policy

**Redaction ownership:**

- **ToolRunner** redacts tool payloads per allowlist before emitting AiEvents
- **Route** may apply final transport-level truncation as last-mile enforcement

**Prod stream payloads:**

- Never stream full request/response bodies (redact entirely)
- Stream UI-safe summaries + references only: tool name, execution status (running/success/error), result summary (IDs/URLs/counts), error message (no secrets)
- Allowlist fields per tool (e.g., `KnowledgeSearchResult` streams `{ query, resultCount, topHitUrl }` not full documents)
- Truncate long strings (e.g., >500 chars) to summary + reference link
- Never stream tokens, API keys, raw sensitive data, large code diffs, or full documents

**Eval/CI:**

- Capture full prompt/response artifacts out-of-band (Langfuse datasets or local files in `evals/artifacts/`)
- Don't include full artifacts in user-facing stream by default
- Only stream redacted payloads same as prod

#### Example Redaction (knowledge_search tool)

| Field              | Prod Stream                          | Full Artifact (Eval Only)              |
| ------------------ | ------------------------------------ | -------------------------------------- |
| `query`            | ✓ (query string)                     | ✓ Full query                           |
| `documents`        | ✗ (redacted, stream count + top URL) | ✓ Full documents in eval artifact file |
| `relevance_scores` | ✗                                    | ✓ Full scores in eval                  |
| `error`            | ✓ (message only)                     | ✓ Full error + stack                   |

---

### P2: First Eval Runner

Build eval harness to validate graph outputs against golden fixtures.

#### P2 Deliverables

- [ ] Create `evals/` directory structure
- [ ] Implement `evals/runner.ts` harness (load fixtures, run graph, compare goldens)
- [ ] Add 3-5 fixtures for review graph (`evals/fixtures/review-*.json`)
- [ ] Create corresponding goldens (`evals/goldens/review-*.golden.json`)
- [ ] Add `evals/scripts/update-goldens.ts` with explicit `--update` flag
- [ ] CI gate: fail if goldens change without `--update-goldens` flag

#### P2 Invariants

- [ ] **GOLDEN_UPDATE_POLICY**: Never silently update goldens to make CI pass. Requires commit message explaining why.
- [ ] **STRUCTURED_OUTPUT_VALIDATION**: All AI responses must validate against Zod schema before golden comparison.
- [ ] **DETERMINISTIC_COMPARE**: Golden matching uses explicit tolerances (exact, subset, numeric delta).
- [ ] **EVAL_ARTIFACT_CAPTURE**: Eval runs must persist full prompt/response artifacts (local files or Langfuse datasets).

#### P2 File Pointers

| File                              | Purpose                     |
| --------------------------------- | --------------------------- |
| `evals/runner.ts`                 | Test harness entry point    |
| `evals/fixtures/`                 | Input test cases            |
| `evals/goldens/`                  | Expected outputs            |
| `evals/scripts/update-goldens.ts` | Explicit golden update tool |

### P3: Future (Do NOT Build Yet)

- [ ] Evaluate ClickHouse/data lake after eval loop works
- [ ] PostHog analytics (requires stable correlation IDs first)
- [ ] Tempo distributed tracing (after OTel foundation stable)
- [ ] **Do NOT build preemptively**

---

## File Pointers (P0 Scope)

| File                                        | Change                                   |
| ------------------------------------------- | ---------------------------------------- |
| `src/shared/observability/server/otel.ts`   | New: OTel SDK init + context propagation |
| `src/adapters/server/ai/litellm.adapter.ts` | Attach trace_id to LiteLLM metadata      |
| `src/shared/db/schema.ai.ts`                | New: ai_invocation_summaries table       |
| `src/features/ai/services/completion.ts`    | Orchestrator (delegates to telemetry.ts) |
| `src/features/ai/services/telemetry.ts`     | Write to ai_invocation_summaries         |
| `src/bootstrap/container.ts`                | Wire Langfuse sink                       |

---

## Schema: `ai_invocation_summaries`

**Purpose:** Covers both direct LLM calls and LangGraph runs. Clearly not billing; clearly not full telemetry.

| Column                  | Type        | Notes                                                |
| ----------------------- | ----------- | ---------------------------------------------------- |
| `id`                    | uuid        | PK                                                   |
| `invocation_id`         | text        | NOT NULL, UNIQUE (idempotency key per LLM call)      |
| `request_id`            | text        | NOT NULL (multiple rows per request allowed)         |
| `trace_id`              | text        | NOT NULL (from explicit root span)                   |
| `langfuse_trace_id`     | text        | Nullable, debug URL                                  |
| `litellm_call_id`       | text        | Nullable, join to /spend/logs                        |
| `prompt_hash`           | text        | NOT NULL, SHA-256 of canonical payload               |
| `router_policy_version` | text        | NOT NULL, semver or git SHA                          |
| `graph_run_id`          | text        | Nullable (identifies graph execution within request) |
| `graph_name`            | text        | Nullable (null = direct LLM call)                    |
| `graph_version`         | text        | Nullable, git SHA                                    |
| `provider`              | text        | NOT NULL, e.g., "openai", "anthropic"                |
| `model`                 | text        | Resolved model ID                                    |
| `tokens_in`             | int         | Nullable                                             |
| `tokens_out`            | int         | Nullable                                             |
| `tokens_total`          | int         | Nullable                                             |
| `provider_cost_usd`     | numeric     | Nullable                                             |
| `latency_ms`            | int         | Call duration                                        |
| `status`                | text        | "success" / "error"                                  |
| `error_code`            | text        | Nullable                                             |
| `created_at`            | timestamptz |                                                      |

**Uniqueness:** `UNIQUE(invocation_id)` — UUID generated per LLM call attempt serves as idempotency key (better than `request_id + litellm_call_id` since `litellm_call_id` is null on errors).

**Do NOT add:** prompts, responses, full metadata blobs.

---

## LiteLLM Ownership Policy

**LiteLLM is canonical for:**

- Detailed spend logs (`/spend/logs`)
- Per-call telemetry history
- Deep analytics queries

**Local store captures:**

- Only what's available at call-time (headers, stream usage)
- Correlation IDs for resilience
- Summary for Activity dashboard fallback

**Avoid:**

- Replicating LiteLLM spend/log tables locally
- Activity dashboards hard-depending on LiteLLM uptime without fallback

---

## Design Decisions

### 1. Graph & AI Component Location

| Component              | Location                   | Rationale                                 |
| ---------------------- | -------------------------- | ----------------------------------------- |
| LangGraph graphs       | `src/features/ai/graphs/`  | Feature-scoped; pure logic, no IO         |
| Prompt templates       | `src/features/ai/prompts/` | Versioned text files                      |
| Tool contracts + impls | `src/features/ai/tools/`   | Pure functions, receive ports via DI      |
| Route handlers         | `src/app/`                 | Thin entrypoints calling feature services |

**Graphs start in feature slices.** Packages are NOT required for LangGraph. See [LangGraph Patterns](langgraph-patterns.md).

### 2. Package Warrant Principles

Create packages only when criteria are met:

| Criterion                  | When to Package                                      |
| -------------------------- | ---------------------------------------------------- |
| **Cross-repo stability**   | Node + Operator need same contract (post-split)      |
| **Multi-deployable reuse** | Same code consumed by 2+ services without divergence |
| **Boundary enforcement**   | Hard isolation needed (no IO imports)                |

**Do NOT package:**

- Graphs before proven cross-service reuse
- Tool contracts used by single feature
- Patterns used only once

### 3. Tool Structure

**Per-tool files:**

- `src/features/ai/tools/<tool>.tool.ts` — Contract + implementation: Zod schemas, allowlist, pure `execute()` function

Tool implementations receive port dependencies via injection. No direct adapter imports.

**Single registry:**

- `src/features/ai/tool-registry.ts` — Name→BoundTool map, bindings at feature layer (not bootstrap)

**Drift guardrail:** If a tool contract is used by 2+ features or any Operator service, move to shared location (`src/shared/ai/contracts/` or package post-split).

**Ports guidance:** One port per external system, NOT per tool.

| Port              | Backs Tools            |
| ----------------- | ---------------------- |
| `KnowledgePort`   | RAG search, doc lookup |
| `WebResearchPort` | Web search, URL fetch  |
| `RepoPort`        | Code search, file read |
| `McpPort`         | MCP server calls       |

**Anti-patterns:**

- One port interface per tool when multiple tools hit same backend
- Putting IO inside graph/tool definitions
- Tool contracts without schemas (breaks evals)

### 4. Correlation Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ REQUEST ENTRY (Next.js middleware)                                  │
│ 1. Generate request_id (UUID)                                       │
│ 2. Start OTel span → trace_id                                       │
│ 3. Attach to RequestContext                                         │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ LLM CALL (completion.ts → litellm.adapter.ts)                       │
│ - Pass request_id, trace_id in LiteLLM metadata                     │
│ - Receive litellmCallId from response                               │
│ - Create Langfuse trace/span → langfuse_trace_id                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PERSISTENCE                                                         │
│ charge_receipts: billing only (chargedCredits, responseCostUsd)     │
│ ai_invocation_summaries: telemetry + correlation IDs                │
└─────────────────────────────────────────────────────────────────────┘
```

### 5. Eval Harness Requirements

**Structured outputs:** All AI responses must validate against Zod schema.

**Deterministic compare:** Golden matching uses explicit tolerances:

```json
{
  "decision": "exact",
  "key_findings": "subset",
  "confidence": 0.1
}
```

**Golden update policy:** Never silently update to make CI pass. Requires commit message explaining why.

---

## Anti-Patterns to Avoid

1. **No data lake before evals work** - ClickHouse/PostHog wait for stable correlation IDs
2. **No graphs in routes** - Routes stay thin; graphs live in feature slices and must not import IO/adapters
3. **No LiteLLM-only telemetry** - Always have local summary fallback + correlation IDs
4. **No port-per-tool** - Ports per external system, tools compose on top
5. **No IO in graphs** - Tool contracts define schemas; implementations live in adapters
6. **No premature packaging** - Package only after proven cross-service reuse (see Package Warrant Principles)

---

## Related Docs

- [LangGraph Server](langgraph-server.md) - External runtime MVP, adapter implementation
- [LangGraph Patterns](langgraph-patterns.md) - Graph patterns, anti-patterns
- [Graph Execution](graph-execution.md) - Billing idempotency, pump+fanout pattern
- [USAGE_HISTORY.md](USAGE_HISTORY.md) - Artifact caching (executor-agnostic)
- [AI Evals](ai-evals.md) - Eval harness structure, CI gates
- [Prompt Registry](prompt-registry.md) - Cloud-based prompt management (Langfuse + in-repo fallback)
- [Architecture](architecture.md) - Hexagonal layers

---

**Last Updated**: 2025-12-22
**Status**: P0 Complete, P1 Design Approved (External Runtime)
