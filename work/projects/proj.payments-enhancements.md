---
id: proj.payments-enhancements
type: project
primary_charter:
title: Payments & Billing Enhancements
state: Active
priority: 1
estimate: 5
summary: Hardening and extending the billing pipeline — pre-call estimation, reconciliation tooling, external executor billing, on-chain verification
outcome: Reliable billing with reconciliation scripts, monitoring dashboards, credit holds, and on-chain settlement verification
assignees: derekg1729
created: 2026-02-06
updated: 2026-02-11
labels: [billing, ai-graphs, web3]
---

# Payments & Billing Enhancements

## Goal

Harden and extend the billing pipeline across three axes: (1) improve pre-call cost estimation to reduce false 402 rejections, (2) complete external executor reconciliation for LangGraph Server billing, and (3) build toward on-chain settlement verification for DAO-governed payments.

## Roadmap

### Crawl (P0) — External Executor Reconciliation

**Goal:** Complete the LangGraph Server billing reconciliation pipeline.

| Deliverable                                                                                                          | Status      | Est | Work Item            |
| -------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| `end_user` correlation validated in LiteLLM spend_logs                                                               | Done        | 1   | —                    |
| `initChatModel` includes `"user"` in `configurableFields`                                                            | Done        | 1   | —                    |
| Provider sets `configurable.user = ${runId}/${attempt}` server-side                                                  | Done        | 1   | —                    |
| Add `getSpendLogsByEndUser(endUser)` to LiteLLM adapter (`src/adapters/server/ai/litellm.activity-usage.adapter.ts`) | Not Started | 2   | (create at P0 start) |
| Create `reconcileRun()` in `src/features/ai/services/external-reconciler.ts`                                         | Not Started | 2   | (create at P0 start) |
| Wire reconciler call after stream completes in provider                                                              | Not Started | 1   | (create at P0 start) |
| Stack test: chat via external executor → charge_receipts created via reconciliation                                  | Not Started | 2   | (create at P0 start) |

### Walk (P1) — Billing Hardening

**Goal:** Fix known issues, add reconciliation monitoring, improve cost estimation.

| Deliverable                                                                                                                                                                                                                                                          | Status      | Est | Work Item            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Fix streaming billing cost in test stack — LiteLLM streaming omits `x-litellm-response-cost` header and `usage.cost` in SSE; test-stack `chargedCredits` is 0n. Live works. Investigate mock-LLM streaming cost propagation and un-skip `billing-e2e.stack.test.ts`. | Not Started | 1   | (create at P1 start) |
| Alert on reconciliation failures                                                                                                                                                                                                                                     | Not Started | 1   | (create at P1 start) |
| Retry logic for transient LiteLLM API errors in reconciler                                                                                                                                                                                                           | Not Started | 1   | (create at P1 start) |
| Metrics: `external_billing.reconcile_latency_ms`                                                                                                                                                                                                                     | Not Started | 1   | (create at P1 start) |
| Fix cents sprawl across codebase (126+ references to "cents" in payment flows — standardize on USD only; credits are canonical ledger unit, cents is unnecessary intermediate)                                                                                       | Not Started | 2   | (create at P1 start) |
| Tune pre-call estimate (currently uses `ESTIMATED_USD_PER_1K_TOKENS = $0.002` as upper-bound — may reject valid requests with sufficient balance)                                                                                                                    | Not Started | 1   | (create at P1 start) |
| Pre-call max-cost estimation and 402 without calling LLM                                                                                                                                                                                                             | Not Started | 2   | (create at P1 start) |
| Reconciliation scripts and monitoring dashboards                                                                                                                                                                                                                     | Not Started | 2   | (create at P1 start) |

#### USDC Payment Hardening (from PAYMENTS_DESIGN.md)

> Source: docs/PAYMENTS_DESIGN.md

| Deliverable                                                                                                                  | Status      | Est | Work Item            |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Frontend tests: 3-state projection renders correctly from backend states                                                     | Not Started | 1   | (create at P1 start) |
| Frontend tests: polling updates status in real-time                                                                          | Not Started | 1   | (create at P1 start) |
| Frontend tests: error messages display correctly                                                                             | Not Started | 1   | (create at P1 start) |
| Smoke test: run EvmRpcOnChainVerifierAdapter against known-good tx on Sepolia/Base testnet                                   | Not Started | 1   | (create at P1 start) |
| Clear stuck PENDING attempts after max verification TTL                                                                      | Not Started | 1   | (create at P1 start) |
| Monitoring and alerting for verification failures                                                                            | Not Started | 1   | (create at P1 start) |
| Audit log queries for dispute resolution                                                                                     | Not Started | 1   | (create at P1 start) |
| Rate limiting on RPC calls to prevent cost spikes                                                                            | Not Started | 1   | (create at P1 start) |
| Fallback RPC endpoints for reliability                                                                                       | Not Started | 1   | (create at P1 start) |
| Deferred frontend tests: transaction replacement edge cases, multiple transfer logs UI handling, address case sensitivity UX | Not Started | 2   | (create at P1 start) |

### Run (P2+) — Credit Holds & On-Chain Verification

**Goal:** Soft reservations, on-chain settlement, multi-provider support.

| Deliverable                                                                                                                 | Status      | Est | Work Item            |
| --------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| `credit_holds` table for soft reservations                                                                                  | Not Started | 3   | (create at P2 start) |
| On-chain watcher & reconciliation (Ponder) — verify widget payments settled on-chain                                        | Not Started | 3   | (create at P2 start) |
| Additional payment providers beyond DePay widget                                                                            | Not Started | 2   | (create at P2 start) |
| All on-chain payment flows settle into `credit_ledger` via well-defined reasons (`widget_payment`, `onchain_deposit`, etc.) | Not Started | 2   | (create at P2 start) |
| cogni-git-review evolves with new gates and reasons as payment providers are added                                          | Not Started | 1   | (create at P2 start) |

## Constraints

- Post-call billing NEVER blocks user response (invariant from billing-evolution spec)
- `commitUsageFact()` is the only path to write charge_receipts (ONE_LEDGER_WRITER)
- Server controls identity — `billingAccountId` / `end_user` is server-derived, never client-provided
- `.cogni/repo-spec.yaml` remains single source of truth for allowed providers and DAO receiving address

## Dependencies

- [ ] LiteLLM `/spend/logs` API reliability for reconciliation
- [ ] Ponder or equivalent on-chain indexer for P2
- [ ] DAO key infrastructure for additional payment providers

## As-Built Specs

- [billing-evolution.md](../../docs/spec/billing-evolution.md) — charge receipt schema, credit unit standard, single billing path
- [sandbox-billing-pipeline](https://cognidao.org/knowledge/sandbox-billing-pipeline) — proxy-driven audit log pipeline (ephemeral + gateway shared volume)
- [billing-ingest.md](../../docs/spec/billing-ingest.md) — callback-driven billing design (draft, supersedes log scraping)
- [external-executor-billing.md](../../docs/spec/external-executor-billing.md) — async reconciliation design, end_user correlation
- [dao-enforcement.md](../../docs/spec/dao-enforcement.md) — DAO financial rails, widget payment invariants
- [activity-metrics.md](../../docs/spec/activity-metrics.md) — activity dashboard join, preflight gating model
- [payments-design.md](../../docs/spec/payments-design.md) — USDC payment system, state machine, OnChainVerifier port, persistence

## Design Notes

Content aggregated from original `docs/spec/billing-evolution.md` (Known Issues + Future Work), `docs/spec/external-executor-billing.md` (P0 remaining + P1 hardening), and `docs/spec/dao-enforcement.md` (Section 5: future DAO hardening) during docs migration.

**Known issue from BILLING_EVOLUTION (resolved):** Activity reporting previously showed zeros — fixed by joining `charged_credits` from `charge_receipts` with LiteLLM telemetry by `litellm_call_id`.

**From PAYMENTS_DESIGN.md:** Phase 4 operational hardening (stuck PENDING cleanup, verification monitoring, audit log queries, RPC rate limiting, fallback endpoints) plus remaining frontend and smoke tests added to Walk (P1).
