---
id: external-executor-billing-spec
type: spec
title: External Executor Billing Design
status: active
spec_state: draft
trust: draft
summary: Async reconciliation billing for external executors via provider billing APIs, correlated by end_user = billingAccountId.
read_when: Working with external executor billing, LiteLLM spend logs, reconciliation, or adding a new executor type.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [billing, ai-graphs]
---

# External Executor Billing Design

## Context

> [!CRITICAL]
> External executors use **async reconciliation** via provider billing APIs. Identity key is `end_user = billingAccountId` (matching in-proc `LiteLlmAdapter`). Run correlation via `metadata.run_id`. Reconcilers call `commitUsageFact()` per LLM call with `usageUnitId = provider_call_id`.

## Inline vs Reconciliation

**Why Reconciliation for External Executors?**

1. External executor is outside the trusted process that makes LLM calls → inline headers/usage may be missing or untrusted during streaming
2. Streaming UX events are not authoritative → disconnects/retries/partial streams happen; per-call spend logs are authoritative and idempotent
3. Cannot reliably capture trusted `provider_call_id` + usage inline → reconciliation queries server-controlled billing API after completion

**Rule of Thumb**:

- **Inline OK**: Trusted component sees `provider_call_id` + usage inline AND enforces identity injection (in-proc adapter, sandbox proxy). Works for multi-call graphs.
- **Reconciliation Required**: Execution is external/untrusted OR cannot reliably capture `provider_call_id` + usage inline (LangGraph Server, remote OpenClaw).

**Examples**:

- ✅ **InProc**: Trusted adapter captures LiteLLM response → inline billing per call
- ✅ **Sandbox**: Trusted nginx proxy injects headers → inline billing per call (even multi-call OpenClaw agents)
- ⚠️ **LangGraph Server**: External process, no trusted inline capture → reconciliation after stream completes

External executors (LangGraph Server, future n8n/Flowise) run LLM calls outside the main app process, so billing cannot be captured in real-time. Instead, the system queries provider billing APIs after execution completes and reconciles usage into the credit ledger.

The `end_user` correlation mechanism has been validated: `initChatModel({ configurableFields: ["model", "user"] })` propagates `configurable.user` to the OpenAI `user` field, which LiteLLM stores as `end_user` in spend_logs.

## Goal

Provide reliable, idempotent billing for LLM calls made by external executors, using provider billing APIs as the authoritative source and server-controlled correlation keys to prevent billing spoofing.

## Non-Goals

- Real-time billing capture for external executors (that's for in-process adapters only)
- Client-side usage tracking (stream events are UX-only, never authoritative)
- Direct charge_receipts DB writes (always through `commitUsageFact()`)

## Core Invariants

1. **END_USER_IS_BILLING_ACCOUNT**: All executors (in-proc, sandbox, external) set `end_user = billingAccountId`. This matches the in-proc `LiteLlmAdapter` (`user: billingAccountId`) and the activity dashboard query (`/spend/logs?end_user=billingAccountId`). Run correlation uses `metadata.run_id`, NOT `end_user`.

2. **USAGE_UNIT_IS_PROVIDER_CALL_ID**: Each LLM call has a unique `usageUnitId = spend_logs.request_id`. Multiple charge_receipts per run is expected for multi-step graphs.

3. **SERVER_SETS_IDENTITY_NEVER_CLIENT**: Identity headers/fields are server-set. In-proc: `user` body field. Sandbox: proxy overwrites `x-litellm-end-user-id` + `x-litellm-spend-logs-metadata`. External: `configurable.user`. Client values stripped/ignored.

4. **RECONCILE_AFTER_STREAM_COMPLETES**: Reconciliation triggers after stream ends (success or error). No grace window for MVP — LiteLLM writes are synchronous with response.

5. **STREAM_EVENTS_ARE_UX_ONLY**: `usage_report` events from external executors are telemetry hints. Authoritative billing flows through reconciliation only.

6. **ONE_LEDGER_WRITER_PRESERVED**: Reconcilers call `commitUsageFact()` → `recordChargeReceipt()`. Never direct DB writes.

7. **IDEMPOTENCY_VIA_SOURCE_REFERENCE**: `source_reference = ${runId}/${attempt}/${provider_call_id}`. Replayed reconciliation is no-op.

8. **METADATA_PARITY**: All executors must produce equivalent LiteLLM metadata. Required fields: `run_id`, `attempt`, `cogni_billing_account_id`, `request_id`. Langfuse fields: `existing_trace_id`, `session_id`, `trace_user_id`. In-proc sets via request body `metadata`; sandbox sets via `x-litellm-spend-logs-metadata` header; external sets via `configurable`.

## Design

### Reconciliation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ EXECUTION PHASE                                                 │
├─────────────────────────────────────────────────────────────────┤
│ All executors set: end_user = billingAccountId                  │
│ All executors set: metadata.run_id = runId                      │
│ LLM call → LiteLLM stores: end_user + metadata in spend_logs   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ RECONCILIATION PHASE (after stream completes)                   │
├─────────────────────────────────────────────────────────────────┤
│ 1. Query: GET /spend/logs?end_user=${billingAccountId}          │
│    (optionally scoped by start_date/end_date to run window)     │
│ 2. Filter returned logs: entry.metadata.run_id === runId        │
│ 3. For each matching entry:                                     │
│    - usageUnitId = entry.request_id                             │
│    - costUsd = entry.spend                                      │
│    - tokens = entry.prompt_tokens + entry.completion_tokens     │
│ 4. commitUsageFact() per entry                                  │
│ 5. Log metric: external_billing.reconcile_success               │
└─────────────────────────────────────────────────────────────────┘
```

### Provider-Specific Details

#### LangGraph Server (LiteLLM) — MVP

| Aspect          | Value                                                          |
| --------------- | -------------------------------------------------------------- |
| Billing source  | LiteLLM `/spend/logs` API                                      |
| Identity field  | `end_user = billingAccountId` (set via `configurable.user`)    |
| Run correlation | `metadata.run_id` (set via `configurable` or LiteLLM metadata) |
| Call ID field   | `spend_logs.request_id`                                        |
| ExecutorType    | `langgraph_server`                                             |
| SourceSystem    | `litellm`                                                      |

**Validated:** `initChatModel({ configurableFields: ["model", "user"] })` propagates `configurable.user` to OpenAI `user` field → LiteLLM `end_user`.

#### Sandbox (LiteLLM via nginx proxy) — P0.75

| Aspect          | Value                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| Billing source  | LiteLLM `/spend/logs` API                                                        |
| Identity field  | `end_user = billingAccountId` (set via `x-litellm-end-user-id`)                  |
| Run correlation | `metadata.run_id` (set via `x-litellm-spend-logs-metadata` header)               |
| Call ID field   | `spend_logs.request_id` (logged in proxy via `$upstream_http_x_litellm_call_id`) |
| ExecutorType    | `sandbox`                                                                        |
| SourceSystem    | `litellm`                                                                        |

**Mechanism:** Proxy injects `x-litellm-end-user-id` and `x-litellm-spend-logs-metadata` headers. Both overwrite any client-sent values. Sandbox cannot spoof identity. See invariant 7 (HOST_INJECTS_BILLING_HEADER) in [sandbox-billing-pipeline](https://cognidao.org/knowledge/sandbox-billing-pipeline).

#### Claude SDK — P2

| Aspect         | Value                        |
| -------------- | ---------------------------- |
| Billing source | `message.usage` (in-process) |
| Call ID field  | `message.id`                 |
| ExecutorType   | `claude_sdk`                 |
| SourceSystem   | `anthropic_sdk`              |

Decision pending: If SDK runs in-process, use real-time capture (no reconciliation). If external, same pattern with Anthropic usage API.

#### n8n / Flowise — Future

Must route LLM calls through our LiteLLM instance. Same `end_user` correlation pattern applies.

### Anti-Patterns

| Anti-Pattern                            | Why Forbidden                                                     |
| --------------------------------------- | ----------------------------------------------------------------- |
| Trust client-supplied `user`            | Billing spoofing                                                  |
| `end_user = runId/attempt`              | Breaks activity dashboard; use billingAccountId + metadata.run_id |
| Filter by metadata at LiteLLM API level | Not supported; fetch by end_user, filter in-memory                |
| Stream events as billing source         | Unreliable, may drop                                              |
| Skip `attempt` in correlation           | Retries create duplicates                                         |
| Direct charge_receipts mutation         | Violates ONE_LEDGER_WRITER                                        |
| Different `end_user` per executor type  | All executors must use billingAccountId for dashboard parity      |

### New Executor Integration Checklist

Any new executor must answer:

1. **Authoritative billing source?** (API endpoint or in-process capture)
2. **Correlation key we control?** (e.g., `end_user`, `metadata`, header)
3. **Provider call ID for usageUnitId?** (unique per LLM call)
4. **Idempotent flow through commitUsageFact?** (source_reference format)

### Implementation Status

Correlation mechanism validated (P0 partial):

- `initChatModel` includes `"user"` in `configurableFields`
- Provider sets `configurable.user = ${runId}/${attempt}` server-side
- `end_user` confirmed populated in LiteLLM spend_logs

Remaining P0: `getSpendLogsByEndUser()` adapter method, `reconcileRun()` service, wiring after stream completes, stack test.

### File Pointers

| File                                                       | Role                                      |
| ---------------------------------------------------------- | ----------------------------------------- |
| `packages/langgraph-graphs/src/graphs/*/server.ts`         | `configurableFields: ["model", "user"]`   |
| `src/adapters/server/ai/langgraph/dev/provider.ts`         | `configurable.user = ${runId}/${attempt}` |
| `src/adapters/server/ai/litellm.activity-usage.adapter.ts` | LiteLLM spend logs adapter                |
| `src/features/ai/services/external-reconciler.ts`          | Reconciler service (WIP)                  |

## Acceptance Checks

**Automated:**

- Stack test: chat via external executor → charge_receipts created via reconciliation
- Idempotency test: replayed reconciliation produces no duplicate ledger entries

**Manual:**

1. Verify `end_user` populated in LiteLLM spend_logs after a LangGraph Server run
2. Verify stream `usage_report` events do not create charge_receipts (UX-only)

## Open Questions

_(none — P1 hardening (alerts, retry, metrics) and future provider integrations tracked in proj.payments-enhancements.md)_

## Related

- [Billing Evolution](./billing-evolution.md) — Charge receipt schema
- [AI Architecture and Evals](./ai-evals.md) — Executor types
