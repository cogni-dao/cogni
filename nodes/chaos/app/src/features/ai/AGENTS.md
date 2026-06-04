# features/ai · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Last reviewed:** 2026-03-18
- **Status:** stable

## Purpose

AI feature owns all LLM interaction endpoints, runtimes, and services. Provides completion services, chat integration (assistant-ui), and model selection UI for the application.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)
- [AI Setup Spec](../../../../../docs/spec/ai-setup.md) (P0/P1 checklists, invariants)
- [LangGraph Server](../../../../../docs/spec/langgraph-server.md) (external runtime, adapter implementation)
- [LangGraph Patterns](../../../../../docs/spec/langgraph-patterns.md) (graph patterns, anti-patterns)
- [Chat subfeature](./chat/AGENTS.md)
- **Related:** [../payments/](../payments/) (credits), [../../contracts/](../../contracts/) (ai.completions.v1, ai.chat.v1, ai.models.v1)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["core", "ports", "shared", "types", "components", "contracts"],
  "must_not_import": ["app", "adapters"]
}
```

## Public Surface

- **Exports (via public.ts/public.server.ts):**
  - `ChatRuntimeProvider` (chat runtime state with thread switching)
  - `ModelPicker` (model selection dialog)
  - `ChatComposerExtras` (composer toolbar with model and graph selection)
  - `GraphPicker` (graph/agent selection dialog)
  - `useModels` (React Query hook for models list)
  - `useThreads`, `useLoadThread`, `useDeleteThread` (React Query hooks for thread list/load/delete)
  - `getPreferredModelId`, `setPreferredModelId`, `validatePreferredModel` (localStorage preferences)
  - `StreamFinalResult` (discriminated union for stream completion: ok with usage/finishReason, or error)
  - `AiEvent` (union of all AI runtime events: text_delta, tool events, done)
  - `createToolRunner` (tool execution factory; owns toolCallId; emits tool lifecycle AiEvents)
  - `uiMessagesToMessageDtos` (UIMessage[] → MessageDto[] bridge for thread persistence pipeline)
  - `redactSecretsInMessages` (best-effort credential redaction before persistence)
  - `assembleAssistantMessage` (AiEvent[] → UIMessage; deterministic ID `assistant-{runId}` for idempotent thread persistence)
- **Routes:**
  - `/api/v1/chat/completions` (POST) - OpenAI-compatible chat completions (streaming + non-streaming, `cogni_status` extension)
  - `/api/v1/ai/chat` (POST) - chat endpoint (AI SDK Data Stream Protocol, pure SSE pipe — assistant persistence in execution layer)
  - `/api/v1/ai/runs/[runId]/stream` (GET) - SSE reconnection endpoint (Last-Event-ID replay from Redis Stream)
  - `/api/v1/ai/threads` (GET) - list threads for authenticated user (paginated, recency-ordered)
  - `/api/v1/ai/threads/[stateKey]` (GET) - load thread messages
  - `/api/v1/ai/threads/[stateKey]` (DELETE) - soft-delete thread
  - `/api/v1/ai/models` (GET) - list available models with tier info
  - `/api/v1/activity` (GET) - usage statistics and logs
- **Subdirectories:**
  - Note: `runners/` and `graphs/` DELETED — logic absorbed by `LangGraphInProcProvider` in adapters layer.
  - Note: Tool contracts live in `@cogni/ai-tools` package (per TOOLS_IN_PACKAGES invariant).
  - Note: LangGraph graphs live in `packages/langgraph-graphs/` — provider wires them via catalog. See [LangGraph Patterns](../../../../../docs/spec/langgraph-patterns.md).
  - `services/` - AI service modules:
    - `completion.ts` - Orchestrator with internal DRY helpers (execute, executeStream)
    - `message-preparation.ts` - Message filtering, validation, fallbackPromptHash
    - `preflight-credit-check.ts` - Upper-bound credit estimation
    - `billing.ts` - Non-blocking charge receipt recording (commitUsageFact — strict ledger writer, COST_AUTHORITY_IS_LITELLM)
    - `telemetry.ts` - DB + Langfuse writes (ai_invocation_summaries)
    - `metrics.ts` - Prometheus metric recording
    - `llmPricingPolicy.ts` - Pricing markup calculation
    - `secrets-redaction.ts` - Best-effort credential redaction for persisted messages
- **Env/Config keys:** `LITELLM_BASE_URL`, `DEFAULT_MODEL` (via serverEnv)
- **Files considered API:** public.ts, public.server.ts, types.ts, chat/providers/ChatRuntimeProvider.client.tsx, components/\*, hooks/\*

## Ports

- **Uses ports:** AccountService (recordChargeReceipt), LlmService (completion, completionStream), AiTelemetryPort (recordInvocation), LangfusePort (createTrace, recordGeneration), GraphExecutorPort (runGraph — used by internal execution route, not facade)
- **Implements ports:** none
- **Contracts:** chat.completions.v1, ai.chat.v1, ai.threads.v1, ai.models.v1, ai.activity.v1

## Responsibilities

- **This feature does:**
  - Provide AI completion services with preflight credit gating and non-blocking post-call billing
  - Apply pricing policy (markup factor from env) via llmPricingPolicy service
  - Provide chat UI integration via assistant-ui
  - Expose model selection UI with localStorage persistence
  - Fetch and cache available models list (server-side cache with SWR)
  - Validate selected models against server-side allowlist
  - Transform between wire formats and domain DTOs
  - Delegate to LlmCaller port for actual LLM calls
  - Record charge receipts via AccountService.recordChargeReceipt (per ACTIVITY_METRICS.md)
  - Record AI invocation telemetry via AiTelemetryPort (per AI_SETUP_SPEC.md)
  - Create Langfuse traces for observability (optional, env-gated)
  - Execute tools via createToolRunner — owns toolCallId, emits AiEvents, redacts payloads

- **This feature does not:**
  - Implement LLM adapters (owned by adapters/server/ai)
  - Manage credits/billing (owned by features/accounts)
  - Persist chat messages to database (owned by route layer via ThreadPersistencePort)
  - Map AiEvents to wire protocol (owned by route layer)
  - Compute promptHash (owned by litellm.adapter.ts, InProc path only)
  - Host LangGraph graph code (owned by apps/langgraph-service/)

## Usage

```typescript
// Chat page with model selection
import { ChatRuntimeProvider, ChatComposerExtras } from "@/features/ai/public";
import { Thread } from "@/components/kit/chat";

<ChatRuntimeProvider onAuthExpired={() => signOut()}>
  <Thread
    composerLeft={
      <ChatComposerExtras
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        defaultModelId={defaultModelId}
      />
    }
  />
</ChatRuntimeProvider>
```

## Standards

- Contract types via z.infer only - no manual interfaces
- Zod runtime validation on route input/output
- All exports via public.ts barrel (stable API surface)
- Server-side cache for models list (5min TTL, SWR)
- Client-side localStorage with SSR guards and graceful degradation
- 409 retry logic when selected model not in server allowlist

## Dependencies

- **Internal:** @/contracts/ai._, @/ports/llm.port, @/shared/env/server, @/components/kit/_, @/components/vendor/assistant-ui, @/components/vendor/shadcn
- **External:** @assistant-ui/react, @assistant-ui/react-markdown, @tanstack/react-query, zod, lucide-react

## Change Protocol

- On wire format change: Update contract (chat.completions.v1, ai.chat.v1, ai.models.v1)
- On public API change: Update public.ts exports and this AGENTS.md
- Breaking changes: Bump contract version
- Keep old versions until callers migrate

## Notes

- Model list fetched from LiteLLM /model/info (cached)
- Chat supports streaming via SSE (v1)
- Thread persistence is P0 (server-authoritative via ThreadPersistencePort; see thread-persistence spec)
- Model validation implements UX-001 (graceful fallback to default)
- Server cache implements PERF-001 (no per-request network calls)
- Post-call billing is non-blocking per ACTIVITY_METRICS.md design
