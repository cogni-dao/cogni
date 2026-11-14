---
id: transparency-log-receipt-research
type: research
title: "Research: Transparency Log, Receipt Signing, and Distribution Engine"
status: active
trust: draft
summary: Design decisions for WorkReceipt schema, append-only transparency log with Merkle integrity, signing approach, epoch model, and deterministic distribution engine.
read_when: Implementing transparent credit payouts, designing receipt issuance, or understanding the transparency log architecture.
owner: derekg1729
created: 2026-02-17
verified: 2026-02-17
tags: [governance, transparency, payments, research]
---

# Research: Transparency Log, Receipt Signing, and Distribution Engine

> spike: spike.0082 | date: 2026-02-17

## Question

How should we design the WorkReceipt schema, transparency log storage, signing approach, Merkle integrity model, epoch boundaries, and deterministic distribution engine for CogniDAO's transparent credit payout system?

## Context

CogniDAO currently uses SourceCred for contribution scoring (graph-based PageRank over GitHub activity → grain distributions). This is opaque (no individual receipt per approval), not portable (grain is internal state), and not composable with DID/VC standards. The transparent credit payouts project (proj.transparent-credit-payouts) replaces this with three primitives:

1. **WorkReceipt** — signed proof that specific work was approved
2. **TransparencyLog** — append-only ledger with Merkle integrity
3. **DistributionEngine** — deterministic epoch-based payout computation

### What exists today

- **Billing schema** (`packages/db-schema/src/billing.ts`): `charge_receipts` table with FK to `billing_accounts`, run-level grouping via `run_id`, idempotency via `(source_system, source_reference)` UNIQUE index. `credit_ledger` is append-only with `balance_after` tracking.
- **Governance runs**: Temporal-scheduled, OpenClaw-executed. Approval is via EDO (Executive Decision Object) records in `memory/EDO/`. System tenant (`cogni_system`) acts as the execution principal.
- **SourceCred**: Config at `infra/compose/sourcecred/instance/config/`. Weights: PR=8, Review=2, Issue=1, Comment=0.5. Two allocation policies: RECENT (60% discount) + BALANCED. No on-chain distribution in template.
- **Signing**: `viem` 2.39.3 and `ethers` 5.7.2 available. No signing utilities in `src/` yet — all payment verification is read-only RPC. Viem provides `signMessage()` (EIP-191) and `signTypedData()` (EIP-712).
- **Identity**: Wallet address → user UUID → billing account UUID. DID migration planned (proj.decentralized-identity) but not blocking P0.

---

## Findings

### 1. WorkReceipt Schema

#### Option A: Flat receipt table (Recommended)

A single `work_receipts` table mirroring the `charge_receipts` pattern:

```sql
CREATE TABLE work_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_id BIGINT NOT NULL REFERENCES epochs(id),
  subject_id TEXT NOT NULL,            -- wallet address (P0), DID (P1+)
  artifact_type TEXT NOT NULL,         -- 'pr', 'governance_run', 'work_item', 'manual'
  artifact_ref TEXT NOT NULL,          -- PR URL, governance run ID, work item path
  approved_by TEXT NOT NULL,           -- key ID of approver (system tenant or human)
  approved_at TIMESTAMPTZ NOT NULL,
  units BIGINT NOT NULL,               -- points/weight (BIGINT, same as credit_ledger)
  category TEXT NOT NULL,              -- 'code', 'review', 'governance', 'ops', 'docs'
  rule_version TEXT NOT NULL,          -- git SHA of weight rules file
  receipt_hash BYTEA NOT NULL,         -- SHA-256 of canonical receipt fields
  issuer_signature BYTEA NOT NULL,     -- EIP-191 signature over receipt_hash
  metadata JSONB,                      -- extensible (commit_sha, co-signers, evidence)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Constraints:**

- `UNIQUE(artifact_type, artifact_ref, subject_id)` — idempotent (no duplicate receipts for same work)
- `CHECK(units > 0)` — no zero-value receipts
- `BEFORE UPDATE` trigger → reject all updates (append-only enforcement at DB level)
- `.enableRLS()` with `billing_account_id`-equivalent scoping via `subject_id`

**`rule_version` design:** Points to a git commit SHA of the weight rules file (e.g., `config/payout-rules.yaml`). The file is versioned in the repo. At receipt issuance time, the current HEAD SHA is captured. This is deterministic and auditable — anyone can checkout that SHA and see the exact rules used.

**`artifact_refs` flexibility:** Instead of a polymorphic array, use `artifact_type` + `artifact_ref` as a discriminated pair. Additional artifact references go in `metadata.additional_refs: [...]`. This avoids complex array indexing while keeping the primary reference queryable.

- **Pros**: Simple, queryable, follows existing `charge_receipts` pattern
- **Cons**: Less flexible than a separate artifact_refs junction table
- **Fit**: Excellent — mirrors existing Drizzle patterns, RLS-compatible

#### Option B: Normalized with junction table

Separate `receipt_artifacts` table linked 1:N to `work_receipts`. More flexible but adds complexity for what is essentially metadata.

- **Pros**: Cleaner for multi-artifact receipts
- **Cons**: Extra join, more complex queries, harder to enforce idempotency
- **Fit**: Overkill for P0

**Decision: Option A.** Single table with discriminated `artifact_type`/`artifact_ref` pair. Additional refs in JSONB metadata. Matches existing codebase patterns.

---

### 2. Signing Approach

#### Option A: EIP-191 via viem (Recommended)

Standard Ethereum personal signing. The issuer signs `keccak256(receipt_hash)` using `signMessage()`.

```typescript
import { privateKeyToAccount } from "viem/accounts";

const issuerAccount = privateKeyToAccount(ISSUER_PRIVATE_KEY);
const signature = await issuerAccount.signMessage({
  message: { raw: receiptHash }, // raw bytes, no prefix doubling
});
```

Verification:

```typescript
import { verifyMessage } from "viem";

const isValid = await verifyMessage({
  address: issuerAddress,
  message: { raw: receiptHash },
  signature,
});
```

- **Pros**: Simple, well-understood, viem already in deps, compatible with SIWE wallet ecosystem
- **Cons**: Less structured than EIP-712, not directly contract-verifiable without wrapper
- **OSS tools**: `viem` 2.39.3 (already installed)

#### Option B: EIP-712 typed structured data

The issuer signs a typed struct matching the receipt fields. More structured, directly verifiable by Solidity contracts via `ECDSA.recover()`.

- **Pros**: Machine-readable, contract-verifiable, wallets display structured data
- **Cons**: Requires `verifyingContract` address (we don't have a contract in P0), more complex setup, heavier for off-chain-only use
- **OSS tools**: `viem.signTypedData()`, `@openzeppelin/contracts` MerkleProof

#### Option C: Ed25519 service keys

Non-Ethereum signing with a dedicated service key pair.

- **Pros**: Faster, no Ethereum dependency, clean separation of signing from wallet identity
- **Cons**: Introduces a second key management system, not verifiable by Ethereum contracts, requires `@noble/ed25519` dependency
- **Fit**: Only makes sense if issuer is never a wallet

**Decision: EIP-191 (Option A) for P0.** The issuer is the system tenant, which can have a dedicated Ethereum keypair (secp256k1) stored as an env var. This keeps the signing ecosystem unified with SIWE wallets and avoids introducing Ed25519 key management. EIP-712 is a natural upgrade at P1+ when contract verification matters.

**Issuer key management:**

- P0: Single issuer key stored as `RECEIPT_ISSUER_PRIVATE_KEY` env var. The system tenant signs all receipts.
- P1+: Multi-issuer with co-signatures. Additional signers (human approvers) sign the same `receipt_hash`. Co-signatures stored in `metadata.co_signatures: [{ signer, signature }]`. Verification is additive (all signatures must be valid), not threshold-based.

---

### 3. Transparency Log Storage

#### Option A: Postgres append-only with batch Merkle tree (Recommended)

The `work_receipts` table IS the transparency log (no separate log table). Append-only is enforced at the DB level. Merkle trees are computed per-epoch at finalization time.

**Append-only enforcement (layered):**

1. **Application level**: No `UPDATE`/`DELETE` methods on the adapter
2. **DB trigger**: `BEFORE UPDATE OR DELETE ON work_receipts → RAISE EXCEPTION 'work_receipts is append-only'`
3. **RLS**: Standard tenant scoping (read access only for non-issuers)

**Merkle tree per epoch:**

```typescript
import { MerkleTree } from "merkletreejs";
import { keccak256 } from "viem";

// At epoch finalization:
const receipts = await db
  .select()
  .from(workReceipts)
  .where(eq(workReceipts.epochId, epochId))
  .orderBy(asc(workReceipts.id)); // deterministic ordering by UUID

const leaves = receipts.map((r) => r.receiptHash);
const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
const root = tree.getRoot();
```

**Epoch roots table:**

```sql
CREATE TABLE epoch_roots (
  epoch_id BIGINT PRIMARY KEY REFERENCES epochs(id),
  merkle_root BYTEA NOT NULL,
  tree_size BIGINT NOT NULL,
  root_signature BYTEA NOT NULL,       -- EIP-191 sign(epoch_id || merkle_root || tree_size)
  finalized_at TIMESTAMPTZ NOT NULL,
  rule_version TEXT NOT NULL            -- git SHA, must match all receipts in epoch
);
```

**Inclusion proof API:**

```typescript
// GET /api/v1/receipts/:id/proof
{
  receipt_id: "uuid",
  epoch_id: 42,
  merkle_root: "0x...",
  proof: ["0x...", "0x...", "0x..."],  // sibling hashes
  leaf_index: 7,
  tree_size: 128
}
```

Client verification:

```typescript
const isValid = tree.verify(proof, receiptHash, merkleRoot);
```

- **Pros**: Zero external deps beyond `merkletreejs`, Postgres is the single source of truth, follows existing DB patterns
- **Cons**: Merkle tree computed on-demand (not incremental), no built-in consistency proofs between epochs
- **OSS tools**: `merkletreejs` ^0.3.10 (MIT, TypeScript, well-maintained)

#### Option B: Incremental Merkle tree (RFC 6962-style)

Compute the tree incrementally as receipts arrive, storing intermediate hashes. Enables consistency proofs between tree states.

- **Pros**: Enables cross-epoch consistency proofs, more efficient for large logs
- **Cons**: Significantly more complex, requires storing intermediate tree state, overkill for epoch-based batches where we finalize once
- **OSS tools**: `merkletreejs.IncrementalMerkleTree` (fixed-depth), custom for variable-depth

#### Option C: External transparency log (Rekor/Trillian)

Deploy Sigstore Rekor or Google Trillian as an external service.

- **Pros**: Production-grade, battle-tested at scale (Google CT, Let's Encrypt)
- **Cons**: Go-based, requires MySQL (Trillian) or full Sigstore infra, massive operational overhead for a single-app log
- **OSS tools**: Rekor 1.7.7, Trillian (Go, MySQL)

**Decision: Option A.** Postgres append-only + batch Merkle tree per epoch. The batch model fits our epoch-based architecture perfectly — we accumulate receipts during the epoch, then compute the tree once at finalization. This is simpler than incremental and avoids external service dependencies. The abstraction boundary for future portability is the `TransparencyLogPort` interface:

```typescript
interface TransparencyLogPort {
  appendReceipt(receipt: WorkReceipt): Promise<void>;
  getEpochRoot(epochId: number): Promise<EpochRoot>;
  getInclusionProof(receiptId: string): Promise<InclusionProof>;
  verifyInclusion(proof: InclusionProof, root: EpochRoot): boolean;
}
```

If we ever swap to Trillian/Rekor, we implement a new adapter behind this port.

---

### 4. Distribution Engine

#### Inputs

1. **Receipt set**: All `work_receipts` for the epoch, queried by `epoch_id` and ordered by `id`
2. **Weight rules**: YAML file in repo at `config/payout-rules.yaml`, versioned by git SHA

```yaml
# config/payout-rules.yaml
version: "1.0"
categories:
  code:
    weight: 1.0
  review:
    weight: 0.8
  governance:
    weight: 0.6
  ops:
    weight: 0.5
  docs:
    weight: 0.4
distribution:
  method: "proportional" # receipts * category_weight / total_weighted_units
```

3. **Treasury balance**: Available funds for the epoch (queried from treasury or configured)

#### Outputs

**Payout table:**

```sql
CREATE TABLE epoch_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_id BIGINT NOT NULL REFERENCES epochs(id),
  subject_id TEXT NOT NULL,
  weighted_units BIGINT NOT NULL,        -- sum(units * category_weight) for this subject
  share_numerator BIGINT NOT NULL,       -- weighted_units
  share_denominator BIGINT NOT NULL,     -- total_weighted_units across all subjects
  payout_amount BIGINT NOT NULL,         -- (share * treasury_balance), BIGINT for precision
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(epoch_id, subject_id)
);
```

**DistributionStatement (signed):**

```sql
CREATE TABLE distribution_statements (
  epoch_id BIGINT PRIMARY KEY REFERENCES epochs(id),
  merkle_root BYTEA NOT NULL,            -- from epoch_roots
  rule_version TEXT NOT NULL,
  treasury_balance BIGINT NOT NULL,
  total_weighted_units BIGINT NOT NULL,
  num_recipients INT NOT NULL,
  total_distributed BIGINT NOT NULL,
  statement_hash BYTEA NOT NULL,         -- SHA-256 of all fields above
  issuer_signature BYTEA NOT NULL,       -- EIP-191 sign(statement_hash)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### Determinism guarantees

1. **Receipt ordering**: `ORDER BY id` (UUID v4 — ordered by creation time via `gen_random_uuid()` which is time-based in Postgres 14+, but for strict determinism, add a `seq BIGSERIAL` column)
2. **Integer arithmetic**: All amounts in BIGINT — no floating point. Share computation uses integer division with remainder handling (largest-remainder method for fair rounding)
3. **Snapshot isolation**: `REPEATABLE READ` transaction for the entire computation
4. **Rule immutability**: `rule_version` (git SHA) is captured at receipt issuance and verified at distribution time — all receipts in an epoch must reference the same rule_version

#### Edge cases

| Case                      | Handling                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treasury insufficient     | Distribution runs but `payout_amount` is proportional to available balance. Statement records actual `treasury_balance`.                                                                |
| Subject has no wallet     | `subject_id` is the wallet address (P0). If a contributor authenticated via SIWE, they have a wallet. No walletless contributors in P0.                                                 |
| Rules change mid-epoch    | Forbidden. `rule_version` is captured per-receipt. At distribution time, if receipts reference different rule_versions → error, epoch cannot finalize. New epoch starts with new rules. |
| Zero receipts in epoch    | No distribution. Epoch finalizes with empty Merkle root (convention: `0x00...00`).                                                                                                      |
| Duplicate receipt attempt | Idempotent — `UNIQUE(artifact_type, artifact_ref, subject_id)` rejects duplicates.                                                                                                      |

---

### 5. Epoch Model

#### Option A: Governance-run-triggered (Recommended)

Epochs align with governance cycles. The GOVERN orchestrator (already running hourly) can trigger epoch close as part of its schedule.

**Epoch lifecycle:**

```
OPEN → receipts accumulate
  → GOVERN run evaluates: should epoch close?
  → criteria: time-based (weekly/monthly) OR receipt count threshold
CLOSING → no new receipts accepted for this epoch
  → distribution engine computes payouts
  → Merkle tree finalized, root signed
  → DistributionStatement issued
FINALIZED → immutable
```

**Epoch table:**

```sql
CREATE TABLE epochs (
  id BIGSERIAL PRIMARY KEY,
  number BIGINT UNIQUE NOT NULL,         -- monotonic epoch number
  status TEXT NOT NULL DEFAULT 'open',   -- 'open', 'closing', 'finalized'
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  rule_version TEXT NOT NULL,            -- git SHA locked at epoch open
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(status IN ('open', 'closing', 'finalized'))
);
```

**Receipts between epochs:** At most one epoch is `open` at any time. When epoch N closes, epoch N+1 opens immediately. Receipts issued during the `closing` window (between close trigger and finalization) go into epoch N+1.

- **Pros**: Aligned with existing governance infrastructure, explicit human/agent trigger, no wall-clock drift
- **Cons**: Requires governance integration (already planned)

#### Option B: Cron-based (weekly/monthly)

A Temporal schedule closes the epoch at a fixed interval.

- **Pros**: Simple, predictable
- **Cons**: Arbitrary timing, receipts near boundary are unpredictable

#### Option C: Manual trigger only

Admin endpoint to close the epoch.

- **Pros**: Maximum control
- **Cons**: Requires human action, can stall

**Decision: Option A.** Governance-run-triggered epochs. The GOVERN orchestrator already runs hourly and can evaluate epoch closure criteria (time elapsed, receipt count, treasury funded). This keeps the epoch lifecycle under governance control without adding new infrastructure.

---

### 6. Integration with Existing Systems

#### Governance approval → Receipt issuance

The governance run approval flow (task.0054, Done) already produces EDO records. Receipt issuance hooks into this:

```
Governance Run → EDO approved → Receipt issuance event
  → work_receipts.insert({
      epoch_id: current_open_epoch,
      subject_id: contributor_wallet_address,
      artifact_type: 'governance_run',
      artifact_ref: edo_id,
      approved_by: system_tenant_key_id,
      ...
    })
```

For PR-based work (future): a merge event + maintainer approval triggers receipt issuance with `artifact_type: 'pr'`.

#### Relationship to charge_receipts

`charge_receipts` tracks **AI usage billing** (LLM calls → credit debits). `work_receipts` tracks **contribution credits** (approved work → payout entitlements). They are separate domains with no FK relationship. Both follow the same append-only, idempotent patterns.

#### System tenant as issuer

Yes. The system tenant (`cogni_system`, `00000000-0000-4000-b000-000000000000`) is the receipt issuer in P0. The `RECEIPT_ISSUER_PRIVATE_KEY` is held by the system tenant's service principal. This aligns with the existing pattern where the system tenant executes governance runs.

---

### 7. OSS Library Evaluation

| Library                     | Version | Purpose                                            | Recommendation                                     |
| --------------------------- | ------- | -------------------------------------------------- | -------------------------------------------------- |
| `merkletreejs`              | ^0.3.10 | Batch Merkle tree computation + proof generation   | **Use** — stable, TypeScript, well-maintained      |
| `viem`                      | 2.39.3  | EIP-191 signing + verification (already installed) | **Use** — already in deps                          |
| `@openzeppelin/merkle-tree` | ^1.0    | Alternative Merkle tree (Solidity-aligned)         | **Defer** — useful at P2 for contract verification |
| Sigstore Rekor              | 1.7.7   | External transparency log service                  | **Reference only** — too heavy for MVP             |
| Google Trillian             | —       | External verifiable log framework                  | **Reference only** — Go, MySQL, enterprise-scale   |
| `@noble/ed25519`            | —       | Ed25519 signing                                    | **Skip** — EIP-191 unifies with wallet ecosystem   |

---

## Recommendation

### Architecture

Use **Postgres as the single source of truth** with batch Merkle trees per epoch. No external transparency log service. The `TransparencyLogPort` interface enables future swap to Trillian/Rekor without consumer API changes.

### Signing

**EIP-191 via viem** for all signatures (receipt issuance + epoch root + distribution statement). Single issuer key (system tenant) in P0, multi-issuer co-signatures in P1+.

### Epoch model

**Governance-run-triggered** epoch boundaries. One open epoch at a time. Rule version locked at epoch open. Receipts during the closing window go to the next epoch.

### Distribution

**Proportional with integer arithmetic.** Weighted units × category weight, divided by total. BIGINT throughout. Largest-remainder rounding for fair distribution of remainders.

### Migration path from SourceCred

| Phase | SourceCred                     | WorkReceipts                            |
| ----- | ------------------------------ | --------------------------------------- |
| P0    | Running (contribution scoring) | Running (governance approval → receipt) |
| P1    | Running (reference baseline)   | Primary (UI surfaces, VC alignment)     |
| P2    | Removed                        | Sole system (portable, verifiable)      |

---

## Open Questions

- [ ] Should `seq BIGSERIAL` replace UUID ordering for strict determinism, or is `gen_random_uuid()` + `created_at` sufficient?
- [ ] Should epoch rule_version be locked at epoch open or verified per-receipt? (Recommendation: locked at open, but validate per-receipt as defense-in-depth)
- [ ] What's the minimum epoch duration? Should there be a governance-configurable minimum?
- [ ] How should the receipt issuance API be exposed? Internal-only (system tenant) or public with auth?
- [ ] Should distribution payouts integrate with the existing `credit_ledger` (as credit additions) or use a separate payout ledger?

---

## Proposed Layout

### Project

Already created: **proj.transparent-credit-payouts**. Goal and phases align with this research.

### Specs (to write)

1. **`docs/spec/work-receipts.md`** — WorkReceipt schema, signing invariants, append-only enforcement, idempotency rules
2. **`docs/spec/transparency-log.md`** — Merkle tree computation, epoch root signing, inclusion proof format, `TransparencyLogPort` interface
3. **`docs/spec/distribution-engine.md`** — Epoch model, weight rules format, deterministic computation, DistributionStatement

These could be a single spec (`transparent-payouts.md`) or split. Recommend split for clarity — each spec is independently reviewable.

### Tasks (rough sequence)

| #   | Task                                                                                                      | Est | Dependencies |
| --- | --------------------------------------------------------------------------------------------------------- | --- | ------------ |
| 1   | DB migration: `epochs`, `work_receipts`, `epoch_roots`, `epoch_payouts`, `distribution_statements` tables | 2   | —            |
| 2   | Core domain: `WorkReceipt` model, `EpochRoot` model, receipt hashing + signing                            | 2   | Task 1       |
| 3   | `TransparencyLogPort` + Drizzle adapter (append receipt, get epoch root, get inclusion proof)             | 2   | Task 1, 2    |
| 4   | `ReceiptIssuerPort` + adapter (governance approval → signed receipt → log append)                         | 2   | Task 3       |
| 5   | `DistributionEnginePort` + implementation (epoch finalization, payout computation, statement signing)     | 3   | Task 3, 4    |
| 6   | Weight rules config (`config/payout-rules.yaml`) + rule version capture                                   | 1   | Task 4       |
| 7   | API routes: receipt query, epoch view, inclusion proof, contributor history                               | 2   | Task 3, 5    |
| 8   | Integration: governance run approval → receipt issuance hook                                              | 2   | Task 4       |

Total: ~16 points across 8 tasks. P0 scope.

---

## Deferred Designs (P1+ Reference)

The following designs were explored during spike.0082 but deferred from V0 to keep the initial scope shippable. They are preserved here as reference for future phases.

### Merkle Integrity (P1)

**When to add:** When external verification without DB access is needed (federation, cross-org, on-chain anchoring).

**Library:** `merkletreejs` ^0.3.10 — batch `MerkleTree` class with `sortPairs: true` for deterministic ordering.

**Implementation sketch:**

- Add `epoch_roots` table: `epoch_id PK, merkle_root BYTEA, tree_size BIGINT, root_signature TEXT, finalized_at TIMESTAMPTZ`
- At epoch close, compute tree from `work_receipts` ordered by `id`
- Expose `GET /api/v1/receipts/:id/proof` returning sibling hashes + leaf index
- Client verification: `tree.verify(proof, receiptHash, merkleRoot)`

**Port abstraction:** `TransparencyLogPort` interface (see Findings section 3) enables future swap to Trillian/Rekor without consumer API changes.

### Non-Work-Item Contributions (P1)

**Problem:** Governance participation, community engagement, operational work don't map to merged PRs.

**Options evaluated:**

1. **Manual receipts** — governance issues receipts with `artifact_type: 'manual'` + evidence link. Simple but requires judgment calls.
2. **Category budgets** — each epoch has fixed budget per category (code 40%, governance 20%, community 20%, ops 20%). Non-code contributions compete within their category.
3. **V0 rule** — all contributions must be represented as a work item with an evidence link, or excluded.

**Recommendation for P1:** Option 1 (manual receipts) with category budgets as a P2 refinement.

### Automated Issuance Hooks (P1)

**Problem:** V0 requires manual `POST /api/v1/receipts`. For scale, PR merge should trigger receipt issuance automatically.

**Integration points:**

- GitHub webhook on PR merge → parse work item ID from PR body → issue receipt
- Governance EDO approval → receipt issuance event (task.0054 flow)
- Temporal activity for async receipt issuance with retry

### DID/VC Alignment (P2)

**Problem:** Wallet addresses are not portable. DIDs + Verifiable Credentials enable federation.

**Migration path:**

- P1: `subject_id` accepts both wallet address and `did:pkh` format
- P2: Receipts shaped as JWT VCs with `credentialSubject.id = did:pkh:eip155:1:{address}`
- See [DID-first identity research](https://cognidao.org/knowledge/did-pkh-identity-fit) for full design

### Valuation Model Evolution

**V0 model:** Estimate-based with role split (author 70%, reviewer 20%, approver 10%).

**Future options explored:**

- **Governance-assessed**: Each epoch, governance agents/humans assign point values to completed work. More flexible but introduces subjectivity.
- **Hybrid (fixed + bonus)**: Base value from estimate, plus optional governance bonus for exceptional contributions.
- **Coordinape-style peer recognition**: Members allocate GIVE tokens to peers. Interesting for community contributions but adds significant complexity.
- **Category budgets with caps**: Fixed budget per category per epoch. Prevents any single category from dominating payouts.

**Key principle:** Any valuation model must be transparent (reproducible from public inputs) and versioned (rules pinned per epoch). The V0 estimate-based model satisfies both.
