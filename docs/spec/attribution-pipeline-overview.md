---
id: attribution-pipeline-overview-spec
type: spec
title: "Attribution Pipeline Overview"
status: draft
spec_state: active
trust: draft
summary: "End-to-end overview of the attribution pipeline: from repo-spec.yaml configuration through activity ingestion, enrichment, allocation, admin review, and EIP-712 signed credit statements."
read_when: Understanding the full attribution pipeline, onboarding to the credit system, or deciding where a change belongs.
implements: proj.transparent-credit-payouts
owner: derekg1729
created: 2026-03-02
verified: 2026-03-03
tags: [governance, attribution, overview]
---

# Attribution Pipeline Overview

> Every week, the system turns contributor activity into a signed credit statement. This document is the map — it shows the full path from `repo-spec.yaml` to signed ledger, where each piece lives in code, and how to extend the pipeline with new plugins.

## Goal

Provide a single document that explains the full attribution pipeline end-to-end: from `repo-spec.yaml` configuration through activity ingestion, enrichment, allocation, admin review, and EIP-712 signed credit statements. Serve as the entry point for onboarding and for deciding where a change belongs.

## DAO Ownership Token Distribution

The first crypto-distribution primitive is an ownership token merkle manifest, not
an automatic payout executor. DAO formation mints the node's selected whole-token
supply to the initial holder. After attribution epochs produce signed claimant
allocations, those signed credit entitlements can be transformed into a deterministic token
claim manifest:

1. Group finalized claimant allocations by claimant key and resolved claim
   address.
2. Convert signed `credit_amount` entitlements into ERC20 base-unit amounts
   against the distribution amount using integer largest-remainder rounding.
3. Hash each claim as packed `(index, account, amount)` and build a sorted-pair
   keccak merkle tree.
4. Publish a scope-bound settlement manifest with `node_id`, `scope_id`,
   `epochId`, `statementHash`, `merkleRoot`, `totalAmount`, funding metadata,
   and per-claim proofs for a future MerkleDistributor contract or
   operator-mediated claim route.

This keeps today's ledger signing flow unchanged while giving the next iteration
a stable bridge from signed attribution statements to token ownership claims.

## Non-Goals

- Schema definitions — see [attribution-ledger](./attribution-ledger.md)
- Invariant tables — see [attribution-ledger](./attribution-ledger.md) (79 invariants)
- Plugin framework internals — see [plugin-attribution-pipeline](./plugin-attribution-pipeline.md)
- Enricher/allocator contract interfaces — see [plugin-attribution-pipeline](./plugin-attribution-pipeline.md)

## Invariants

This spec introduces no new invariants. All behavioral guarantees are defined in the detailed specs above. The key invariants that govern the pipeline flow are:

| Rule                    | Summary                                              |
| ----------------------- | ---------------------------------------------------- |
| EPOCH_THREE_PHASE       | `open → review → finalized`, no backward transitions |
| ADMIN_FINALIZES_ONCE    | Human reviews, optionally overrides, then signs once |
| STATEMENT_DETERMINISTIC | Same inputs → byte-for-byte identical statement      |
| SIGNATURE_SCOPE_BOUND   | EIP-712 covers nodeId + scopeId + hash (no replay)   |

## Design

### End-to-End Pipeline

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                                                                          │
 │  .cogni/repo-spec.yaml                                                   │
 │  ┌────────────────────────────────────────────────────────────────────┐  │
 │  │ activity_ledger:                                                   │  │
 │  │   epoch_length_days: 7                                             │  │
 │  │   approvers: ["0x..."]                                             │  │
 │  │   pool_config: { base_issuance_credits: "10000" }                  │  │
 │  │   activity_sources:                                                │  │
 │  │     github:                                                        │  │
 │  │       attribution_pipeline: cogni-v0.0  ◄── selects profile        │  │
 │  │       source_refs: ["org/repo"]                                    │  │
 │  └────────────────────────────────────────────────────────────────────┘  │
 │                                     │                                    │
 └─────────────────────────────────────┼────────────────────────────────────┘
                                       │
                                       ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  TEMPORAL: CollectEpochWorkflow  (daily cron, runs while epoch is open) │
 │                                                                         │
 │  ┌───────────────────────────────────────────────────────────────────┐  │
 │  │  1. INGEST                          "What happened?"              │  │
 │  │     Source adapters (GitHub) ──► ingestion_receipts      │  │
 │  │     • Cursor-based incremental fetch                              │  │
 │  │     • Deterministic IDs (idempotent inserts)                      │  │
 │  │     • Append-only (DB trigger rejects UPDATE/DELETE)              │  │
 │  └───────────────────────────────────────────────────────────────────┘  │
 │                                     │                                   │
 │                                     ▼                                   │
 │  ┌───────────────────────────────────────────────────────────────────┐  │
 │  │  2. SELECT + RESOLVE                                              │  │
 │  │     materializeSelection activity                                 │  │
 │  │     • Creates epoch_selection rows per receipt                     │  │
 │  │     • Resolves platform identity → user_id via user_bindings      │  │
 │  │     • Inserts draft epoch_receipt_claimants                        │  │
 │  └───────────────────────────────────────────────────────────────────┘  │
 │                                     │                                   │
 │                                     ▼                                   │
 │  ┌───────────────────────────────────────────────────────────────────┐  │
 │  │  3. ENRICH                          "What does it mean?"          │  │
 │  │     attribution_pipeline: cogni-v0.0                              │  │
 │  │       └─► resolveProfile() ──► PipelineProfile                    │  │
 │  │             └─► enricherRefs: [cogni.echo.v0]                     │  │
 │  │                   └─► run each enricher ──► epoch_evaluations     │  │
 │  │     • Draft evaluations overwritten each pass (UI projections)    │  │
 │  │     • Locked evaluations written once at close (statements)       │  │
 │  └───────────────────────────────────────────────────────────────────┘  │
 │                                     │                                   │
 │                                     ▼                                   │
 │  ┌───────────────────────────────────────────────────────────────────┐  │
 │  │  4. ALLOCATE                        "Who gets what?"              │  │
 │  │     PipelineProfile.allocatorRef: weight-sum-v0                   │  │
 │  │       └─► dispatchAllocator(registry, allocatorRef, context)      │  │
 │  │             └─► ReceiptUnitWeight[]  (per-receipt milli-units)     │  │
 │  │                   └─► explodeToClaimants(weights, claimants)       │  │
 │  │                         └─► FinalClaimantAllocation[]              │  │
 │  │     • Worker path stays generic — no direct allocator helper call  │  │
 │  │     • Integer math only (BIGINT, largest-remainder rounding)      │  │
 │  └───────────────────────────────────────────────────────────────────┘  │
 │                                                                         │
 └──────────────────────────────────── ┼ ──────────────────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        ▼                        │
              │   CLOSE INGESTION  (auto at periodEnd + grace,  │
              │                     or admin triggers early)     │
              │                                                  │
              │   • Final enrichment pass                        │
              │   • Lock evaluations (draft → locked, atomic)    │
              │   • Lock claimants (draft → locked)              │
              │   • Pin: weight_config_hash, allocation_algo_ref │
              │   • Epoch transitions: open → review             │
              │                                                  │
              └────────────────────────┼────────────────────────┘
                                       │
                                       ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  REVIEW PHASE  (human in the loop)                                      │
 │                                                                         │
 │  Admin reviews projections in /gov/review UI:                           │
 │    • Adjust inclusion (select/deselect receipts)                        │
 │    • Record weight overrides (epoch_review_subject_overrides)           │
 │    • Resolve unlinked identities                                        │
 │    • Verify pool components (base_issuance, bonuses)                    │
 │                                                                         │
 │  No new ingestion. Selection still mutable. Overrides are absolute      │
 │  values, not deltas. Projections recompute on demand.                   │
 │                                                                         │
 └──────────────────────────────────── ┼ ──────────────────────────────────┘
                                       │
                                       ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  FINALIZE  (admin signs, Temporal executes)                             │
 │                                                                         │
 │  1. GET /sign-data  →  builds EIP-712 typed data:                       │
 │     Load locked claimants + selected receipts + locked evaluations      │
 │     dispatchAllocator() → applyReceiptWeightOverrides()                 │
 │       → explodeToClaimants() → computeFinalClaimantAllocationSetHash()  │
 │     Return typed data: { nodeId, scopeId, epochId, hash, poolTotal }   │
 │                                                                         │
 │  2. Admin wallet signs EIP-712 typed data (MetaMask / WalletConnect)    │
 │                                                                         │
 │  3. POST /finalize  →  starts FinalizeEpochWorkflow:                    │
 │     • Recompute identical hash (same allocator dispatch path as sign-data)│
 │     • Verify EIP-712 signature against approvers[]                      │
 │     • Atomic DB transaction:                                            │
 │       - Write epoch_final_claimant_allocations                          │
 │       - Write epoch_statement + statement_lines                         │
 │       - Write epoch_signature                                           │
 │       - Snapshot review_overrides_json on statement                     │
 │       - Transition epoch: review → finalized                            │
 │                                                                         │
 │  ┌─────────────────────────────────────────────────────────────────┐    │
 │  │  SIGNED STATEMENT                                               │    │
 │  │  { claimant_key, final_units, pool_share, credit_amount,        │    │
 │  │    receipt_ids }  ×  N claimants                                 │    │
 │  │  + finalAllocationSetHash (SHA-256)                              │    │
 │  │  + EIP-712 signature (scope-bound, replay-resistant)             │    │
 │  │  + review_overrides_json (audit trail)                           │    │
 │  └─────────────────────────────────────────────────────────────────┘    │
 │                                                                         │
 └─────────────────────────────────────────────────────────────────────────┘
```

## Epoch State Machine

```
  ┌────────┐   closeIngestion    ┌────────┐    finalize     ┌───────────┐
  │  OPEN  │ ──────────────────► │ REVIEW │ ──────────────► │ FINALIZED │
  └────────┘   (auto or admin)   └────────┘  (admin + sig)  └───────────┘
   Ingest ✓     Ingestion closed   Selection mutable         Immutable
   Enrich ✓     Evals locked       Overrides recorded        Statement signed
   Allocate ✓   Config pinned      Pool verified             No backward transitions
```

## Plugin System

The pipeline is extended through **profiles**. A profile selects which enrichers run and which allocator computes credits.

### How a Profile Drives the Pipeline

```
repo-spec.yaml                     Plugin Registry
─────────────────                   ──────────────────────────────────
attribution_pipeline: cogni-v0.0 ──► resolveProfile("cogni-v0.0")
                                         │
                                         ▼
                                    PipelineProfile {
                                      profileId: "cogni-v0.0"
                                      enricherRefs: [
                                        { enricherRef: "cogni.echo.v0" }
                                      ]
                                      allocatorRef: "weight-sum-v0"
                                      defaultWeightConfig: {
                                        "github:pr_merged": 1000,
                                        "github:review_submitted": 500,
                                        "github:issue_closed": 300
                                      }
                                    }
                                         │
                            ┌────────────┴────────────┐
                            ▼                         ▼
                     Run enrichers              Dispatch allocator
                     in declared order          by allocatorRef
```

### Adding a New Plugin

**To add a new enricher** (e.g., `cogni.work_item_links.v0`):

1. **Implement the adapter** in `packages/attribution-pipeline-plugins/src/plugins/`:

   ```
   plugins/work-item-links/
   ├── descriptor.ts    # constants, payload type, EVALUATION_REF
   └── adapter.ts       # implements EnricherAdapter { evaluateDraft, buildLocked }
   ```

2. **Register it** in `packages/attribution-pipeline-plugins/src/registry.ts`:

   ```typescript
   enrichers.set(
     workItemLinksAdapter.descriptor.evaluationRef,
     workItemLinksAdapter
   );
   ```

3. **Create or update a profile** in `packages/attribution-pipeline-plugins/src/profiles/`:

   ```typescript
   export const COGNI_V0_1_PROFILE: PipelineProfile = {
     profileId: "cogni-v0.1",
     enricherRefs: [
       { enricherRef: "cogni.echo.v0", dependsOnEvaluations: [] },
       {
         enricherRef: "cogni.work_item_links.v0",
         dependsOnEvaluations: ["cogni.echo.v0"],
       },
     ],
     allocatorRef: "weight-sum-v0",
     epochKind: "activity",
   };
   ```

4. **Operators adopt** by changing one line in `repo-spec.yaml`:

   ```yaml
   attribution_pipeline: cogni-v0.1 # was cogni-v0.0
   ```

No changes to the framework, scheduler-worker, or core ledger code.

**To add a new allocator** (e.g., `work-item-budget-v0`):

1. **Implement** `AllocatorDescriptor` in `plugins/work-item-budget/descriptor.ts`
2. **Register** in `registry.ts`: `allocators.set(descriptor.algoRef, descriptor)`
3. **Reference** from a profile: `allocatorRef: "work-item-budget-v0"`

### Package Architecture

```
@cogni/attribution-pipeline-contracts    ◄── stable framework (ports, registries)
         ▲
         │ depends on
         │
@cogni/attribution-pipeline-plugins      ◄── built-in implementations (churn here)
         ▲
         │ depends on
         │
@cogni/attribution-ledger                ◄── pure domain logic (types, math, hashing)
```

Dependency direction is strict: `plugins → contracts → ledger`. Never reverse.

## Key Code Paths

| Pipeline Phase                  | Primary Code Location                                                  |
| ------------------------------- | ---------------------------------------------------------------------- |
| Config parsing                  | `packages/repo-spec/src/schema.ts` → `accessors.ts`                    |
| Workflow orchestration          | `services/scheduler-worker/src/workflows/collect-epoch.workflow.ts`    |
| Ingestion + identity + finalize | `services/scheduler-worker/src/activities/ledger.ts`                   |
| Enrichment dispatch             | `services/scheduler-worker/src/activities/enrichment.ts`               |
| Allocation math                 | `packages/attribution-ledger/src/allocation.ts` + `claimant-shares.ts` |
| Sign-data (hash for wallet)     | `src/app/api/v1/attribution/epochs/[id]/sign-data/route.ts`            |
| Finalize (verify + persist)     | `services/scheduler-worker/src/activities/ledger.ts` (`finalizeEpoch`) |
| Plugin contracts                | `packages/attribution-pipeline-contracts/src/`                         |
| Plugin implementations          | `packages/attribution-pipeline-plugins/src/plugins/`                   |
| Profiles                        | `packages/attribution-pipeline-plugins/src/profiles/`                  |
| Store port                      | `packages/attribution-ledger/src/store.ts`                             |
| DB adapter                      | `packages/db-client/src/adapters/drizzle-attribution.adapter.ts`       |

## Determinism Guarantees

Every step from allocation to statement is fully reproducible from stored data:

1. **Inputs pinned at close**: `weight_config_hash`, `allocation_algo_ref`, `artifacts_hash` locked on epoch
2. **Canonical hashing**: sorted keys, no whitespace, BigInt as string (`canonicalJsonStringify`)
3. **Integer math only**: BIGINT throughout, largest-remainder rounding for exact sums
4. **Verification endpoint**: `GET /verify/epoch/:id` recomputes from stored data and compares

The signed `finalAllocationSetHash` is a SHA-256 of the sorted final claimant allocations. Combined with the EIP-712 signature binding `nodeId + scopeId + epochId + hash + poolTotal`, the statement is tamper-evident and scope-bound.
