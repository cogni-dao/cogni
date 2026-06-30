---
id: proj.transparent-credit-payouts
type: project
primary_charter:
title: "Transparent Credit Payouts — Weekly Activity Pipeline"
state: Active
priority: 1
estimate: 5
summary: "Epoch-based ledger where source adapters collect contribution activity (GitHub, Discord), the system proposes credit allocations via weight policy, and an admin finalizes the distribution. Payouts are deterministic and recomputable from stored data."
outcome: "A third party can recompute the payout table exactly from stored activity events + pool components + weight config. All activity is attributed to contributors via identity bindings. Admin finalizes once per epoch."
assignees: derekg1729
created: 2026-02-17
updated: 2026-03-05
labels: [governance, transparency, payments, web3]
---

# Transparent Credit Payouts — Weekly Activity Pipeline

## Goal

Build a transparent activity-to-payout pipeline. Every week the system collects contribution activity from configured sources (GitHub, Discord), attributes events to contributors, proposes a credit distribution using a weight policy, and lets an admin finalize the result. Payouts are deterministic and recomputable from stored data.

The system makes **what happened** (activity), **how it was valued** (weights), and **who got paid** (allocations) fully transparent and auditable. Valuation weights are explicit and governable — not hidden in an algorithm.

## Supersedes

**proj.sourcecred-onchain** (now Dropped) — Activity-ingestion pipeline replaces SourceCred's algorithmic grain→CSV→Safe pipeline. SourceCred continues running until migration completes. Existing SourceCred specs ([sourcecred.md](../../docs/spec/sourcecred.md), [sourcecred-config-rationale.md](../../docs/spec/sourcecred-config-rationale.md)) remain valid as-built docs.

### Why not extend SourceCred?

1. **Opaque**: Can't point to a specific activity that produced a specific score
2. **Not portable**: Grain is internal state, not auditable data
3. **Fake objectivity**: Algorithmic scoring pretends to be fair while hiding assumptions
4. **Not composable**: Doesn't align with VC/DID standards

## Roadmap

### Crawl (P0) — Ship the Activity Pipeline

**Goal:** Automated weekly activity collection from GitHub + Discord, best-effort attribution, admin-finalized credit distribution. Anyone can recompute payouts from stored data.

| Deliverable                                                                                                     | Status       | Est | Work Item       |
| --------------------------------------------------------------------------------------------------------------- | ------------ | --- | --------------- |
| Design spike: schema, signing, storage, epoch model                                                             | Done         | 2   | spike.0082      |
| Design revision: activity-ingestion reframe                                                                     | Done         | 1   | (this document) |
| Spec: attribution-ledger.md                                                                                     | Done         | 1   | —               |
| DB schema (foundation tables) + core domain (rules, errors)                                                     | Done         | 3   | task.0093       |
| Identity bindings (user_bindings + identity_events)                                                             | Done         | 2   | task.0089       |
| Ledger port + Drizzle adapter + schema migration + container                                                    | Done         | 2   | task.0094       |
| GitHub source adapter                                                                                           | Done         | 3   | task.0097       |
| Temporal workflows (collection phase)                                                                           | Done         | 2   | task.0095       |
| Identity resolution + curation auto-population                                                                  | Done         | 2   | task.0101       |
| Allocation computation + epoch close + FinalizeEpochWorkflow                                                    | Done         | 3   | task.0102       |
| Epoch 3-phase state machine + EIP-191 signing                                                                   | Done         | 3   | task.0100       |
| Zod contracts + API routes + stack tests                                                                        | Done         | 2   | task.0096       |
| Scope-gate all epochId-based adapter methods                                                                    | Done         | 1   | task.0103       |
| Dev seed script for governance UI visual testing                                                                | needs_merge  | 2   | task.0106       |
| Epoch approver UI — EIP-712 signing + review/edit/finalize admin panel                                          | In Review    | 4   | task.0119       |
| **Collection pipeline hardening (from [gap analysis](../../docs/research/ledger-collection-gap-analysis.md)):** |              |     |                 |
| Fix: unresolved contributors silently excluded                                                                  | Done         | 2   | bug.0092        |
| Collection completeness verification                                                                            | needs_triage | 2   | task.0108       |
| Expand GitHub adapter (PR comments, review comments, issues)                                                    | needs_triage | 2   | task.0109       |

**V0 user story:**

1. Temporal cron opens a weekly epoch for `(node_id, scope_id)` pair with weight config
2. `CollectEpochWorkflow` runs GitHub + Discord adapters for the time window, scoped to `scope_id`
3. Adapters normalize activity → `activity_events` (idempotent by deterministic ID)
4. System resolves platform identities → `user_id` via `user_bindings` (best-effort)
5. Weight policy computes `proposed_units` per contributor → `epoch_allocations`
6. Admin reviews allocations, adjusts `final_units` where needed
7. Admin records pool components (`base_issuance` at minimum)
8. Admin triggers finalize → `computeStatementItems(final_units, pool_total)` → `payout_statement`
9. Anyone can recompute payouts from stored `activity_events` + pool + weight config

**E2E pipeline status (gap analysis 2026-02-22):**

```
repo-spec.yaml → schedule sync → Temporal schedule → CollectEpochWorkflow (daily)
→ epoch open → ingestion runs → close-ingestion → review → sign → finalize
```

- [x] Epoch config in repo-spec.yaml (epoch_length_days, activity_sources, scope)
- [x] Schedule sync → Temporal (LEDGER_INGEST → CollectEpochWorkflow on ledger-tasks queue)
- [x] CollectEpochWorkflow orchestration (create epoch, collect from sources, insert events, save cursors)
- [x] GitHub source adapter (GraphQL, deterministic IDs, provenance, cursor-based)
- [x] DB schema (epochs, activity_events, activity_curation, epoch_allocations, pool_components, payout_statements, statement_signatures, source_cursors)
- [x] Store port + Drizzle adapter (all CRUD methods)
- [x] `computeStatementItems()` pure function (BIGINT, largest-remainder)
- [x] Identity bindings schema (user_bindings + identity_events tables) — task.0089 done
- [x] **Identity resolution activity** — resolve platformUserId → userId via user_bindings (task.0101 in review)
- [x] **Curation auto-population** — create activity_curation rows from collected events (task.0101 in review)
- [ ] **`computeProposedAllocations()`** — weight policy → epoch_allocations (task.0102)
- [ ] **Epoch auto-close** — detect period_end+grace passed, transition open→review/closed (task.0102)
- [ ] **FinalizeEpochWorkflow** — read allocations+pool, computeStatementItems, atomic close+statement (task.0102)
- [ ] **`computeAllocationSetHash()`** — canonical hash for signing (task.0102)
- [ ] **3-phase epoch status** — DB migration open/review/finalized + triggers (task.0100)
- [ ] **EIP-712 signing** — typed data, verify, store signatures (task.0100)
- [ ] **close-ingestion API route** — manual trigger for open→review (task.0100)
- [ ] **sign-data API route** — return EIP-712 typed data for signing (task.0100)
- [ ] **finalize API route** — verify review+signature, trigger FinalizeEpochWorkflow (task.0100)
- [x] **pool-components API route** — record pool components for epoch (task.0096)
- [x] **Remaining read/write API routes** — list epochs, activity, allocations, statement (task.0096 — verify deferred to task.0102)
- [ ] **Discord source adapter** — deferred (GitHub-only for V0 launch)

**Collection pipeline gap analysis ([ledger-collection-gap-analysis](../../docs/research/ledger-collection-gap-analysis.md), 2026-02-24):**

Critical comparison against SourceCred's full-history mirror model. SourceCred incrementally updates a persistent SQLite mirror and rebuilds the full contribution graph from complete state each run. Cogni's windowed epoch model is simpler and more transparent but introduces specific blindspots that must be addressed before the first real payout:

| Gap                                                                | Severity | Work Item        | Status       |
| ------------------------------------------------------------------ | -------- | ---------------- | ------------ |
| Unresolved contributors silently get zero credit                   | High     | bug.0092         | done         |
| No collection completeness verification                            | High     | task.0108        | needs_triage |
| Only 3 GitHub event types (misses review comments, issue creation) | High     | task.0109        | needs_triage |
| Missed events permanently lost after finalization (no backfill)    | Medium   | (P1 — task.0110) | not filed    |
| No pending credit for unresolved identities                        | Medium   | (P1 — task.0111) | not filed    |
| Webhook-first collection eliminates window-boundary issues         | Medium   | (P1 — task.0112) | not filed    |

**Definition of done:**

- [ ] Weekly epoch collects GitHub PRs/reviews automatically (Discord deferred)
- [x] Activity attributed to contributors via identity bindings, with unresolved identities preserved as claimants
- [x] Unlinked contributors render inline in epoch UI and finalized claimant reads without dropping their attribution (bug.0092)
- [ ] Collection completeness verified against GitHub API totals before close (task.0108)
- [ ] Admin can review and adjust proposed allocations before finalizing
- [ ] A third party can recompute the payout table from stored data exactly
- [ ] Duplicate activity collection is idempotent (deterministic event IDs)
- [ ] Epoch close is idempotent (closing twice yields identical statement hash)
- [ ] All write operations execute in Temporal workflows (Next.js stateless), except `ingestion_receipts` appends via webhook receivers (WEBHOOK_RECEIPT_APPEND_EXEMPT)
- [ ] All math is BIGINT — no floating point, including weight values (milli-units)

### Walk (P1) — Work-Item Scoring + Attribution UI

**Goal:** Improve attribution quality and make the signed statement legible to contributors. This project stops at the signed `AttributionStatement`. On-chain governance-token claims are owned by [proj.financial-ledger](proj.financial-ledger.md), which consumes the finalized statement as its settlement input.

**UI:**

| Deliverable                                                                                                           | Status      | Est | Work Item         |
| --------------------------------------------------------------------------------------------------------------------- | ----------- | --- | ----------------- |
| Attribution view: `/epochs/:id`, `/contributors/:id` — DB-sourced attribution history, activity, proposed/final units | Not Started | 3   | (create at start) |

**Settlement handoff:**

- Financial Ledger owns `signed statement → recipient resolution → Merkle root → on-chain claim`.
- This project owns the off-chain attribution UI and the signed statement artifact only.

**Enrichment + scoring pipeline:**

| Deliverable                                                         | Status      | Est | Work Item                                              |
| ------------------------------------------------------------------- | ----------- | --- | ------------------------------------------------------ |
| Scope-aware epoch API routing (blocks multi-scope)                  | Not Started | 3   | task.0123                                              |
| Epoch artifact pipeline + echo enricher                             | In Review   | 3   | task.0113                                              |
| Plugin pipeline framework + built-in plugins packages               | In Review   | 3   | task.0124                                              |
| Store ISP + Zod enricher/allocator output schemas                   | Done        | 3   | task.0133                                              |
| Typed pipeline composition — child workflows + shared proxy configs | In Review   | 3   | task.0144                                              |
| work-item-budget-v0 allocation algorithm                            | Not Started | 2   | task.0114                                              |
| Per-receipt EIP-191 wallet signing                                  | Not Started | 2   | (create at P1 start — EIP-712 foundation in task.0119) |
| `ledger_issuers` role system (can_issue, can_approve)               | Not Started | 2   | (create at P1 start)                                   |

**Multi-source economics + pool stabilization:**

| Deliverable                                                                                      | Status      | Est | Work Item  |
| ------------------------------------------------------------------------------------------------ | ----------- | --- | ---------- |
| Research spike: multi-source category pool design (repo-spec schema, cross-category governance)  | Not Started | 3   | spike.0140 |
| Category pool allocation — split epoch budget across source categories before per-source scoring | Not Started | 3   | task.0141  |
| Epoch pool value stabilization — minimum activity threshold + bounded carry-over                 | Not Started | 2   | task.0142  |

**Collection hardening:**

| Deliverable                                    | Status      | Est | Work Item             |
| ---------------------------------------------- | ----------- | --- | --------------------- |
| Retroactive backfill for finalized epochs      | Not Started | 2   | task.0110 (not filed) |
| Pending credit for unresolved identities       | Not Started | 2   | task.0111 (not filed) |
| Webhook-first GitHub collection                | Done        | 3   | task.0136             |
| X/Twitter activity adapter                     | Not Started | 2   | (create at P1 start)  |
| Funding activity adapter                       | Not Started | 2   | (create at P1 start)  |
| SourceCred grain → activity migration strategy | Not Started | 2   | (create at P1 start)  |

### Run (P2+) — Federation + SourceCred Removal + USDC Settlement

**Goal:** Receipts as portable VCs. SourceCred removed. Cross-org verification. When revenue exists, add USDC settlement via MerkleDistributor alongside governance token claims (see [proj.financial-ledger](proj.financial-ledger.md)).

| Deliverable                                                 | Status      | Est | Work Item            |
| ----------------------------------------------------------- | ----------- | --- | -------------------- |
| Receipt schema → VC data model (JWT VC, DID subject)        | Not Started | 2   | (create at P2 start) |
| Multi-issuer trust policy                                   | Not Started | 3   | (create at P2 start) |
| SourceCred removal from stack                               | Not Started | 2   | (create at P2 start) |
| USDC settlement via MerkleDistributor (when revenue exists) | Not Started | 2   | (create at P2 start) |

## Architecture & Schema

See [attribution-ledger spec](../../docs/spec/attribution-ledger.md) for full architecture, schema, invariants, API contracts, and Temporal workflows.

## Constraints

- Activity weights are transparent and governable — system never hides valuation logic
- Weight config pinned per epoch (stored in epoch row) — reproducible
- Activity events are immutable facts — append-only with DB triggers
- Pool components are pre-recorded during epoch — finalize reads them, never creates budget
- Each pool component type appears at most once per epoch (POOL_UNIQUE_PER_TYPE)
- At least one `base_issuance` pool component required before epoch finalize
- Epoch close is idempotent — same inputs produce identical statement hash
- All write operations go through Temporal — Next.js stays stateless. **Exception:** `ingestion_receipts` appends via webhook receivers (per WEBHOOK_RECEIPT_APPEND_EXEMPT)
- All monetary math in BIGINT — no floating point, including weights (integer milli-units)
- `user_id` remains the resolved human override surface for attribution, while finalized statements preserve claimant identity explicitly for linked and unlinked subjects — see [identity-model](../../docs/spec/identity-model.md)
- Identity resolution is best-effort — unresolved events flagged, not silently dropped
- Source adapters use cursor-based incremental sync — no full-window rescans
- Verification = recompute from stored data — not re-fetch from external sources

## Biggest Risks

1. **Weight policy as black box.** If weights become complex formulas with hidden multipliers, you recreate SourceCred's core problem with nicer plumbing. Weights should be simple, explicit, and governable. Admin override exists precisely because no formula perfectly captures contribution value.

2. **Multi-source dilution.** The current single-pool model dumps all receipts from all sources into one weight config. Adding source #2 (Discord, X/Twitter) silently dilutes existing contributors because cross-domain weight ratios (`discord:message_sent: 50` vs `github:pr_merged: 1000`) are ungovernable. Governance needs to control macro allocation (category shares) separately from micro allocation (within-category weights). → spike.0140, task.0141

3. **Per-event value instability.** Fixed pool + variable activity = random per-event value. One PR in a quiet week earns the full 10K pool; 20 PRs in a busy week split it at ~500 each. Once credits map to tokens, this creates permanent governance-power windfalls that positive-only rebalancing can't correct. Minimum activity thresholds + bounded carry-over are the V1 fix. → task.0142

## Dependencies

- [x] spike.0082 — design doc landed
- [x] Existing governance approval flow stable (task.0054 — Done)
- [x] Temporal + scheduler-worker service operational
- [x] SIWE wallet auth operational
- [x] task.0089 — Identity bindings (user_bindings table) — done
- [ ] task.0101 — Identity resolution + curation — in review
- [ ] task.0102 — Allocation computation + epoch close + finalize (blocked by task.0101)
- [ ] task.0100 — 3-phase epoch status + signing (blocked by task.0093)
- [ ] task.0096 — API routes (blocked by task.0095)
- [ ] GitHub API token configured
- [ ] Discord bot token configured (already exists via OpenClaw)

## As-Built Specs

- [attribution-ledger](../../docs/spec/attribution-ledger.md) — V0 schema, invariants, API, claimant-aware finalization, architecture
- [plugin-attribution-pipeline](../../docs/spec/plugin-attribution-pipeline.md) — profile-driven plugin contracts, schema-backed descriptors, generic worker dispatch
- [attribution-pipeline-overview](../../docs/spec/attribution-pipeline-overview.md) — end-to-end map from repo-spec through signed statement
- [temporal-patterns](../../docs/spec/temporal-patterns.md) — workflow conventions, child workflow composition, shared proxy configs

## Research

- [ledger-collection-gap-analysis](../../docs/research/ledger-collection-gap-analysis.md) — Critical comparison vs. SourceCred's full-history model; collection blindspots + P0/P1 remediation plan
- [epoch-event-ingestion-pipeline](../../docs/research/epoch-event-ingestion-pipeline.md) — Original adapter design spike, SourceCred plugin analysis, OSS tooling survey
- [attribution-scoring-design](../../docs/research/attribution-scoring-design.md) — LLM evaluation design, retrospective value, weekly base + quarterly retro cadence
- spike.0140 — Multi-source category pool design (pending research)

## Design Notes

### Key reframes

**From spike.0082:** spike.0082 designed a "deterministic distribution engine" with algorithmic valuation. This project corrects the model: weights propose, humans finalize.

**From receipt-signing model:** The original P0 designed per-receipt wallet-signed receipts with SIWE-gated multi-role authorization. This revision moves wallet signing to P1 and replaces manual receipt creation with automated activity ingestion. The core payout math (`computeStatementItems`, BIGINT, largest-remainder) is unchanged.

### Accounting boundary

Attribution statements produced by this project are **governance truth** — who earned what share. They are NOT financial events. No money moves when an epoch is signed. Financial settlement (treasury funding MerkleDistributor, user claims) is handled by [proj.financial-ledger](proj.financial-ledger.md). See [financial-ledger spec](../../docs/spec/financial-ledger.md) for the accounting separation.

### Technical decisions

| Decision       | Choice                                               | Why                                               |
| -------------- | ---------------------------------------------------- | ------------------------------------------------- |
| Ingestion      | Source adapters with cursor-based incremental sync   | Idempotent, handles pagination/rate limits        |
| Auth (V0)      | SIWE + simple admin check                            | Minimal — multi-role deferred to P1               |
| Storage        | Postgres append-only + DB triggers                   | Zero new deps, hard enforcement                   |
| Activity state | Single `activity_events` table, append-only          | No lifecycle — events are immutable facts         |
| Allocation     | `epoch_allocations` with proposed + final units      | Admin adjusts totals, not per-event               |
| Epoch trigger  | Temporal cron (weekly) + manual collect option       | Automated with admin override                     |
| Valuation      | Weight policy (integer milli-units) + admin override | Transparent defaults, human judgment preserved    |
| Pool           | Sum of pinned components                             | Reproducible, governable                          |
| Math           | BIGINT, largest-remainder rounding                   | Cross-platform determinism                        |
| Identity       | user_bindings table (task.0089)                      | Cross-platform identity resolution                |
| GitHub client  | `@octokit/graphql` + `@octokit/webhooks-types`       | Official, typed, maintained by GitHub             |
| Discord client | `discord.js`                                         | Only serious Discord library for Node.js          |
| Verification   | Recompute from stored data only                      | External sources may be private/non-deterministic |

### Actor integration (planned)

`user_id` is correct for P0 (humans-only attribution). When `actors` ships ([proj.operator-plane](proj.operator-plane.md)), `epoch_allocations` gains `actor_id` alongside `user_id`. Human actors bridge 1:1; agent actors are a new attribution path. Provenance is always preserved: `earned_by_actor_id` records who did the work (even if an agent). `beneficiary_actor_id` determines who may claim — a separate field, never collapsed. No schema changes until the actor table exists. See [identity-model.md](../../docs/spec/identity-model.md) for the `actor_id` primitive.

## PR / Links

- Handoff: [handoff](../handoffs/proj.transparent-credit-payouts.handoff.md)
- Handoff (multi-node git-attribution passthrough): [handoff](../handoffs/proj.multi-node-git-attribution.handoff.md)

### Known issues

- **GitHub adapter only captures merged PRs and closed issues.** Reviews are only searched on merged PRs. This means: (1) opened-but-unmerged PRs are invisible, (2) reviews on open PRs are missed, (3) newly opened issues aren't tracked. The adapter should use broader queries (`created:`, `updated:`) and emit lifecycle event types (`pr_opened`/`pr_merged`, `issue_opened`/`issue_closed`) to capture all contribution activity. Low risk for V0 since epochs are weekly and most PRs merge within a week, but will under-count reviewers and issue authors. → **task.0109**
- **Ownership summary scales linearly with epoch count.** `readOwnershipSummary` loads claimant subjects per epoch sequentially. Acceptable now, but it becomes a real latency issue as finalized history grows. → **bug.0093**
- **No collection completeness verification.** Under-collection from rate limits or API failures is indistinguishable from a quiet week. No comparison of collected counts vs. GitHub API totals. → **task.0108**
- **No retroactive backfill.** If collection misses events and the epoch finalizes, those events are permanently lost. SourceCred's mirror model catches up on next run; our windowed model has no equivalent. → **P1 task.0110**

### What V0 explicitly defers

- **Governance token claims (full claim rail)** → P1 (Merkle tree → ERC20Votes contract → claim flow)
- **Operator Port** → P1 (Safe/multisig for publishing Merkle roots + statement signing)
- **Per-receipt wallet signing** → P1 (EIP-191, domain-bound)
- **`ledger_issuers` role system** → P1
- **UI: attribution view + on-chain holdings view** → P1
- **DID/VC alignment** → P2
- **Federation / cross-org verification** → P2
- **USDC settlement** → P2 (when revenue exists, see proj.financial-ledger)
- **X/Twitter + funding adapters** → P1
- **Discord source adapter** → deferred from V0 launch (GitHub-only initially)
- **Category pool splitting** → P1 (single source = single pool is fine; required before source #2 ships — spike.0140, task.0141)
- **Epoch pool value stabilization** → P1 (minimum activity threshold + carry-over — task.0142)
- ~~**GitHub webhook fast-path**~~ → Done (task.0136)
