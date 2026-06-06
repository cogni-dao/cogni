# ai · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

AI service adapters including LiteLLM completion/streaming, usage telemetry, agent discovery via AgentCatalogProvider + AggregatingAgentCatalog, and graph execution via GraphExecutorPort + NamespaceGraphRouter.

## Pointers

- [LlmService port](../../../ports/llm.port.ts)
- [AgentCatalogPort](../../../ports/agent-catalog.port.ts)
- [GraphExecutorPort](../../../../../../packages/graph-execution-core/src/graph-executor.port.ts)
- [Agent Discovery Design](../../../../../../docs/spec/agent-discovery.md)
- [LiteLLM configuration](../../../../../../infra/compose/runtime/configs/)
- [Activity Metrics Design](../../../../../../docs/spec/activity-metrics.md)
- [Graph Execution Design](../../../../../../docs/spec/graph-execution.md)
- [LangGraph Server Design](../../../../../../docs/spec/langgraph-server.md)
- [Thread Persistence Spec](../../../../../../docs/spec/thread-persistence.md)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["adapters/server", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:** LiteLlmAdapter (LlmService), LiteLlmActivityUsageAdapter (ActivityUsagePort), LiteLlmUsageServiceAdapter (UsageService), InProcCompletionUnitAdapter (completion unit execution), AgentCatalogProvider (discovery interface), AggregatingAgentCatalog (AgentCatalogPort), LangGraphInProcAgentCatalogProvider, NamespaceGraphRouter (execution routing), LangGraphInProcProvider (GraphExecutorPort), ObservabilityGraphExecutorDecorator, BillingEnrichmentGraphExecutorDecorator, UsageCommitDecorator (validates + commits BYO usage receipts), PreflightCreditCheckDecorator (uses ModelProviderResolverPort for billing policy), TavilyWebSearchAdapter, DrizzleThreadPersistenceAdapter, RedisRunStreamAdapter, PlatformModelProvider (ModelProviderPort for LiteLLM/OpenRouter), CodexModelProvider (ModelProviderPort for BYO ChatGPT), OpenAiCompatibleModelProvider (ModelProviderPort for user-hosted Ollama/vLLM/llama.cpp), OpenAiCompatibleLlmAdapter (LlmService for /v1/chat/completions endpoints), AggregatingModelCatalog (ModelCatalogPort), ProviderResolver (ModelProviderResolverPort)
- **Env/Config keys:** LITELLM_BASE_URL, LITELLM_MASTER_KEY (model param required - no env fallback), TAVILY_API_KEY (for web search), REDIS_URL (stream plane)
- **Files considered API:** litellm.adapter.ts, inproc-completion-unit.adapter.ts, agent-catalog.provider.ts, aggregating-agent-catalog.ts, aggregating-executor.ts, langgraph/inproc-agent-catalog.provider.ts, langgraph/inproc.provider.ts, observability-executor.decorator.ts, usage-commit.decorator.ts, preflight-credit-check.decorator.ts, tavily-web-search.adapter.ts, thread-persistence.adapter.ts, redis-run-stream.adapter.ts, execution-scope.ts
- **Streaming:** completionStream() supports SSE streaming via eventsource-parser with robustness against malformed chunks

## Ports (optional)

- **Uses ports:** ModelProviderResolverPort (PreflightCreditCheckDecorator)
- **Implements ports:** LlmService, ActivityUsagePort, UsageService, AgentCatalogPort, GraphExecutorPort, ThreadPersistencePort, ModelProviderPort, ModelCatalogPort, ModelProviderResolverPort
- **Contracts (required if implementing):** LlmService contract tests in tests/contract/, usage adapter tests in tests/unit/adapters/

## Responsibilities

- This directory **does**: Implement LlmService for AI completions and streaming (with tool message format support); implement ActivityUsagePort for LiteLLM usage logs (read-only, powers Activity dashboard); implement UsageService adapter mapping usage logs to usage stats; implement AgentCatalogPort via AggregatingAgentCatalog (discovery-only, fans out to AgentCatalogProvider[]); implement GraphExecutorPort via NamespaceGraphRouter (routes graphId to execution providers); emit neutral usage facts from inner providers and attach billing identity in a wrapper decorator; provide AgentCatalogProvider and GraphExecutorPort interfaces; provide LangGraphInProcAgentCatalogProvider (discovery) and LangGraphInProcProvider (execution)
- This directory **does not**: Handle authentication, rate limiting, or timestamps. UsageCommitDecorator writes BYO charge receipts (via injected commitUsageFact); platform receipts are written by the LiteLLM callback route.

## Usage

Minimal local commands:

```bash
pnpm test tests/component/ai/
```

## Standards

- Never logs prompts or API keys for security
- Enforces 15s connect timeout for streaming (fetch TTFB only)
- Handles provider-specific response formatting
- Streaming malformed SSE chunks logged as warnings without failing stream
- Promise settlement guaranteed exactly once via defer helper
- Usage logs: bounded scan up to MAX_RANGE_LIMIT (5000), pass-through data from LiteLLM (no local recomputation)
- Usage adapter throws ActivityUsageUnavailableError on LiteLLM failures (never silent degradation)
- getSpendLogs avoids date params (cause aggregation), fetches individual logs, filters in-memory by timestamp
- Bounded scan validation: throws TooManyLogsError (422) if range incomplete after MAX_LOGS_PER_RANGE fetch
- Tool message format: liteLlmMessages includes tool_calls (assistant) and tool_call_id (tool role) for agentic loop
- Discovery/Execution split: AgentCatalogProvider for discovery (no execution deps), GraphExecutorPort for execution
- AgentCatalogProvider pattern: listAgents() returns AgentDescriptor[]; AggregatingAgentCatalog fans out to providers
- GraphExecutorPort pattern: providerId prefixes graphId (e.g., "langgraph:poet"); NamespaceGraphRouter routes to registered providers
- langgraph/ subdirectory: LangGraphInProcAgentCatalogProvider (discovery) and LangGraphInProcProvider (execution) wire @cogni/langgraph-graphs catalog. InProcProvider passes `responseFormat` through to graph factory and `structuredOutput` back to `GraphFinal`.
- TavilyWebSearchAdapter: HARD_CAPS_ENFORCED_AT_TOOL_BOUNDARY — maxResults capped at 5, title≤120, snippet≤160 chars regardless of caller requests

## Dependencies

- **Internal:** ports, shared/env, shared/observability/logging
- **External:** LiteLLM service (external HTTP API), eventsource-parser (npm)

## Change Protocol

- Update this file when **Exports** or **Env/Config** change
- Bump **Last reviewed** date
- Ensure boundary lint + contract tests pass

## Notes

- Used in production for real LLM completions
- Connects to LiteLLM proxy service for provider abstraction
- InProcCompletionUnitAdapter fails the run if LiteLLM response lacks call ID (prevents silent under-billing)
- All providers thread graphId through to UsageFact for per-agent analytics
- ExecutionScope (AsyncLocalStorage): carries llmService, usageSource, billing identity, and abortSignal per-request. Set by graph-executor.factory.ts before graph invocation.
- UsageCommitDecorator: consumes usage_report events from stream, validates via Zod, commits BYO receipts directly (platform deferred to LiteLLM callback). Events are consumed (not forwarded downstream).
