---
id: tokenomics-spec
type: spec
title: "Tokenomics: Budget Policy + Settlement Handoff"
status: draft
spec_state: proposed
trust: draft
summary: "Tokenomics contract for hard-capped credit budgeting and settlement-layer handoff. Defines simple epoch budget policy, one user-facing unit, and how finalized credits hand off to future token settlement."
read_when: Understanding credit economics, pool sizing, emission schedules, or settlement design.
implements: proj.transparent-credit-payouts
owner: derekg1729
created: 2026-03-02
verified: 2026-03-03
tags: [governance, tokenomics, attribution]
---

# Tokenomics: Budget Policy + Settlement Handoff

> The attribution pipeline answers "who did what." This spec answers "how much is the pool, where does it come from, and what do the numbers mean to the user."

## Goal

Replace arbitrary, inflationary credit issuance with principled tokenomics:

1. **One user-facing unit** — kill the score/credits split
2. **Hard-capped credit budget** — finite pool, no infinite minting
3. **Deterministic epoch pools** — policy function, not admin discretion
4. **Flat eligible-epoch budget** — quiet weeks spend nothing; later eligible epochs still use the same deterministic `accrual_per_epoch` cap
5. **Separation of concerns** — attribution (governance truth) vs. settlement (financial truth) vs. governance (voting power)

## Non-Goals

- Deploying smart contracts (Crawl phase is off-chain only)
- Token trading, liquidity pools, or price discovery
- Multi-token architecture in Crawl
- Changing the attribution pipeline math (weights, enrichers, allocators stay as-is)

## Problems with Status Quo

| Problem                     | Evidence                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Infinite inflation**      | `base_issuance_credits: "10000"` mints 10K every epoch forever. No cap.                                   |
| **Two meaningless numbers** | UI shows "Score" (`units/1000`) AND "Credits" (`proportional share × pool`). Neither has intrinsic value. |
| **Magic pool size**         | `estimatePoolComponentsV0()` returns config value unchanged. `algorithmVersion: "config-constant-v0"`.    |
| **No scarcity signal**      | Credits accumulate without bound. No reason to value them.                                                |
| **Admin discretion risk**   | If admin could set `epoch_pool` arbitrarily, trust breaks.                                                |

## Invariants

| Rule                        | Constraint                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUDGET_HARD_CAP             | `SUM(all epoch_pools ever) ≤ budget_total`. Off-chain governance policy enforced by remaining-budget check in Crawl. In Walk+, the real cap is the on-chain emissions holder balance.                                 |
| EPOCH_POOL_DETERMINISTIC    | `epoch_pool = min(accrual_per_epoch, remaining)` when an epoch has included receipts, otherwise `0`. Policy function, not admin choice. Admin can reduce (exclude receipts, zero-weight), never inflate above policy. |
| ONE_USER_FACING_UNIT        | Users see one number in one denomination. Internal milli-units are never displayed.                                                                                                                                   |
| BUDGET_BANK_APPEND_ONLY     | Budget ledger entries are append-only so `remaining` is replayable and auditable. This is a governance transparency property, not a hard security boundary.                                                           |
| SETTLEMENT_DECOUPLED        | Attribution statements are governance commitments. Settlement (how entitlements become claims) is a separate, pluggable layer.                                                                                        |
| GOVERNANCE_REWARD_PLUGGABLE | The attribution pipeline outputs `creditAmount`. Whether credits settle into the same governance token or separate instruments is a settlement-layer decision. Attribution remains instrument-agnostic.               |

## Design

---

### Crawl — Fix the Economics (Off-Chain, No Token)

**Ship first. No contracts. No token. Just correct the math and the UI.**

#### C1. Kill "Score" — One Number, One Name

| Before                                    | After                                                            |
| ----------------------------------------- | ---------------------------------------------------------------- |
| UI: "Score" column = `units/1000`         | **Gone.**                                                        |
| UI: "Credits" = proportional share × pool | **"Credits Earned"** — the only number shown.                    |
| `creditAmount` in DB                      | Unchanged — still BIGINT, still the output of allocation math.   |
| `units` / `finalUnits` in DB              | Unchanged — still internal pipeline state. Never shown to users. |

The UI shows: **"You earned 3,420 credits this epoch (34.2% of pool)"**

"Credits" remain the unit. They are off-chain ledger entries — signed governance commitments. What they're _worth_ is a settlement concern (Walk phase).

**Files changed:**

- `src/features/governance/components/EpochDetail.tsx` — remove "Score" column, keep "Share" + "Credits Earned"
- `src/features/governance/components/ContributionRow.tsx` — remove score display, show weight as tooltip only

#### C2. Budget Policy — Finite Supply + Flat Epoch Budget

Replace the magic `base_issuance_credits: "10000"` with a hard-capped budget policy.

```
┌─────────────────────────────────────────────────────────────┐
│  Budget policy (per scope)                                  │
│                                                             │
│  budget_total: 520,000 credits  (hard cap, set once)        │
│  remaining:    520,000          (decremented per epoch)      │
│                                                             │
│  accrual_per_epoch:  10,000     (credits released per epoch) │
│                                                             │
│  epoch_pool = hasIncludedReceipts                            │
│            ? min(accrual_per_epoch, remaining)              │
│            : 0                                              │
│                                                             │
│  After epoch: remaining -= epoch_pool                       │
│                                                             │
│  When remaining = 0 → no more credits. Ever.                │
└─────────────────────────────────────────────────────────────┘
```

**Prototype default behaviors:**

- **Normal week**: epoch spends 10K if there are included receipts and `remaining ≥ 10K`.
- **Quiet week** (no activity): epoch_pool = 0. `remaining` is unchanged.
- **Busy week after quiet**: epoch still spends 10K. Quiet weeks do not create burst issuance.
- **Budget exhausted**: remaining = 0. No more credits issued. Period. (Governance can vote to extend — that's a new budget allocation, not an edit.)

Carry-over is deliberately **deferred from the first prototype**. If governance later wants deferred issuance, that becomes a new budget policy decision rather than hidden state in the MVP accounting layer.

**Why `epoch_pool` is NOT admin-settable:**
The admin controls _what activity counts_ (include/exclude receipts, weight overrides, identity resolution). The admin does NOT control _how big the pool is_. The pool is a policy function of the budget state. This prevents inflation attacks while preserving admin curation of attribution quality.

#### C3. repo-spec.yaml Changes (Crawl)

```yaml
activity_ledger:
  epoch_length_days: 7
  approvers: ["0x..."]
  budget_policy:
    budget_total: "520000" # hard cap (credits, not tokens yet)
    accrual_per_epoch: "10000" # credits released per eligible epoch
  activity_sources:
    github:
      attribution_pipeline: cogni-v0.0
      source_refs: ["cogni-dao/cogni-template"]
      streams: ["pull_requests", "reviews", "issues"]
```

`pool_config.base_issuance_credits` is **replaced** by `budget_policy`. Migration: existing epochs keep their stored `pool_components`; new epochs use the budget policy.

#### C4. Code Changes (Crawl)

| File                                             | Change                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/repo-spec/src/schema.ts`               | Add `budgetPolicySchema`. Deprecate `poolConfigSpecSchema`.                                                                                                       |
| `packages/repo-spec/src/accessors.ts`            | Add `getBudgetPolicy()` accessor.                                                                                                                                 |
| `packages/attribution-ledger/src/pool.ts`        | Add `computeEpochBudget(remaining, policy, hasIncludedReceipts)` pure function. Keep `estimatePoolComponentsV0` for backward compat.                              |
| `packages/attribution-ledger/src/budget-bank.ts` | Optional helper module if retained. MVP should model remaining-budget bookkeeping only; no hidden carry mechanics.                                                |
| DB migration                                     | Add `budget_bank_ledger` table: `(node_id, scope_id, epoch_id, entry_type, amount, remaining_after, created_at)`. Append-only for replayability and auditability. |
| `services/scheduler-worker/`                     | `CollectEpochWorkflow` reads remaining budget, computes epoch_pool via policy, records pool component.                                                            |

#### C5. Budget Policy State Machine

```
                    ┌──────────────┐
     close epoch ──►│   COMPUTE     │──► if included receipts exist:
                    │   EPOCH_POOL  │      epoch_pool = min(accrual, remaining)
                    └──────┬───────┘    else:
                                           epoch_pool = 0
                           │
                           ▼
                    ┌──────────────┐
     finalize    ──►│    SPEND      │──► remaining -= epoch_pool
                    │              │    pool_total locked on statement
                    └──────────────┘    (existing POOL_REPRODUCIBLE invariant)
```

If `remaining = 0`, `epoch_pool = 0`. Epoch still runs (activity is recorded for transparency) but no credits are distributed.

---

### Enforcement Progression — Where the Budget Cap Actually Lives

The attribution pipeline can produce a signed statement with any `poolTotalCredits`. The pipeline itself does not enforce the budget cap — it computes `epoch_pool` from policy, but nothing prevents a bug, a direct DB write, or an additional pool component from inflating the total. The enforcement point is the **token release**, not the statement.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CRAWL (off-chain only)                                                 │
│                                                                         │
│  budget_total, remaining    → Postgres + pure functions                 │
│  accrual_per_epoch          → repo-spec.yaml                            │
│  Enforcement:               → NONE. Governance policy, not security.    │
│  What stops over-issuance?  → Nothing automated. Admin reviews.         │
├─────────────────────────────────────────────────────────────────────────┤
│  WALK (first token claims)                                              │
│                                                                         │
│  Real remaining supply      → emissionsHolder.balanceOf(token) on-chain │
│  budget_total in Postgres   → reconciliation check, NOT source of truth │
│  accrual_per_epoch          → repo-spec.yaml (human-verified per epoch) │
│  Enforcement:               → Safe signers verify amount ≤ policy       │
│                                before authorizing each release.         │
│  What stops over-issuance?  → Humans reject the Safe transaction.       │
│                             → Emissions holder balance is the hard cap. │
├─────────────────────────────────────────────────────────────────────────┤
│  RUN (on-chain enforcement)                                             │
│                                                                         │
│  EmissionsController.maxPerEpoch      → on-chain, immutable per era     │
│  EmissionsController.totalReleased    → on-chain counter                │
│  Enforcement:                         → require() reverts over-budget tx │
│  Postgres budget_bank_ledger          → index/cache, not source of truth│
│  repo-spec accrual_per_epoch          → read from contract state        │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key insight:** Once the emissions holder exists on-chain (Walk), `budget_total` and `remaining` in Postgres are redundant with the on-chain token balance. The `budget_bank_ledger` is Crawl scaffolding that gets progressively replaced by on-chain state. It remains useful for off-chain auditability but is never the security boundary.

---

### Walk + Run — Settlement Handoff Contracts

> **These phases are design inputs for [proj.financial-ledger](../../work/projects/proj.financial-ledger.md).** This spec defines the economics and handoff constraints only; the settlement roadmap lives in the project.

Credits distributed by the attribution pipeline represent **equity ownership / governance stake** — not cash compensation. The MVP settlement path is single-token:

```
Attribution credits (off-chain)
  → Aragon GovernanceERC20 claims (on-chain)
  → Voting power + ownership claim
```

**Settlement contracts:**

- The settlement token is the Aragon `GovernanceERC20` created at node formation.
- Current P0 formation mints only a template-computed genesis amount to the explicit initial holder and models the rest as future supply that is not yet minted. That proves Aragon formation and verification without pretending a distribution rail exists.
- Future, unissued supply is not distributable inventory. The first live claim path must create DAO-controlled minted inventory first: either a fixed supply minted into an emissions holder/vault during formation or a later distribution-activation flow for nodes whose DAOs already exist.
- The typed handoff model lives in `@cogni/aragon-osx` as `buildDaoTokenSettlementModel()`: it classifies current genesis-holder minting as `formation_probe_only` and only reaches `claimable` once DAO-controlled inventory, a finalized signed statement, a matching Merkle manifest, and matching distributor funding are all present.
- Before Walk settlement can go live, repo-spec must carry `distributions.status: active`, `governance.token_contract`, and `governance.emissions_holder`. New nodes may get there during formation; existing DAO nodes get there through a separate activation/update flow.
- Crawl budget policy remains off-chain accounting and governance policy. It is not the hard security boundary for token release.
- In Walk, the source of truth for remaining supply is `emissionsHolder.balanceOf(token)` on-chain, not Postgres. Off-chain `remaining` becomes a reconciliation check.
- Walk uses OSS primitives: OpenZeppelin Merkle Tree tooling for manifest/proof generation and a stock audited per-epoch distributor such as Uniswap MerkleDistributor for claims. Bespoke on-chain release or mint-on-claim contracts are out of scope unless a separate contract-selection spike proves they are required.
- Merkle settlement consumes signed `creditAmount` entitlements from the finalized statement, not internal `finalUnits`.
- USDC distributions remain a separate, governance-voted financial action.

#### Edge Cases

| Edge Case               | Resolution                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `total_points = 0`      | Epoch pool = 0. No statement produced. Quiet epochs do not create larger future distributions in the prototype policy.                                                                 |
| Unresolved claimants    | Already handled by `IdentityClaimant` type. Claimant key is stable (`identity:github:12345`). Statement finalization can proceed, but on-chain settlement waits for wallet resolution. |
| Address changes         | Wallet binding layer (existing `user_bindings`). Statement references `claimantKey`, not wallet address. Claim address resolved at settlement time.                                    |
| Forked scopes           | Each scope has its own budget policy and budget cap. Fork = new scope = new supply budget. No cross-contamination.                                                                     |
| Root rotation authority | Walk: Safe/manual or equivalent trusted governance execution publishes roots and funding. Run: Governor/Timelock or stronger on-chain authorization gates it.                          |
| Unclaimed tokens        | `sweep(epochId)` after claim window → treasury. Swept amounts are NOT re-emitted.                                                                                                      |

## OSS Building Blocks

| Need                | OSS                                              | Status                           |
| ------------------- | ------------------------------------------------ | -------------------------------- |
| Governance token    | Aragon GovernanceERC20 (from node formation)     | Walk                             |
| Merkle tooling      | OpenZeppelin Merkle Tree                         | Crawl/Walk                       |
| Merkle claims       | Uniswap MerkleDistributor (per-epoch, preferred) | Walk                             |
| Governance          | OpenZeppelin Governor + TimelockController       | Run                              |
| Streaming (alt)     | Sablier Lockup / Superfluid                      | Run (optional)                   |
| Double-entry ledger | Beancount                                        | Walk (via proj.financial-ledger) |

## What Does NOT Change

- Epoch lifecycle (open → review → finalized)
- Weight config per event type
- Allocation algorithms (weight-sum-v0, future versions)
- EIP-712 signing flow
- Plugin system (enrichers, allocators)
- Claimant model (user vs identity)
- All 79 attribution-ledger invariants
- BIGINT math, largest-remainder rounding
- Determinism guarantees
