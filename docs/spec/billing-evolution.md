---
id: billing-evolution-spec
type: spec
title: "Billing Evolution: Dual-Cost Accounting"
status: active
spec_state: draft
trust: draft
summary: Profit-enforcing billing with LiteLLM-sourced provider costs, credit unit standard, idempotent charge receipts, and per-node metering routed by repo-spec identity.
read_when: Working on billing, credit charges, pricing policy, the charge_receipts table, or the shared LiteLLM proxy's per-node callback routing.
owner: derekg1729
created: 2026-02-06
verified: 2026-06-01
tags: [billing]
---

# Billing Evolution: Dual-Cost Accounting

## Context

Extends accounts design with profit-enforcing billing and provider cost tracking. LiteLLM is the cost oracle; our system applies markup and stores idempotent charge receipts.

**Related docs:**

- System architecture: [Accounts Design](../ACCOUNTS_DESIGN.md)
- API contracts: [Accounts API Endpoints](../ACCOUNTS_API_KEY_ENDPOINTS.md)
- Wallet integration: [Wallet Auth Setup](../INTEGRATION_WALLETS_CREDITS.md)
- Usage/Activity Design: [Activity Metrics](./activity-metrics.md)
- Graph Execution & Idempotency: [Graph Execution](graph-execution.md)

## Goal

Single-path billing where LiteLLM provides provider cost, our system applies markup, and charge receipts are immutable audit records with idempotency guarantees.

## Non-Goals

- Hardcoded per-model USD pricing tables (LiteLLM is the oracle)
- Blocking user responses during post-call billing
- Credit holds / soft reservations (deferred, tracked in proj.payments-enhancements.md)

## Core Invariants

1. **CREDIT_UNIT_STANDARD**: 1 credit = $0.0000001 USD. `CREDITS_PER_USD = 10_000_000` is a protocol constant (hardcoded, not configurable). All balances stored as BIGINT integers.

2. **LITELLM_COST_ORACLE**: LiteLLM computes per-request cost via `x-litellm-response-cost` header (non-streaming) or `usage.cost` in final usage event (streaming). We do NOT maintain hardcoded per-model pricing tables.

3. **SINGLE_BILLING_PATH**: `providerCostUsd → userCostUsd = providerCostUsd × MARKUP_FACTOR → chargedCredits = ceil(userCostUsd × CREDITS_PER_USD)`. Single entry point: `calculateLlmUserCharge()`.

4. **IDEMPOTENT_CHARGE_RECEIPTS**: `UNIQUE(source_system, source_reference)` is the idempotency constraint. Multiple receipts per `request_id` allowed (graphs make N LLM calls). Each receipt maps to a `credit_ledger` entry.

5. **USER_COST_NOT_PROVIDER_COST**: `response_cost_usd` stores USER cost (with markup), not provider cost.

6. **POST_CALL_NEVER_BLOCKS**: Post-call billing NEVER throws `InsufficientCreditsPortError`. If balance goes negative, log critical but complete the write. Overage handled in reconciliation.

7. **NODE_LOCAL_METERING**: One shared LiteLLM proxy meters all co-deployed nodes. A custom callback (`cogni_callbacks.CogniNodeRouter`) routes each spend event to the **owning node's** `/api/internal/billing/ingest` by `node_id`, so each node's `charge_receipts` live in its own DB. The callback is adapter glue only — no pricing/policy/reconciliation (`CALLBACK_IS_ADAPTER_GLUE`).

8. **REPO_SPEC_IS_IDENTITY_SSOT**: The `node_id` used for metering routing is the in-repo projection of the node's on-chain DAO and is declared exactly once, in `nodes/<node>/.cogni/repo-spec.yaml` (ROADMAP "Repo-Spec Authority"). It is never re-declared in `infra/catalog/*.yaml` (schema-forbidden) nor hardcoded in the proxy image. The routing CSV (`COGNI_NODE_ENDPOINTS`) and the default-node (`COGNI_DEFAULT_NODE_ID` = the `is_primary_host` node's `node_id`) are derived from repo-spec by `scripts/ci/lib/image-tags.sh` + `deploy-infra.sh`. **NO_SILENT_MISATTRIBUTION**: a missing/unknown `node_id` falls back to the configured default only if one is set; otherwise the event is logged + skipped — never billed to a fabricated identity.

   > **`DEFAULT_NODE_IS_V0_TOLERANCE` (transitional).** A "default node" for unattributed spend is **not** first-class — it is a v0 crutch. Under `NODE_LOCAL_METERING` every metered call must carry its `node_id` (set by the node's LLM adapter), so a missing `node_id` is a **bug at the caller**, not a routing case. Defaulting it to the primary-host node means operator silently absorbs untagged spend. The accepted tolerance for v0: `COGNI_DEFAULT_NODE_ID` set → bill primary-host; unset → skip + log. **Exit:** make `node_id` mandatory on every metered call (assert at the adapter boundary), and on missing/unknown route to a **dead-letter + alert**, not a default — then delete `COGNI_DEFAULT_NODE_ID` entirely. Tracked toward the operator-controlled, typed metering contract (see ci-cd.md axiom 16 corollaries; the same elevation that makes deploy levers first-class operator workflows).

## Schema

**Table:** `charge_receipts`

Minimal audit-focused table. LiteLLM is canonical for telemetry.

| Column               | Type         | Purpose                                                  |
| -------------------- | ------------ | -------------------------------------------------------- |
| `request_id`         | text         | Server-generated UUID, correlation key (not unique)      |
| `billing_account_id` | text         | FK to billing_accounts                                   |
| `virtual_key_id`     | uuid         | FK to virtual_keys                                       |
| `litellm_call_id`    | text NULL    | Forensic correlation (x-litellm-call-id)                 |
| `charged_credits`    | bigint       | Credits debited from user balance                        |
| `response_cost_usd`  | decimal NULL | Observational USD cost (with markup)                     |
| `provenance`         | text         | `stream` \| `response`                                   |
| `charge_reason`      | text         | Economic category (`llm_usage`, etc.)                    |
| `source_system`      | text         | External system (`litellm`, `anthropic_sdk`)             |
| `source_reference`   | text         | Idempotency key: `${run_id}/${attempt}/${usage_unit_id}` |
| `run_id`             | text         | Graph run identifier (P0: added for run-centric billing) |
| `attempt`            | int          | Retry attempt (P0: frozen at 0)                          |
| `created_at`         | timestamptz  |                                                          |

**Credit Unit Standard:**

| Value             | Constant                                                        |
| ----------------- | --------------------------------------------------------------- |
| 1 credit          | $0.0000001 USD                                                  |
| 1 USD             | 10,000,000 credits                                              |
| 1 USDC            | 10,000,000 credits                                              |
| Protocol constant | `CREDITS_PER_USD = 10_000_000` in `src/core/billing/pricing.ts` |
| Default markup    | 2.0× (100% markup = 50% margin)                                 |

## Design

### Post-Call Billing (Non-Blocking)

Per [Activity Metrics](./activity-metrics.md), post-call billing NEVER throws `InsufficientCreditsPortError`.

**Flow:**

1. **Preflight** (blocking): estimate cost, check balance, DENY if insufficient
2. **Call LiteLLM** via LlmService
3. **Extract cost** from `x-litellm-response-cost` header or `usage.cost` event
4. **Calculate chargedCredits** via `calculateLlmUserCharge()`
5. **Write atomically**: `recordChargeReceipt()` (non-blocking, never throws InsufficientCredits)
6. **Return response** to user (NEVER blocked by post-call billing)

If balance goes negative, log critical but complete the write. Overage handled in reconciliation.

### Multi-Node Cost Routing (shared LiteLLM proxy)

One LiteLLM proxy serves every co-deployed node. After each successful completion it fires `cogni_callbacks.CogniNodeRouter.async_log_success_event`, which:

1. Reads `node_id` from `spend_logs_metadata` (set by the node's LLM adapter via the `x-litellm-spend-logs-metadata` header — see `nodes/<node>/app/src/adapters/server/ai/litellm.adapter.ts`).
2. Resolves the owning node's ingest URL from `COGNI_NODE_ENDPOINTS` (a `slug=url,node_id=url` map) and POSTs the `standard_logging_object` to `<node>/api/internal/billing/ingest` with the `BILLING_INGEST_TOKEN` bearer.
3. On missing/unknown `node_id`: uses `COGNI_DEFAULT_NODE_ID` if set, else logs an error and skips (`NO_SILENT_MISATTRIBUTION`).

**Identity lineage (one source of truth: web3 → repo-spec → routing).** `node_id` is minted at DAO formation and written to `nodes/<node>/.cogni/repo-spec.yaml`. Everything downstream derives from it — the catalog declares only deploy-shape (ports/branches), and the routing maps + default node are rendered from repo-spec at deploy time. Adding a node never requires hand-editing a billing route or a UUID. See [ci-cd.md](./ci-cd.md) axiom 16 (`REPO_SPEC_IS_IDENTITY_SSOT`).

```
on-chain DAO ──formation──▶ repo-spec.yaml (node_id) ──image-tags.sh──▶ COGNI_NODE_ENDPOINTS + COGNI_DEFAULT_NODE_ID ──▶ CogniNodeRouter ──▶ <node>/api/internal/billing/ingest ──▶ charge_receipts
```

### Environment Configuration

| Variable                   | Purpose                                                                 | Example                       |
| -------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| `USER_PRICE_MARKUP_FACTOR` | Profit markup multiplier                                                | `2.0`                         |
| `COGNI_NODE_ENDPOINTS`     | Per-node ingest routing map (`slug=url,node_id=url`); repo-spec-derived | `operator=…,4ff8eac1…=…`      |
| `COGNI_DEFAULT_NODE_ID`    | Default node for unattributed spend (`is_primary_host` `node_id`)       | `4ff8eac1-…` (from repo-spec) |

Protocol constant `CREDITS_PER_USD = 10_000_000` is NOT configurable (hardcoded).

### Known Issues (Resolved)

- [x] **Table rename done.** `llm_usage` → `charge_receipts`

### File Pointers

Per-node app code lives under `nodes/<node>/app/src/` (hex layering; `<node>` ∈ operator/resy/node-template/canary). The shared proxy + catalog live at repo root.

| File                                                               | Purpose                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `nodes/<node>/app/src/core/billing/pricing.ts`                     | Protocol constants, conversion helpers                                  |
| `nodes/<node>/app/src/features/ai/services/llmPricingPolicy.ts`    | Markup policy layer (reads USER_PRICE_MARKUP_FACTOR)                    |
| `nodes/<node>/app/src/shared/db/schema.billing.ts`                 | `charge_receipts` table                                                 |
| `nodes/<node>/app/src/ports/accounts.port.ts`                      | `recordChargeReceipt` interface                                         |
| `nodes/<node>/app/src/adapters/server/accounts/drizzle.adapter.ts` | Atomic charge receipt + ledger debit                                    |
| `nodes/<node>/app/src/features/ai/services/completion.ts`          | Preflight gating + non-blocking post-call billing                       |
| `nodes/<node>/app/src/app/api/internal/billing/ingest/route.ts`    | Per-node ingest endpoint the proxy callback POSTs to                    |
| `infra/images/litellm/cogni_callbacks.py`                          | Shared-proxy callback that routes spend by `node_id`                    |
| `scripts/ci/lib/image-tags.sh`                                     | Renders `COGNI_NODE_ENDPOINTS` + `COGNI_DEFAULT_NODE_ID` from repo-spec |
| `nodes/<node>/.cogni/repo-spec.yaml`                               | `node_id` identity authority (`REPO_SPEC_IS_IDENTITY_SSOT`)             |

## Acceptance Checks

**Invariants to verify:**

- 1 credit = $0.0000001 (protocol constant)
- `response_cost_usd` stores user cost (with markup), not provider cost
- Single ceil at end: `chargedCredits = ceil(userCostUsd × CREDITS_PER_USD)`
- Post-call billing NEVER blocks user response
- Idempotency via `UNIQUE(source_system, source_reference)` — see [Graph Execution](graph-execution.md)

**Verification:**

```sql
SELECT charged_credits, response_cost_usd FROM charge_receipts;
```

Cost source: LiteLLM `usage.cost` (stream) or `x-litellm-response-cost` header (non-stream).

## Known Issues

- **/activity cost column broken**: LiteLLM `spend_logs.request_id` ≠ `charge_receipts.litellm_call_id` for some providers → all rows show "—" cost. See [bug.0004.activity-billing-join](../../work/items/bug.0004.activity-billing-join.md).

## Open Questions

_(none — planned work tracked in proj.payments-enhancements.md: pre-call max-cost estimation, reconciliation scripts, credit_holds table, on-chain watcher, cents sprawl cleanup, conservative pre-call estimate tuning)_

## Forward Path

The `credit_ledger` and prepaid credit model documented here is the current as-built system. The forward path ([x402 per-request settlement](./x402-e2e.md)) eliminates credit balances — users pay per-request via x402 `upto` scheme (USDC on Base). `charge_receipts` and the LiteLLM cost oracle remain unchanged across both models.

## Related

- [Activity Metrics](./activity-metrics.md)
- [Graph Execution](graph-execution.md)
- [Accounts Design](../ACCOUNTS_DESIGN.md)
- [x402 E2E](./x402-e2e.md) — Forward path: per-request settlement
