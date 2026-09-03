---
name: tokenomics-expert
description: "Tokenomics / attribution / distributions expert for cogni-template — the ownership model (nodes own money, operator owns machinery), the receipt→epoch→sign→fold→mint→claim pipeline, the plugin (profile/enricher/allocator) architecture, load-bearing invariants, and the live gotchas that keep biting (prod-DAO-in-candidate red line, baked-spec seam, born-red spawns). Use when designing/debugging/validating anything in: token distributions, epochs, attribution receipts, claimants, the finalize fold, cumulative merkle manifests, mint/setMerkleRoot/claim, DistributionsCard activation, attribution_pipeline profiles, allocators, or wiring a new activity source. Triggers: 'distribution', 'tokenomics', 'epoch', 'claim page', 'finalize', 'merkle', 'mint delta', 'attribution pipeline', 'allocator', 'claimant', 'distributor', 'emissions holder', 'activate distributions', 'R1/R2/R3/R4', 'weight-sum', 'cogni-v0.0'."
---

# Tokenomics Expert

One-pager for the token-distribution space. Read this BEFORE the specs; it points at what to read and holds the rules that aren't obvious from any single doc.

## The ownership model (one sentence)

**Nodes own the money; the operator owns the machinery.** Every node (the operator included) declares its DAO, token, distributor, approvers, and pipeline profile in ITS OWN `.cogni/repo-spec.yaml` (git-authoritative); only that node's DAO can mint its token. The operator runs shared bookkeeping — webhook ingest, per-node ledgers, epoch collection, the finalize fold, claim/read surfaces — and **never holds, mints, or moves any token**.

## The pipeline (layer → deep-dive spec)

| layer | what happens | spec |
|---|---|---|
| ingest | GitHub App webhook → operator route verifies + routes by `source_refs` → `ingestion_receipts` stamped with the OWNING node | `docs/spec/attribution-pipeline-overview.md` (START HERE) |
| epochs | `CollectEpochWorkflow` opens/closes per-node epochs, selects receipts, locks claimants | `docs/spec/attribution-ledger.md` |
| enrich + allocate | profile (`attribution_pipeline` in repo-spec) → enricher plugins (e.g. `cogni.echo.v0`) → an allocator (e.g. `weight-sum-v0`) → claimant credit | `docs/spec/plugin-attribution-pipeline.md` |
| finalize (R3) | approver EIP-712 signature → statement + fold builds cumulative merkle manifest + the `mint(delta)`/`setMerkleRoot` tx FROM the manifest | `attribution-ledger.md` + `docs/spec/tokenomics.md` |
| distribute + claim (R4) | node DAO executes mint+setRoot on Base → contributor claims on the node's claim page | `tokenomics.md` |
| identity | who owns `dao_contract`/token/distributor; wallet bindings | `docs/spec/identity-model.md` |

Umbrella hub entry (live state + this map): recall `tokenomics-distribution-map` from the operator hub.

## Load-bearing invariants

- **SPECS_GIT_AUTHORITATIVE** — every governance/config value comes from the node's repo-spec at git HEAD, never env vars. An env-var seam for activation was built once and reverted; do not rebuild it.
- **DAO_IS_MINTER / DAO_OWNS_DISTRIBUTOR** — the activation route verifies distributor ownership on-chain before recording. Never hand-edit a tracked repo-spec to activate.
- **ONE_ADMIN_SIGNATURE_PER_EPOCH** — the single finalize signature drives statement + fold + tx build. No second signing flow.
- **Fold failure never undoes finalize** — the off-chain ledger is authoritative; the fold no-ops loudly (`distribution: null`) when a node isn't activated.
- **Conservation** — minted == claimable; amounts are `numeric` columns (credits × 10^18 overflow bigint).
- **WORKER_HOLDS_NO_GITHUB_CRED** — spec reads HTTP-delegate to the operator gateway.
- **Per-node seam (bug.5020)** — the fold resolves the FINALIZING node's spec; the worker bakes no node's governance. Authoritative "inactive" NEVER falls back to baked config; only transient fetch failure does (own-node continuity).

## 🔴 THE RED LINE

**Never build a plan that ends in an approver signature on a candidate/test node whose baked spec carries the prod `dao_contract` (`0xF61c3faf…`).** Candidate builds bake one spec fleet-wide, so the execute surface downstream of a signature can target production governance — the only boundary is a YAML address + a wallet click. Before ANY signature step: verify the ENTIRE governance block of the signing target is throwaway. A defense-in-depth execute-guard exists in the machinery, but the guard is not the fix — target selection is.

## Plugin model — sovereign selection, operator-bound menu

`@cogni/attribution-pipeline-contracts` = stable framework (registries, dispatch, hashing). `@cogni/attribution-pipeline-plugins` = the menu (descriptor + adapter per enricher/allocator; profiles are plain data). A node CHOOSES its profile in its own spec; it can only choose what the shipped plugins package registers. New git-weighting = new allocator + profile in the plugins package (no framework edits). New activity source (e.g. Dolt contributions) = new source adapter at worker ingest + `activity_sources.<source>.source_refs` + plugins — larger. Nodes shipping their own plugin code is NOT built.

## Live state + operational gotchas — recall the hub, not this file

Current bugs, parser skews, seeding recipes, and which seam/PR is in flight all DRIFT — they live in
the operator hub entry **`tokenomics-distribution-map`** (`GET /api/v1/knowledge/tokenomics-distribution-map`).
Recall it FIRST every session and refine it there as state changes. This file holds only what does not
drift: the ownership model, the pipeline shape, the invariants, and the red line.

## When to escalate

- Anything touching the prod DAO address, mint authority, or approver sets → owner decision.
- Changing the fold/manifest math → conservation proof required (`finalize-mint-claim.ts` green) before review.
- New pipeline profile/source → confirm the node-sovereignty boundary (menu vs selection) hasn't moved without a spec update.
