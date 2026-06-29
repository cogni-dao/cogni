---
id: proj.financial-ledger
type: project
primary_charter:
title: "Financial Ledger — TigerBeetle Treasury + MerkleDistributor Settlement"
state: Active
priority: 1
estimate: 5
summary: "All money I/O in one place. TigerBeetle as the double-entry transaction engine, Postgres for metadata. LedgerPort is the write path for all money-movement. Signed attribution statements become auditable Merkle claim manifests and DAO-controlled token distributions."
outcome: "Every dollar in and every token out has a TigerBeetle double-entry transfer and an auditable settlement manifest. Finalized attribution statements produce DAO-controlled Merkle claims that contributors can actually claim on-chain."
assignees: derekg1729
created: 2026-02-28
updated: 2026-03-09
labels: [governance, payments, web3, treasury]
---

# Financial Ledger — TigerBeetle Treasury + MerkleDistributor Settlement

> Spec: [financial-ledger](../../docs/spec/financial-ledger.md)
> Ingestion: [data-ingestion-pipelines](../../docs/spec/data-ingestion-pipelines.md)

## Goal

Build the money side of the DAO. The Attribution Ledger answers "who did what and how much credit?" — this project answers "where did the money go?"

**Two settlement instruments, different triggers:**

| Instrument                   | Trigger                                   | Execution model                         |
| ---------------------------- | ----------------------------------------- | --------------------------------------- |
| **Governance/rewards token** | Finalized statement → published claim set | Trusted DAO-controlled execution in MVP |
| **USDC payouts**             | Governance vote                           | Manual / governance-gated (future)      |

**Key accounting separation:** A signed attribution statement is a governance commitment (who earned what share), NOT a financial event. Financial events occur only when funds move on-chain:

1. **Epoch signed** — optional accrual entry (Dr Expense:ContributorRewards:Equity / Cr Liability:UnclaimedEquity). No money moves.
2. **Treasury funds distributor** — real financial event (Dr Liability:UnclaimedEquity / Cr Assets:EmissionsVault:COGNI). Operator Port executes.
3. **User claims on-chain** — liability reduction via MerkleDistributor claim (equity tokens).
4. **Governance-voted USDC distribution** (future) — separate proposal + vote + execution path. Not automated by the attribution pipeline.

TigerBeetle is the transaction engine enforcing double-entry at the database level. Postgres stores operational metadata. Separate TigerBeetle ledger IDs per instrument type (USDC, COGNI, EUR, CREDIT). Rotki enriches crypto tx history and tax lots but is NOT the canonical ledger.

> **Design input:** [tokenomics spec](../../docs/spec/tokenomics.md) — budget policy, emission schedules, settlement handoff. Crawl phase (budget policy + UI) lives in `proj.transparent-credit-payouts`; Walk + Run (token distribution and settlement hardening) lives here.

## Supersedes

**proj.dao-dividends** (Superseded) — Splits-based push distribution replaced by MerkleDistributor user-initiated claims.

## Roadmap

### Crawl (P0) — Rewards-Ready Formation + Settlement Artifacts

**Goal:** Make the token and artifact model trustworthy before any live claims. Reuse the Aragon `GovernanceERC20` as the rewards token, add a distribution-activation path that verifies DAO-controlled emissions inventory for new or existing DAOs, and produce auditable settlement artifacts from finalized statements.

| Deliverable                                                                                                                                                                                          | Status      | Est | Work Item         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | ----------------- |
| **BUG: TB unreachable all envs — native client floods ~72M garbage lines/day to Grafana Cloud**                                                                                                      | In Progress | 3   | `bug.0195`        |
| TigerBeetle ledger + FinancialLedgerPort — 5-account MVP (credits + USDC), co-writes for AI spend + credit deposits                                                                                  | In Review   | 3   | `task.0145`       |
| Distribution activation: verify `GovernanceERC20` token + DAO-controlled emissions holder, write `governance.emissions_holder`, and flip `distributions.status: active` for new or existing DAOs     | Not Started | 2   | `task.0135`       |
| OSS-backed Merkle manifest builder — takes finalized statement `credit_amount` entitlements + settlement policy → root + proofs per claimant, with parity vectors for the selected stock distributor | Not Started | 2   | (create at start) |
| Settlement manifest store/view — persist `epochId`, `statementHash`, `merkleRoot`, `totalAmount`, `fundingTxHash`, `publisher`, `publishedAt`                                                        | Not Started | 2   | (create at start) |
| Recipient resolution gate — unresolved claimants block settlement eligibility                                                                                                                        | Not Started | 2   | (create at start) |
| Threat model + operational integrity controls for publish/fund flow                                                                                                                                  | Not Started | 1   | (create at start) |
| Compact lifecycle doc for token flow — formation mint → statement → manifest/root → funded distributor → claim                                                                                       | Not Started | 1   | (create at start) |

### Walk (P1) — Trusted GovernanceERC20 Claims

**Goal:** Ship the first community-respectable claim rail using boring, audited primitives and explicit trusted governance execution.

| Deliverable                                                                                                                                                | Status      | Est | Work Item            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Stock per-epoch Uniswap `MerkleDistributor` deployment path (default)                                                                                      | Not Started | 2   | (create at P1 start) |
| Distributor choice spike — only adopt audited multi-epoch variant if operational need is proven                                                            | Not Started | 1   | (create at P1 start) |
| Settlement port interface (`SettlementStore`) — publish root, record funding tx, track claims                                                              | Not Started | 2   | (create at P1 start) |
| Operator Port integration for treasury signing (Safe/manual publish + fund)                                                                                | Not Started | 2   | (create at P1 start) |
| Temporal workflow: `SettleEpochWorkflow` — reads finalized statement, computes Merkle tree, publishes manifest, funds distributor, records ledger transfer | Not Started | 2   | (create at P1 start) |
| On-chain receipt adapter: USDC inbound payments → TigerBeetle ledger transfers                                                                             | Not Started | 2   | (create at P1 start) |
| Claim flow UI — contributor connects wallet, sees unclaimed epochs, submits Merkle claim transaction                                                       | Not Started | 2   | (create at P1 start) |
| Holdings view — token balance, claim history, and claimed/unclaimed epoch status                                                                           | Not Started | 2   | (create at P1 start) |
| Treasury read API: settlement history + manifest lookup (queries TigerBeetle + settlement store)                                                           | Not Started | 2   | (create at P1 start) |

### Run (P2+) — On-Chain Enforcement + Multi-Instrument Hardening

**Goal:** Harden release integrity only after live usage proves the shape. Add on-chain enforcement, richer settlement instruments, and git-canonical bundles.

| Deliverable                                                                                         | Status      | Est | Work Item            |
| --------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| On-chain emissions controller — enforce release caps / epoch timing / authorized publication        | Not Started | 3   | (create at P2 start) |
| Statement/root binding on-chain — published roots cryptographically tied to `statementHash`         | Not Started | 3   | (create at P2 start) |
| Governor/Timelock-native authorization for publish/fund actions                                     | Not Started | 2   | (create at P2 start) |
| Halvening emissions / richer budget policy after live usage                                         | Not Started | 2   | (create at P2 start) |
| Governance-voted USDC distribution path (proposal → vote → execute via Operator Port)               | Not Started | 2   | (create at P2 start) |
| Multi-instrument `computeSettlement()` — splits each user's share across instruments                | Not Started | 2   | (create at P2 start) |
| Member capital sub-accounts in TigerBeetle: `Liability:MemberEquity:{userId}`                       | Not Started | 2   | (create at P2 start) |
| Reserve fund account: `Equity:Reserves:Collective`                                                  | Not Started | 1   | (create at P2 start) |
| Git-canonical `bundle.v1.json` — finalized statement + settlement + hash chain (`prev_bundle_hash`) | Not Started | 3   | (create at P2 start) |
| Bundle commit bot: PR flow, Postgres becomes index keyed by `(bundle_hash, commit_sha)`             | Not Started | 2   | (create at P2 start) |
| Equity redemption workflow — convert retained equity to USDC claim (governance-gated)               | Not Started | 2   | (create at P2 start) |
| Federation `upstreams[]` — reference upstream bundles for fork-inheritable credit                   | Not Started | 2   | (create at P2 start) |
| Foundation royalty pool component — enrolled nodes auto-insert upstream royalty into pool           | Not Started | 2   | (create at P2 start) |
| Portable identity mapping — wallet addresses as cross-fork recipient identifiers                    | Not Started | 2   | (create at P2 start) |
| On-chain Merkle root anchoring for settlement bundles                                               | Not Started | 2   | (create at P2 start) |

## Constraints

- Financial Ledger does NOT redefine attribution semantics — it consumes finalized `AttributionStatement` as input
- Attribution finalization is NOT a financial event — it is a governance commitment (liability, not transfer)
- **Equity tokens are the primary distribution instrument** — USDC payouts are a separate, governance-voted action
- **Signed statement is the settlement input** — settlement consumes the finalized `AttributionStatement`; no second approval signature is introduced at settlement time
- **V0 settlement requires fully wallet-resolved claimants** — unresolved identity claimants remain in the signed statement but block on-chain settlement for that epoch
- **Multi-instrument capable** — separate TigerBeetle ledger IDs per asset type (USDC, COGNI, EUR, CREDIT)
- TigerBeetle is the canonical transaction engine; Postgres stores operational metadata
- Rotki for crypto tx enrichment/tax lots only — NOT the canonical ledger
- All monetary math uses BIGINT (inherits `ALL_MATH_BIGINT` from attribution-ledger spec)
- MerkleDistributor (Uniswap pattern) for on-chain claims — user-initiated, not push distribution
- No bespoke rewards token contract — reuse Aragon `GovernanceERC20`; distributor should be battle-tested
- Operator Port required for treasury signing — not a custodial wallet, not raw private keys
- MVP claims are **trusted governance execution** — Safe/manual or equivalent DAO-controlled publication and funding, not on-chain emissions enforcement
- Settlement manifest required for every published root/funding action
- Integrity controls are P0/P1, not a later nice-to-have: branch protection, required reviews, signed releases or attestations, reproducible builds, and Safe policy for publish/fund
- Co-op semantics: retained equity is par-value member capital, NOT speculative tokens
- Reserve fund is collective/unallocated — not claimable per member on exit
- Settlement policy is governance-controlled, stored in repo-spec (same pattern as `ledger.approvers`)
- Temporal workflow IDs and config keys: use `treasury-*` namespace (separate from `ledger-collect-*`)
- Off-chain budget policy informs settlement accounting, but it is **not** the hard security boundary for token release

## Dependencies

- [x] proj.transparent-credit-payouts P0 — finalized attribution statements exist
- [ ] task.0130 (tokenomics Crawl) — budget policy replaces magic pool_config
- [ ] task.0142 (epoch pool value stabilization) — minimum activity threshold + carry-over prevents quiet-week windfalls before credits map to tokens
- [ ] spike.0140 (multi-source category pool design) — informs credit:token ratio and settlement policy shape
- [ ] Operator Port operational (signing + policy boundary for treasury actions)
- [ ] `task.0135` — distribution activation decisions and implementation completed
- [ ] Stock per-epoch MerkleDistributor path selected and deployed on Base
- [ ] TigerBeetle deployed + LedgerPort wired (task.0145)

**Crawl handoff into this project:**

- `task.0130` retires `pool_config.base_issuance_credits` in favor of `budget_policy`.
- `budget_bank_ledger` is seeded from historical finalized `base_issuance` totals; settlement does not infer extra future issuance from quiet historical epochs.
- Settlement still starts from finalized signed statements. Budget policy changes pool sizing policy, not claimant allocation semantics.

## As-Built Specs

- [financial-ledger](../../docs/spec/financial-ledger.md) — treasury accounting invariants, accounts hierarchy
- [tokenomics](../../docs/spec/tokenomics.md) — budget policy and settlement handoff (design input, proposed)
- [data-ingestion-pipelines](../../docs/spec/data-ingestion-pipelines.md) — shared event archive, Singer taps
- [attribution-ledger](../../docs/spec/attribution-ledger.md) — ingestion spine, receipt schema, cursor model
- [billing-evolution](../../docs/spec/billing-evolution.md) — credit unit standard, charge receipts (current as-built)
- [cred-licensing-policy](../../docs/spec/cred-licensing-policy.md) — federation enrollment model (P2 dependency)

## Design Notes

### Shared event archive, N domain pipelines

```
LAYER 0 — EVENT ARCHIVE (shared, domain-agnostic)
├── ingestion_receipts  (append-only raw facts, NO domain tag)
├── ingestion_cursors   (adapter sync state)
├── Source adapters     (Singer taps + V0 TS adapters, coexisting)
├── Deterministic IDs   (e.g., github:pr:owner/repo:42)
└── Provenance          (producer, producerVersion, payloadHash)

LAYER 1 — DOMAIN PIPELINES (each selects independently from Layer 0)
├── Attribution:  select → evaluate → allocate → statement (governance truth)
├── Treasury:     classify → journal entry → settlement → reconciliation (financial truth)
├── Knowledge:    extract → link → version (future)
└── ???:          whatever the AI-run DAO needs next
```

### Two-instrument settlement model

An attribution statement says: "User A earned 40%, User B earned 35%, User C earned 25% of a 10,000 credit pool."

**V0 (Crawl/Walk):** 100% governance/rewards token. Statement → settlement manifest → per-epoch Merkle root → users claim tokens from `MerkleDistributor` under trusted DAO-controlled execution.

**V1+ (Run):** Settlement policy (governance-controlled) may split across instruments:

- **Equity tokens**: Primary instrument. Claimable from MerkleDistributor (automated per epoch).
- **Retained equity**: Credited to member capital account in TigerBeetle (redeemable later, not on-chain).
- **USDC (governance-voted)**: Separate from automated attribution. Governance proposal → vote → operator executes. Can be pro-rata to token holders or per-statement.

### Equity token = governance + ownership

The rewards token IS the node's Aragon `GovernanceERC20`. Single-token model in V0. Contributors earn governance power and ownership claim through the same token. For settlement, DAO-controlled minted inventory sits in an emissions holder, and epoch budgets determine how much of that supply becomes claimable over time. Governance can vote to:

- Distribute USDC from treasury to token holders
- Modify settlement policy for future epochs
- Extend the EmissionsVault with additional token supply (new governance vote required)

Retained equity (P1) is par-value member capital — redeemable at face value on a revolving schedule. Not speculative.

### OSS reference implementations

- **Uniswap MerkleDistributor** — battle-tested per-epoch claim contract. Our default MVP on-chain settlement primitive.
- **OpenZeppelin Merkle Tree** — default off-chain tree/proof generator for manifests. It avoids maintaining bespoke tree logic while keeping contract-compatible leaves explicit.
- **TigerBeetle** — purpose-built financial transactions database (Apache 2.0, Jepsen-verified). Our canonical ledger engine.
- **Rotki** — crypto bookkeeping/tax assistant. Enrichment + validation, not canonical.
- **Open Collective** — transaction pairing/grouping, expense→approval→payout flows. Reference for the posting/settlement layer.
- **SourceCred** — `data/ledger.json` in-repo pattern. Reference for P2 git-canonical bundles.

### Threat model

- Malicious maintainer changes the settlement code path or manifest before release.
- Compromised operator publishes a root early or funds the wrong amount.
- Statement/root mismatch: valid statement, wrong published root.
- Replay or duplicate publication for an epoch.
- Overfunding a distributor beyond the intended epoch amount.

Controls live in the spec and constraints for this project: required review, signed release or attestation, reproducible settlement artifacts, Safe/manual execution policy, settlement manifest storage, and epoch-level publication records.

### What V0 explicitly defers

- USDC distribution (governance-voted, separate from automated equity distribution) (P1)
- Halvening emissions / era-based decay (P1)
- Tokenomics template system (P1)
- Retained equity / member capital accounts (P1)
- Reserve fund accounting (P1)
- Governance snapshot pinning (P1)
- Git-canonical finalized bundles (P2)
- Fork-inheritable credit history (P2)
- Federation royalty pool components (P2)
- Equity redemption schedules (P2)
- On-chain Merkle anchoring (P2)
- Voting thresholds / multisig quorum for settlement approval (P2)

## PR / Links

- Handoff: [handoff](../handoffs/proj.financial-ledger.handoff.md)
