---
id: observability-spec
type: spec
title: Observability
status: active
trust: draft
summary: JSON logging with event registry, Prometheus metrics, and Alloy shipping to Grafana Cloud
read_when: Implementing logging, metrics, or debugging production issues
owner: derekg1729
created: 2026-02-05
verified: 2026-02-11
tags: [observability]
---

# Observability

**Status:** Structured logging + Loki collection operational; Prometheus metrics operational; client logs not collected

**Purpose:** JSON logging with event registry enforcement + Prometheus metrics, shipped via Alloy to Grafana Cloud Loki/Mimir for production debugging and dashboards.

---

## Architecture

**Current location:** `src/shared/observability/` (per-node copy)
**Target location:** `@cogni/node-shared` (PURE_LIBRARY capability package, task.0248)

```
shared/observability/           # → @cogni/node-shared/observability
├── events/
│   ├── index.ts                # EVENT_NAMES registry + EventName + EventBase
│   ├── ai.ts                   # AiLlmCallEvent (strict payload)
│   └── payments.ts             # Payment event payloads (strict)
├── server/                     # Pino-based
│   ├── logger.ts               # Factory: makeLogger({ nodeId }) — binds nodeId to every line
│   ├── logEvent.ts             # Type-safe wrapper
│   ├── metrics.ts              # prom-client registry (node_id default label)
│   └── helpers.ts              # Request lifecycle
├── context/                    # RequestContext factory (reqId, traceId)
└── client/                     # Console-based (no shipping)
    ├── logger.ts               # Browser logger
    └── index.ts
```

**Flow:** App (JSON stdout) → Docker → Alloy → Loki (local dev or cloud)

**Environments:**

- `local` - Docker stack with local Loki (http://localhost:3001)
- `preview` - Staging deploys → Grafana Cloud
- `production` - Live deploys → Grafana Cloud
- `ci` - GitHub Actions → Grafana Cloud

---

## Key Files

**Event Registry (single source of truth):**

- `src/shared/observability/events/index.ts` - EVENT_NAMES as const, EventName union, EventBase interface
- `src/shared/observability/events/ai.ts` - Strict payload types for AI domain (AiLlmCallEvent)
- `src/shared/observability/events/payments.ts` - Strict payload types for payments domain

**Server Logging:**

- `src/shared/observability/server/logger.ts` - Pino factory (sync mode, zero buffering)
- `src/shared/observability/server/logEvent.ts` - Type-safe event logger (enforces reqId + event name from registry)
- `src/shared/observability/server/helpers.ts` - logRequestStart/End/Error wrappers

**Client Logging:**

- `src/shared/observability/client/logger.ts` - Browser console logger (uses EVENT_NAMES registry, no shipping)

**Context:**

- `src/shared/observability/context/` - RequestContext factory with reqId validation

**Infrastructure:**

- `infra/grafana/dashboards/` - Grafana Cloud dashboard JSON, synced by Grafana Git Sync
- `infra/grafana/alerts/` - Grafana alerting resources as code; Git Sync does not support alerts yet
- `infra/compose/runtime/configs/alloy-config.alloy` - Logs only (local dev)
- `infra/compose/runtime/configs/alloy-config.metrics.alloy` - Logs + metrics (preview/prod)
- `infra/compose/runtime/docker-compose.yml` - Prod stack (uses metrics config)
- `infra/compose/runtime/docker-compose.dev.yml` - Dev stack (uses logs-only config)
- `.mcp.json` - Grafana MCP servers for log querying

---

## Logging Contract

**Cardinal Rules:**

- All event names MUST be in EVENT_NAMES registry (prevents ad-hoc strings)
- All server events MUST include `reqId` (enforced by logEvent(), fail-closed)
- All server events MUST include `traceId` (from OTel root span)
- AI events SHOULD include `litellmCallId` and `langfuseTraceId` when available
- No sensitive payloads (prompts, request bodies, secrets, PII)
- 2-6 events per request max
- Every operation has deterministic terminal outcome (success OR failure)

**Event Naming Convention:**

- Server: `ai.*`, `payments.*`, `adapter.*`, `inv_*`
- Client: `client.ai.*`, `client.payments.*`

**Streaming Events:**

- Split durations: `handlerMs` (until Response returned), `streamMs` (until stream closed)
- Deterministic terminal: exactly one of `ai.llm_call_completed` OR `ai.chat_stream_finalization_lost` (15s timeout)
- Client abort: `cancel()` handler logs `ai.chat_client_aborted`

---

## Labels (Indexed, Low-Cardinality)

- `app="cogni-template"` - Always
- `env="local|preview|production|ci"` - From DEPLOY_ENVIRONMENT
- `service="app|poly|resy|litellm|caddy|deployment"` - Docker compose service name (one per node container when multi-node deploys)
- `stream="stdout|stderr"` - Log stream

**High-cardinality fields** (in JSON, NOT labels): `nodeId`, `reqId`, `traceId`, `spanId`, `langfuseTraceId`, `litellmCallId`, `userId`, `billingAccountId`, `model`, `time`

---

## Multi-Node Identity

**Invariant: NODE_IDENTITY_IN_OBSERVABILITY** — Every log line and every metric series from a node process MUST carry that node's identity. Without this, multi-node production debugging is impossible.

**Source of truth:** `.cogni/repo-spec.yaml` → `node_id` (UUID). This is the same identity used for billing routing, ledger scoping, and inter-node communication. See [Multi-Node Tenancy](multi-node-tenancy.md).

**Resolution chain:**

```
.cogni/repo-spec.yaml   (canonical, committed)
       ↓
getNodeId()              (shared/config — reads repo-spec, caches)
       ↓
bootstrap/container.ts   (resolves BEFORE logger creation)
       ↓
makeLogger({ nodeId })   (binds to pino base — every log line inherits)
metricsRegistry          (node_id default label — every metric series inherits)
```

**Rules:**

| Rule                          | Detail                                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REPO_SPEC_IS_SOURCE           | `nodeId` comes from `getNodeId()` (repo-spec), never from a hand-authored env var. Both live in `@cogni/node-shared`.                                                                                                   |
| NODEID_IN_JSON_NOT_LABEL      | `nodeId` is a structured JSON field in log lines, NOT an indexed Loki label. Filter via `\| json \| nodeId="..."`. At current scale (3 nodes) `node_id` as a Prometheus metric label is acceptable.                     |
| SERVICE_IS_NODE_DISCRIMINATOR | In Docker compose, each node gets a distinct service name (`app`, `poly`, `resy`). Alloy extracts this as the low-cardinality indexed `service` label. This is the primary Loki index discriminator for node filtering. |
| EVENTS_ARE_DOMAIN_SCOPED      | Event names are domain-scoped (`ai.*`, `payments.*`, `adapter.*`), never node-scoped. Do NOT create `poly.ai.*` or `resy.payments.*` event names. Node identity is in the `nodeId` field, not the event name.           |
| INTERNODE_LOGS_BOTH_SIDES     | Inter-node calls (billing callbacks, SSO, future federation) MUST log both `sourceNodeId` and `targetNodeId` so cross-node flows are traceable.                                                                         |

**Operator vs node visibility:**

| Audience             | Sees                              | How                                                                     |
| -------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| Operator dashboards  | All nodes' metrics + logs         | Grafana queries across all `node_id` / `service` values                 |
| Node agent (AI)      | Own node's data only              | Grafana MCP queries filtered to `nodeId="<self>"` or `service="<name>"` |
| Cross-node debugging | Correlated by `reqId` / `traceId` | LogQL join on `reqId` across services                                   |

**Python services (LiteLLM, etc.):** Must emit structured JSON logs with `nodeId` field. Plain-text Python `logging` output is not acceptable — it doesn't parse in Loki's JSON pipeline. Use a JSON formatter. See [bug.0261](../../work/items/bug.0261.cogni-node-router-production-reliability.md).

**Implementation status:**

- [x] `makeLogger()` receives `nodeId` from container bootstrap (resolves via `getNodeId()`) — task.0272
- [x] `metricsRegistry.setDefaultLabels()` includes `node_id` from `readNodeIdForMetrics()` — task.0272
- [ ] Both `getNodeId()` and logger/metrics factory in `@cogni/node-shared` (task.0248)
- [ ] Alloy allowlist updated for per-node service names (task.0247)
- [ ] Python services emit JSON logs (bug.0261)

---

## Context Propagation

`reqId`, `nodeId`, and trace context propagate through all adapters, tools, and graphs:

- `nodeId` bound to logger at bootstrap — inherited by all child loggers automatically
- `reqId` attached as OTel span attribute (`cogni.request_id`)
- `reqId` + `traceId` forwarded in LiteLLM metadata for correlation
- Child loggers inherit `reqId` + `traceId` + `nodeId` from parent bindings
- `userId` bound onto the request-scoped child logger by `createRequestContext` when the session is resolved (authenticated requests only); all envelope + downstream feature logs inherit it. Anonymous / `mode:"none"` routes emit no `userId`.

---

## Usage

**Server Logging:**

```typescript
import { EVENT_NAMES, logEvent } from "@/shared/observability";

ctx.log.info(
  { reqId: ctx.reqId, model: "gpt-5", streamMs: 1234 },
  EVENT_NAMES.AI_CHAT_STREAM_CLOSED
);

// Or with logEvent for type safety:
logEvent(ctx.log, EVENT_NAMES.AI_CHAT_RECEIVED, {
  reqId: ctx.reqId,
  userId,
  stream: true,
  requestedModel: "gpt-5",
  messageCount: 3,
});
```

**Client Logging:**

```typescript
import { clientLogger, EVENT_NAMES } from "@/shared/observability";

clientLogger.warn(EVENT_NAMES.CLIENT_CHAT_STREAM_ERROR, { messageId });
```

**LogQL Queries:**

```logql
# All production errors (operator only)
{app="cogni-template", env="production", service="app"} | json | level="error"

# All production errors (all nodes)
{app="cogni-template", env="production"} | json | level="error"

# Filter to a specific node by UUID
{service="poly"} | json | nodeId="5ed2d64f-2745-4676-983b-2fb7e05b2eba"

# Trace specific request across nodes
{app="cogni-template"} | json | reqId="abc-123"

# AI calls on a specific node
{service="resy"} | json | event="ai.llm_call_completed"
```

---

## Metrics (Prometheus-format)

**Purpose:** Alertable numeric signals (rates/latency/tokens/cost) complementary to logs.

**Flow:** App (`GET /api/metrics`) → Alloy `prometheus.scrape` → Grafana Cloud Mimir
**Infra flow:** Alloy built-in exporters (cAdvisor + node) → `prometheus.relabel` allowlist → Mimir

**Endpoint:** `GET /api/metrics` (Bearer auth required in production)

**Config:** `alloy-config.metrics.alloy` (preview/prod — logs + app metrics + infra metrics); `alloy-config.alloy` (local dev, logs-only)

**Registry:** `src/shared/observability/server/metrics.ts` - prom-client registry + metric definitions

**Recorded at:**

- HTTP: `wrapRouteHandlerWithLogging` - request count + handler duration (finally block)
- Chat SSE: `ai.chat_stream_closed` - stream duration
- LLM: `ai.llm_call_completed` + error paths - duration/tokens/cost/errors

**Core app metrics:** `http_requests_total`, `http_request_duration_ms`, `ai_chat_stream_duration_ms`, `ai_llm_call_duration_ms`, `ai_llm_tokens_total`, `ai_llm_cost_usd_total`, `ai_llm_errors_total`

**Infra metrics (via Alloy exporters, strict allowlist):** `container_memory_working_set_bytes`, `container_memory_rss`, `container_spec_memory_limit_bytes`, `container_cpu_usage_seconds_total`, `container_oom_events_total`, `container_network_*`, `container_fs_*`, `node_filesystem_avail_bytes` (excl. tmpfs/overlay), `node_memory_MemAvailable_bytes`, `node_cpu_seconds_total`, `node_network_*`, `up`

**Labels:** All low-cardinality—`route` (routeId), `method`, `status` (2xx/4xx/5xx), `provider`, `model_class` (free/standard/premium), `code` (`AiExecutionErrorCode` — pre-normalized, no heuristics)

**Error Metrics:** `ai_llm_errors_total` receives pre-normalized `AiExecutionErrorCode` from the completion layer. Metrics never introspect error objects or use string heuristics. See [Error Handling Architecture](ERROR_HANDLING_ARCHITECTURE.md#ai-execution-errors).

---

## Current Shortcomings

**Critical (blocks incident detection) — see [Required Observability Spec](observability-requirements.md):**

- ❌ No Node.js process metrics (`collectDefaultMetrics()` not called — heap/RSS/GC invisible)
- ❌ No heartbeat metric (app death indistinguishable from quiet period)
- ❌ No container resource limits in compose (unbounded memory → unattributable OOM kills)
- ⚠️ Grafana alert rules designed but not yet created (post-deploy — requires metrics flowing)
- ✅ Container OOM detection via cAdvisor `container_oom_events_total` metric (task.0027)
- ✅ Container memory pressure visible via `container_memory_rss` / `container_spec_memory_limit_bytes` (task.0027)
- ❌ Dockerfile HEALTHCHECK timeout (2s) shorter than readyz budget (8s)
- ❌ `/readyz` skips database connectivity check

**Not Yet Implemented:**

- ✅ `nodeId` in logger base bindings and metrics default labels (NODE_IDENTITY_IN_OBSERVABILITY — task.0272)
- ❌ Client logs not collected (console-only, no shipping pipeline)
- ❌ No Grafana dashboards
- ❌ No OTel trace exporter (SDK initialized, no OTLP endpoint)
- ❌ Python services (LiteLLM callbacks) emit plain-text logs, not JSON (bug.0261)
- ❌ No `internode.*` event names in registry (needed when inter-node communication grows)

**Technical Debt:**

- Client code still uses old string literals (not EVENT_NAMES constants) - 27 TypeScript errors
- logEvent() created but not yet used (still using ctx.log.info directly)

---

## Key Invariants

1. **Event registry enforcement:** No new event names without updating EVENT_NAMES (prevents schema drift)
2. **Sync logging:** `pino.destination({ sync: true, minLength: 0 })` prevents delayed/buffered logs under SSE
3. **Fail-closed reqId:** logEvent() throws if reqId missing (never emit malformed events)
4. **No sensitive data:** Redact paths cover passwords, keys, tokens; never log prompts or full request bodies
5. **Streaming determinism:** Every SSE request emits exactly one terminal event (completed OR finalization_lost)
6. **NODE_IDENTITY_IN_OBSERVABILITY:** Every log line and metric series carries `nodeId` from repo-spec. See [Multi-Node Identity](#multi-node-identity).

---

## Langfuse Integration (AI Trace Visibility)

**Purpose:** Langfuse is the canonical visibility surface for prompts/responses + tool usage + outcomes. Logs (Loki) contain only IDs/hashes; Langfuse contains scrubbed content for debugging.

**Architecture:** App creates trace (scrubbed I/O) via `ObservabilityGraphExecutorDecorator`; LiteLLM creates generation observations (full messages, tokens, latency) via its `success_callback: ["langfuse"]` integration. Generations attach to app trace via `existing_trace_id` in LiteLLM metadata.

### Langfuse Invariants

1. **LANGFUSE_NO_PROMPTS_IN_LOKI:** Prompts/responses only in Langfuse (scrubbed), never in Loki logs
2. **LANGFUSE_SCRUB_BEFORE_SEND:** All content passes through structured redaction before Langfuse transmission
3. **LANGFUSE_OTEL_TRACE_CORRELATION:** Use OTel `ctx.traceId` as Langfuse trace ID; validate 32-hex or fallback with correlation
4. **LANGFUSE_TERMINAL_ONCE_GUARD:** Exactly one terminal outcome per trace (success/error/aborted/finalization_lost); atomic guard prevents duplicates
5. **LANGFUSE_TOOL_SPANS_NOT_LOGS:** Tool executions create Langfuse spans, NOT log events (keep 2-4 events per request)
6. **LANGFUSE_SESSION_LIMIT:** sessionId <=200 chars; truncate or reject before sending
7. **LANGFUSE_USER_OPT_OUT:** Per-user `maskContent=true` sends hashes only (no readable content)
8. **LANGFUSE_PAYLOAD_CAPS:** Hard limits on trace/generation/tool span I/O size; exceeded => summary + hash + bytes only
9. **LANGFUSE_NODE_ATTRIBUTION:** Every trace carries `nodeId` (= repo-spec `node_id`) as a tag AND metadata field — the AI-trace twin of `NODE_IDENTITY_IN_OBSERVABILITY` for logs. Without it the shared Langfuse project (one project, all nodes — `LANGFUSE_*` is `shared:true`) cannot be filtered to one node, so a node dev cannot read only their traces. Wired in the shared `ObservabilityGraphExecutorDecorator` (`config.nodeId`, injected app-side — the PURE_LIBRARY package never reads repo-spec) and the operator factory (`container.nodeId`); a warn-once fires if a node leaves it unwired. ⚠️ node-template wires the same one line next (the decorator change is non-breaking — `nodeId` is optional). See [Substrate Access-Grant Plane](./substrate-access-grant.md).
10. **LANGFUSE_DEV_READ_IS_PROXIED:** A `developer`-grant dev reads their node's traces through `GET /api/v1/nodes/{id}/observability/traces` — the operator runs the trace-list AND-ed with `nodeId=<id>` via the operator-held key. The dev NEVER holds `LANGFUSE_SECRET_KEY` (it reads the whole shared project = every node's traces — same reach correction as the Grafana proxy).

### Trace Contract

| Field       | Source                                                          | Requirement                                                                                       |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `id`        | `ctx.traceId` (OTel)                                            | 32-hex validated; fallback generates ID + stores otelTraceId in metadata                          |
| `sessionId` | `caller.sessionId`                                              | <=200 chars; truncate if exceeded                                                                 |
| `userId`    | `caller.userId`                                                 | Stable internal ID (not email); in metadata, NOT as tag                                           |
| `input`     | Scrubbed messages                                               | Non-null; last user message + structure (scrubbed)                                                |
| `output`    | Scrubbed response                                               | Non-null; set on terminal outcome (scrubbed)                                                      |
| `tags`      | `[providerId, graphId, nodeId]`                                 | Low-cardinality only; NO userId. `nodeId` is the per-node read filter (LANGFUSE_NODE_ATTRIBUTION) |
| `metadata`  | `{runId, reqId, graphId, providerId, nodeId, billingAccountId}` | Correlation keys; `nodeId` = repo-spec `node_id`                                                  |

### Terminal States (exactly one per trace)

| State               | Condition                                  | Timer                                     |
| ------------------- | ------------------------------------------ | ----------------------------------------- |
| `success`           | `assistant_final` emitted before `done`    | —                                         |
| `error`             | Exception thrown or error event            | —                                         |
| `aborted`           | AbortSignal fired                          | —                                         |
| `finalization_lost` | 15s after `done` without `assistant_final` | Starts on `done`, cleared on any terminal |

### Scrubbing Policy

**Structured redaction (not regex-only):**

- Redact by key name: `token`, `secret`, `key`, `password`, `auth`, `cookie`, `bearer`
- Recurse objects with maxDepth limit
- Apply regex scrubs to string leaves (API keys, emails, cards)
- Always compute hash of raw serialized input for log correlation

**Payload limits:**

- Trace input/output: 50KB max; exceeded => `{summary, hash, bytes}`
- Generation input/output: 100KB max; exceeded => `{summary, hash, bytes}`
- Tool span input/output: 10KB max; exceeded => `{summary, hash, bytes}`

### Log Events (2-4 per request)

| Event                      | Fields                                     | When                   |
| -------------------------- | ------------------------------------------ | ---------------------- |
| `langfuse.trace_created`   | `reqId, traceId, langfuseTraceId, graphId` | On `runGraph()` start  |
| `langfuse.trace_completed` | `reqId, traceId, langfuseTraceId, outcome` | On terminal resolution |

**NOT logged:** Tool span creation/completion (visible in Langfuse UI only)

### Implementation Status

- [x] Add `LANGFUSE_TRACE_CREATED`, `LANGFUSE_TRACE_COMPLETED` to `EVENT_NAMES` (`src/shared/observability/events/index.ts`)
- [x] Create structured redaction utility (`src/shared/ai/content-scrubbing.ts`)
- [x] Create `ObservabilityGraphExecutorDecorator` (`src/adapters/server/ai/observability-executor.decorator.ts`)
- [x] Add `startSpan()`, `updateTraceOutput()` to `LangfuseAdapter` (`src/adapters/server/ai-telemetry/langfuse.adapter.ts`)
- [x] Add span infrastructure to `createToolRunner()` (`@cogni/ai-core/tooling/tool-runner.ts`) — wiring deferred (tool visibility via generation messages)
- [x] Add `sessionId`, `userId`, `maskContent` to `LlmCaller` interface (`src/ports/llm.port.ts`)
- [x] Wire decorator in `graph-executor.factory.ts` (`src/bootstrap/graph-executor.factory.ts`)
- [x] Validate traceId format (32-hex) with fallback (`src/adapters/server/ai/observability-executor.decorator.ts`)
- [x] Add stack test: trace with non-null IO and terminal outcome (`tests/stack/ai/langfuse-observability.stack.test.ts`)

### Tool Span Payload Policy

**Invariant:** `@cogni/ai-core` emits metadata-only spans by default (toolCallId, toolName, effect, status, elapsedMs, errorCode). Raw args/results are never sent from ai-core.

**Adapter responsibility:** Langfuse adapter may attach scrubbed+size-capped payload via `spanInput`/`spanOutput` hooks. Adapters must enforce size caps + masking before sending.

**Open work:**

- [ ] Review tool-runner span scrubbing: ensure `spanInput`/`spanOutput` hooks are wired from composition root with content-scrubbing functions

### Langfuse API Verification

Query recent traces (requires `LANGFUSE_*` vars in `.env.local`):

```bash
pnpm langfuse:trace
```

---

## References

- [Required Observability Spec](observability-requirements.md) - P0/P1 remediation plan for silent death detection
- [Alloy Loki Setup](../guides/alloy-loki-setup.md) - Complete infrastructure setup
- [Observability Guide](.claude/commands/logging.md) - Developer guidelines
- Grafana Cloud: https://grafana.com/products/cloud/
- Loki docs: https://grafana.com/docs/loki/
