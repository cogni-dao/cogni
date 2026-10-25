---
id: billing-ingest-spec
type: spec
title: "Billing Ingest: Callback-Driven, Port-Level Billing"
status: active
spec_state: active
trust: reviewed
summary: "Canonicalize billing at GraphExecutorPort: LiteLLM custom callback writes receipts per-node, adapters only emit usage_unit_created{call_id}, decorator logs for observability. Async reconciliation catches missing callbacks."
read_when: Working on billing pipeline, LiteLLM integration, sandbox billing, or charge receipt reconciliation.
implements: proj.unified-graph-launch
owner: derekg1729
created: 2026-02-11
verified: 2026-02-14
tags: [billing, litellm, sandbox]
---

# Billing Ingest: Callback-Driven, Port-Level Billing

> Billing is canonicalized at GraphExecutorPort. Adapters never implement billing — they only emit `usage_unit_created{call_id}`. Cost data comes from a single source (LiteLLM custom callback). In multi-node deployments, the callback routes each completion to the correct node's ingest endpoint using the authenticated virtual-key workload alias; verified master-key traffic retains local node routing. The decorator logs call_ids for observability; a periodic reconciliation job catches missing receipts. **No synchronous receipt barrier blocks the user response.**

### Key References

|             |                                                                                      |                                                     |
| ----------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| **Project** | [proj.unified-graph-launch](../../work/projects/proj.unified-graph-launch.md)        | Unified execution roadmap                           |
| **Spec**    | [billing-evolution](./billing-evolution.md)                                          | Charge receipt schema, credit unit                  |
| **Spec**    | [billing-sandbox](./billing-sandbox.md)                                              | Current proxy audit log pipeline (to be superseded) |
| **Spec**    | [external-executor-billing](./external-executor-billing.md)                          | Reconciliation design                               |
| **Spec**    | [multi-node-tenancy](./multi-node-tenancy.md)                                        | Per-node DB isolation, callback routing invariants  |
| **Task**    | [task.0029](../../work/items/task.0029.callback-driven-billing-kill-log-scraping.md) | Original callback billing implementation            |
| **Task**    | [task.0039](../../work/items/task.0039.billing-reconciler-worker.md)                 | Reconciliation worker (companion)                   |
| **Task**    | [task.0256](../../work/items/task.0256.multi-node-litellm-callback-routing.md)       | Per-node callback routing via custom callback class |

## Core Primitive

**`litellm_call_id`** is the universal billing tracking key. In the callback payload this is the `id` field (same value as the `x-litellm-call-id` response header). LiteLLM assigns it per-call, includes it in response headers _and_ callback payloads. Every component — adapter, ingest endpoint, reconciliation — keys off this single ID.

## Invariants

| Rule                                  | Constraint                                                                                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ONE_BILLING_PATH                      | All billing confirmation is receipt-existence by `litellm_call_id` (platform) or deterministic BYO key. No adapter-specific billing logic, no log parsing, no cost extraction in adapters.                                                |
| ADAPTERS_NEVER_BILL                   | Adapters only emit `usage_report` events. They never parse cost data, read logs, or write receipts. `UsageCommitDecorator` handles commit.                                                                                                |
| COST_ORACLE_IS_LITELLM                | For platform runs, cost comes from LiteLLM callback payload (`response_cost`). BYO runs report `costUsd: 0` (zero platform cost) or adapter-provided cost.                                                                                |
| CALLBACK_WRITES_PLATFORM_RECEIPTS     | LiteLLM callback writes receipts for platform runs. BYO receipts are written directly by `UsageCommitDecorator` via `commitUsageFact()`. Both paths converge on the same idempotent writer.                                               |
| NO_PLACEHOLDER_RECEIPTS               | Never write $0/empty receipts as placeholders. If cost is unknown, defer until authoritative cost arrives via callback (COST_ORACLE_IS_LITELLM) or reconciler (task.0039).                                                                |
| CHARGE_RECEIPTS_IDEMPOTENT_BY_CALL_ID | `UNIQUE(source_system, source_reference)` where `source_reference` includes `litellm_call_id`. Duplicate callbacks are no-ops (swallowed by commitUsageFact, HTTP 200).                                                                   |
| NO_SYNCHRONOUS_RECEIPT_BARRIER        | The user response is NEVER blocked waiting for callback receipt arrival. Reconciliation is async (task.0039).                                                                                                                             |
| CALLBACK_AUTHENTICATED                | Ingest endpoint requires `Authorization: Bearer BILLING_INGEST_TOKEN`.                                                                                                                                                                    |
| INGEST_ENDPOINT_IS_INTERNAL           | `/api/internal/billing/ingest` is a service-authenticated endpoint. Same-host deployments use internal transport; off-cluster Akash workloads use their catalog-derived public HTTPS endpoint with the same required ingest bearer token. |
| NO_DOCKER_SOCK_IN_APP                 | App container never mounts docker.sock or uses dockerode for billing. (Preserved from bug.0027 bridge fix.)                                                                                                                               |
| BILLING_CORRELATION_BY_RUN_ID         | Gateway mode correlates billing by `metadata.spend_logs_metadata.run_id` from the callback, not by per-call barrier. Requires `x-litellm-spend-logs-metadata` header set with `run_id`.                                                   |

## Design

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ ADAPTER (any executor type)                                         │
│                                                                     │
│  1. Makes LLM call through LiteLLM proxy                           │
│  2. Reads x-litellm-call-id from response header (if available)    │
│  3. Emits: usage_unit_created { call_id, runId, billingAccountId }  │
│  4. Adapter is DONE with billing. No cost parsing. No log reads.   │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ (stream event)
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ BillingGraphExecutorDecorator (at GraphExecutorPort level)           │
│                                                                     │
│  1. Collects call_ids from usage_unit_created events                │
│  2. Consumes these events (not yielded downstream)                  │
│  3. Logs collected call_ids at end-of-run for observability         │
│  4. Does NOT block on receipt existence (async reconciliation)      │
└─────────────────────────────────────────────────────────────────────┘

                    ┌── callback fires async ──┐
                    ▼                           │
┌─────────────────────────────────────────────────────────────────────┐
│ LiteLLM Proxy (cost oracle) + CogniNodeRouter callback              │
│                                                                     │
│  On every successful LLM call:                                      │
│  1. Computes response_cost                                          │
│  2. Read server-stamped user_api_key_alias + user_api_key_hash        │
│  3. Route exact cogni:<lane>:<node UUID>:app:v1 via endpoint map       │
│     Reject conflicting node_id or unknown authenticated identity     │
│  4. Verified master key alone may use local legacy node/default       │
│     Forward provider payload unchanged (AUTHENTICATED_WORKLOAD_ROUTING)│
└──────────────────────┬──────────────────────────────────────────────┘
                       │ (per-completion, not batched)
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ POST /api/internal/billing/ingest (per-node)                        │
│                                                                     │
│  1. Validate payload array (Zod)                                    │
│  2. For each entry: commitUsageFact() → recordChargeReceipt()       │
│  3. UPSERT by (source_system, source_reference=call_id)             │
│  4. Return 200 OK (duplicates are no-ops internally)                │
│  5. Each node writes to its own DB (DB_PER_NODE)                    │
└─────────────────────────────────────────────────────────────────────┘

                       ┌── periodic (task.0039) ──┐
                       ▼                           │
┌─────────────────────────────────────────────────────────────────────┐
│ Reconciliation Worker (in scheduler-worker, setInterval)            │
│                                                                     │
│  1. GET /spend/logs from LiteLLM API (trailing window)              │
│  2. Bulk query charge_receipts by litellm_call_id                   │
│  3. DIFF: spend_log_ids minus receipt_ids = missing                 │
│  4. REPLAY: commitUsageFact() per missing entry (idempotent)        │
│  5. ALERT: structured log + metric if missing persists              │
│  6. Never blocks user response — purely async                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Ingest Endpoint

A standard Next.js internal API route. Not a hex port — just delivery-layer wiring that calls `commitUsageFact()`.

- Path: `POST /api/internal/billing/ingest`
- Auth: `Authorization: Bearer BILLING_INGEST_TOKEN`
- Body: `List[StandardLoggingPayload]` (LiteLLM sends batched arrays)
- Response: `200 OK` (receipts written; duplicates are no-ops internally)

### Adapter Contract

Adapters emit a single event type for billing:

```typescript
// What adapters emit — nothing else billing-related
yield {
  type: "usage_unit_created",
  callId: litellmCallId,      // x-litellm-call-id from response header
  runId,
  billingAccountId,
  model,                       // optional — for observability, not billing
};
```

Adapters do NOT:

- Parse `response_cost` or `providerCostUsd`
- Read nginx audit logs or billing files
- Construct `UsageFact` with cost fields
- Call `commitUsageFact()` or `recordChargeReceipt()`

### Decorator Change

The existing `BillingGraphExecutorDecorator` currently intercepts `usage_report` events and writes receipts inline during stream consumption. After this change:

1. Intercepts `usage_unit_created` events (replaces `usage_report`)
2. Collects call_ids into a set for observability logging
3. Consumes events (not yielded downstream)
4. At end-of-stream: logs collected call_ids (count, run_id) — **no blocking poll**
5. Receipt writing happens async via the LiteLLM callback, not the decorator

The decorator's role shrinks from "billing writer" to "billing event consumer + observability logger". The callback is the sole receipt writer.

### How Executors Get call_id

| Executor                 | call_id source                                                    |
| ------------------------ | ----------------------------------------------------------------- |
| **InProc**               | `x-litellm-call-id` response header (already extracted)           |
| **Sandbox (ephemeral)**  | `x-litellm-call-id` response header via proxy (already forwarded) |
| **Gateway (OpenClaw)**   | Correlated by `run_id` in callback metadata (not per-call)        |
| **External (LangGraph)** | `spend_logs.request_id` or callback metadata                      |

### Callback Payload Schema (Verified)

The callback sends `List[StandardLoggingPayload]` (a JSON array wrapping one entry per POST from the custom callback, or sometimes batched from legacy `generic_api`).

**LiteLLM Configuration:**

```yaml
# litellm.config.yaml
litellm_settings:
  # CogniNodeRouter replaces generic_api — routes per-completion to correct node
  success_callback: ["langfuse", "cogni_callbacks.CogniNodeRouter"]
# Environment variables (on LiteLLM container):
# COGNI_NODE_ENDPOINTS=<local-node-uuid>=http://app:3000,cogni:<lane>:<node-uuid>:app:v1=https://node.example.org
# BILLING_INGEST_TOKEN=<shared-secret>
```

**Actual payload shape** (relevant fields for billing — full payload has ~40 fields):

```typescript
// Zod schema for ingest endpoint — matches LiteLLM StandardLoggingPayload
const StandardLoggingPayloadBilling = z.object({
  id: z.string().min(1), // litellm_call_id (same as x-litellm-call-id header)
  call_type: z.string(), // "acompletion"
  stream: z.boolean(),
  status: z.string(), // "success"
  response_cost: z.number(), // USD cost (0 for free models, >0 for paid)
  model: z.string(), // Full provider model: "google/gemini-2.5-flash"
  model_group: z.string(), // LiteLLM alias: "gemini-2.5-flash"
  custom_llm_provider: z.string(), // "openrouter"
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  total_tokens: z.number().int(),
  end_user: z.string(), // billingAccountId (see End User Routing below)
  metadata: z
    .object({
      spend_logs_metadata: z
        .object({
          // From x-litellm-spend-logs-metadata header
          run_id: z.string(),
          node_id: z.string().optional(), // Must agree with the authenticated virtual-key node; local master routing
          graph_id: z.string().optional(),
          attempt: z.number().int().optional(),
        })
        .nullable(),
      user_api_key_end_user_id: z.string().nullable().optional(),
      requester_custom_headers: z.record(z.string()).optional(),
    })
    .passthrough(), // Allow extra LiteLLM internal fields
});

// The POST body is always an array
const BillingIngestBody = z.array(StandardLoggingPayloadBilling);
```

### End User Routing (Verified Quirk)

The `end_user` field in the callback depends on HOW the caller sets identity:

| Method                             | `end_user` in callback | `metadata.spend_logs_metadata`    |
| ---------------------------------- | ---------------------- | --------------------------------- |
| Request body `user` field          | Populated              | Not set (unless header also sent) |
| `x-litellm-end-user-id` header     | **Empty string**       | Not set                           |
| Both body `user` + metadata header | Populated              | Populated                         |

**Current state by executor:**

| Executor                | Sets `user` body field?              | Sets metadata header?      | `end_user` in callback | `run_id` in callback |
| ----------------------- | ------------------------------------ | -------------------------- | ---------------------- | -------------------- |
| **InProc**              | Yes (`billingAccountId`)             | Yes (via request metadata) | Populated              | Populated            |
| **Gateway (OpenClaw)**  | Yes (via OpenClaw `outboundHeaders`) | **No**                     | Populated              | **MISSING**          |
| **Sandbox (ephemeral)** | No (proxy sets headers)              | Yes (proxy header)         | Empty                  | Populated            |

**Implication:** Gateway mode has `end_user` (for account correlation) but NO `run_id` (for per-run correlation). Fix: add `x-litellm-spend-logs-metadata` to OpenClaw's `outboundHeaders` per session (done in `SandboxGraphProvider.runGateway()`).

## Goal

Canonicalize billing at GraphExecutorPort so adapters never implement billing. Single stable path: LiteLLM callback writes receipts asynchronously. Async reconciliation catches missing callbacks. This eliminates all log-scraping billing paths and makes billing work identically across all executor types and deployment topologies.

## Non-Goals

- Redesigning the charge_receipts schema (reuse existing table and idempotency)
- Changing the credit unit standard or markup policy
- Building a standalone billing microservice (internal API route)
- Real-time billing UI updates
- Synchronous receipt barriers that block user response
- Modifying the unified graph launch workflow architecture

## Migration Path

Callback and log-scraping paths coexisted briefly during cutover:

1. **Add ingest endpoint** — ~~Done (task.0029).~~ `POST /api/internal/billing/ingest` accepting `List[StandardLoggingPayload]`, Zod validation, `commitUsageFact()`, shared-secret auth.
2. **Configure LiteLLM callback** — ~~Done (task.0029, upgraded task.0256).~~ Originally `generic_api` with `GENERIC_LOGGER_ENDPOINT`. Replaced by custom callback class `CogniNodeRouter` (`infra/images/litellm/cogni_callbacks.py`) for per-node routing via `COGNI_NODE_ENDPOINTS` env var.
3. **Per-node callback routing** — ~~Done (task.0256).~~ Each node stamps `node_id` in `spendLogsMetadata`. Custom callback checks it against the authenticated `cogni:<lane>:<node UUID>:app:v1` key alias, then routes by that exact alias. Only a hash-verified master key may use local legacy routes or the missing-node default. The catalog emits aliases only for declared lanes controlled by this gateway.
4. **Fix gateway `run_id` gap** — Not started. Add `x-litellm-spend-logs-metadata` to OpenClaw `outboundHeaders` per session.
5. **Strip billing from adapters** — ~~Done (task.0029).~~ `ProxyBillingReader` deleted, gateway billing removed from `SandboxGraphProvider`, `OPENCLAW_BILLING_DIR` removed. Gateway nginx audit log removed.
6. **Delete old paths** — ~~Done (task.0029).~~ `ProxyBillingReader`, billing volumes, `OPENCLAW_BILLING_DIR`, gateway audit log all removed. `commitUsageFact()` refactored to strict cost-known/unknown branching (COST_AUTHORITY_IS_LITELLM).

## Verified Findings (Spike 2026-02-13)

Tested against running dev:stack with LiteLLM `generic_api` callback pointed at a capture server.

| Question                                                   | Answer                                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does `metadata.spend_logs_metadata` survive into callback? | **Yes** — `run_id`, `graph_id`, `attempt` all present when set via `x-litellm-spend-logs-metadata` header                                                |
| What is the callback mechanism?                            | Custom callback class `CogniNodeRouter` (replaced `generic_api` in task.0256). Routes per-completion to correct node via `COGNI_NODE_ENDPOINTS` env var. |
| Is the payload batched?                                    | Custom callback fires per-completion (1 entry per POST). Legacy `generic_api` batched (2+ entries per POST).                                             |
| Is `id` the same as `x-litellm-call-id`?                   | **Yes** — `id` field = litellm_call_id                                                                                                                   |
| Is `response_cost` present for streaming?                  | **Yes** — accurate costs for paid models (e.g., gemini-2.5-flash: $0.0005-0.003 per call)                                                                |
| Does `end_user` populate from header?                      | **No** — `x-litellm-end-user-id` header → `end_user: ""`. Must use request body `user` field to populate `end_user`                                      |
| Token fields?                                              | `prompt_tokens`, `completion_tokens`, `total_tokens` (not `input_tokens`/`output_tokens`)                                                                |
| `model` vs `model_group`?                                  | `model` = full provider path (`google/gemini-2.5-flash`), `model_group` = LiteLLM alias (`gemini-2.5-flash`)                                             |
| Does gateway set `run_id` in metadata?                     | **No** — live gateway calls have `spend_logs_metadata: null`. Must add `x-litellm-spend-logs-metadata` to OpenClaw outboundHeaders                       |

## Related

- [billing-evolution](./billing-evolution.md) — Charge receipt schema, credit unit standard
- [billing-sandbox](./billing-sandbox.md) — Current proxy audit log pipeline (to be superseded)
- [external-executor-billing](./external-executor-billing.md) — Reconciliation design (converges with this spec)
- [openclaw-sandbox-spec](./openclaw-sandbox-spec.md) — Gateway billing architecture
- [proj.unified-graph-launch](../../work/projects/proj.unified-graph-launch.md) — Unified execution roadmap
