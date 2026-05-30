---
id: proj.spec-layering
type: project
title: Repo-Spec Tier Layering & Cross-Layer Lineage
state: Active
priority: 2
estimate: 5
summary: Rationalize the .cogni spec surface into three explicit tiers (repo-manifest / node-spec / scope-spec), collapse the operator's duplicated identity, and pin git+dolt hashes into the governance signature for verifiable cross-layer history.
outcome: A node's identity and governance live in exactly one tier with no hand-synced duplication; scope governance is file-optional (inlined until a second scope); and a governance signature binds git SHA + dolt commit + scope_id so lineage is provable git ↔ dolt ↔ chain.
assignees: derekg1729
created: 2026-05-30
updated: 2026-05-30
labels: [identity, governance, ci-cd, architecture]
---

# Repo-Spec Tier Layering & Cross-Layer Lineage

## Goal

The `.cogni/` spec surface conflates three altitudes in one file and duplicates the operator's identity across the repo root and `nodes/operator/`. This project makes the latent three-tier layering explicit (it is already declared in [identity-model.md](../../docs/spec/identity-model.md) and half-enforced by the per-node Dockerfile), removes the duplication, keeps multi-scope file-optional (YAGNI until a second scope), and lands the one-column merkle-join seam that lets a future governance signature prove connected history across git, Dolt, and the chain.

Anchored to MVP reality: ship the cheap clarity now, defer the scope-overlay machinery until a real second scope exists, and treat the merkle anchor as a single field added when signing goes live — **zero new infrastructure**.

## Roadmap

### PR-1 — Tier clarity + single operator home (ship now)

**Goal:** one home per node for identity/governance; no hand-synced duplication; tiers named in schema + spec.

| Deliverable | Status | Notes |
| ----------- | ------ | ----- |
| Verify what `cogni-git-review` reads from root `.cogni/repo-spec.yaml` (gates only? dao/approvers for monorepo review context?) | Not Started | Gates the field-removal below. Runtime app already loads `nodes/<n>/.cogni` per `nodes/operator/app/Dockerfile:83-84`. |
| Strip operator-node identity (`node_id`, `scope_id`, `cogni_dao`, `operator_wallet`, `payments`) from **root** `.cogni/repo-spec.yaml`; keep only monorepo concerns (`gates`, `fail_on_error`, review config) + node registry | Not Started | Operator identity stays in `nodes/operator/.cogni/repo-spec.yaml` only (`SINGLE_HOME`). |
| Node registry SSOT decision: `nodes:[]` cites `infra/catalog/*.yaml` or is removed in favor of it (`CATALOG_IS_SSOT`) | Not Started | Three registries today: `nodes:[]`, `infra/catalog`, filesystem. Pick one; the billing-ingest endpoints are the only thing `nodes:[]` uniquely carries. |
| `# TIER:` field-grouping banners in `@cogni/repo-spec` Zod schema + `repoSpec.server.ts` | Not Started | Documents the layering at the schema, no behavior change. |
| Refine `identity-model.md` — Spec File Layering + Lineage sections | **Done** | Landed in this branch. |
| Update `.cogni/sync-manifest.yaml` divergences if root field set changes | Not Started | Root repo-spec is per-artifact divergent; any restructure must reconcile node-template + cogni-poly. |

### PR-2 — File-optional scope overlay in `@cogni/repo-spec` (build when a 2nd scope is real)

**Goal:** multi-scope lights up with zero call-site churn; attribution's already-built `SCOPE_GATED_QUERIES` connects.

| Deliverable | Status | Notes |
| ----------- | ------ | ----- |
| `parseRepoSpec` merges optional `.cogni/projects/<scope_key>.yaml` over the inlined default | Not Started | Pure logic in the package, not the server wrapper. |
| `extract{Dao,Wallet,Payment,Approvers}` resolve per-scope; accessor API (`getDaoConfig()`, …) unchanged | Not Started | Single-scope path identical → no churn across ~50 call sites. |
| Spec'd now; **not built** until a second scope exists (one-tier-in-flight) | Not Started | Avoids over-building V0. |

### PR-3 — Merkle-join field (future, one column, when signing goes live)

**Goal:** the governance signature is the cross-layer anchor.

| Deliverable | Status | Notes |
| ----------- | ------ | ----- |
| Extend `APPROVERS_PINNED_AT_REVIEW` to also pin `scope_spec_git_sha` (+ content hash) on the epoch at `closeIngestion` | Not Started | Single column; the git↔ledger link. |
| Extend EIP-712 typed data (`SIGNATURE_SCOPE_BOUND` → `SIGNATURE_BINDS_SOURCES`) to bind `scope_spec_git_sha + evidence_dolt_commit` | Not Started | Closes git ↔ dolt ↔ chain in one signature. |

## Constraints

- `SINGLE_HOME`: a node's identity/governance fields live in exactly one tier; the operator (hub + node) keeps them in its node-spec, never the repo root.
- `SPECS_GIT_AUTHORITATIVE`: `.cogni/*.yaml` never sync into Dolt/Postgres as a second authority; queryable history is a rebuildable projection only.
- `LINEAGE_PINS_HASHES`: cross-layer dependencies pin content hash + ref, never copy.
- One tier in flight: do not build PR-2 until PR-1 ships; do not build PR-3 until signing is live.
- No work-item fan-out: this project doc is the single tracking artifact; next steps are prose, not a fan of API tasks.

## Dependencies

- **task.0122** (operator NodeRegistryPort / multi-tenant repo resolution) — overlaps the node-registry SSOT decision in PR-1. Coordinate; do not create a competing registry.
- **proj.node-registry / task.5083** (setup wizard, Postgres `nodes` state) — adjacent; that project *creates* nodes, this one *layers* their specs. Keep the catalog-is-SSOT line consistent across both.
- **Incoming OpenBao / ESO work** (cicd-secrets-expert, backflowed from node-template) — touches the node-spec `secrets:` block (Tier 2). Settle secret-store field placement in the node-spec tier before that lands to avoid a re-edit.
- **Attribution ledger** (`proj.transparent-credit-payouts`) — owns the `APPROVERS_PINNED_AT_REVIEW` and signing surfaces PR-3 extends.

## As-Built Specs

- [identity-model.md](../../docs/spec/identity-model.md) — Spec File Layering, Lineage & Cross-Layer Proof, identity primitives (canonical home for this design)
- [attribution-ledger.md](../../docs/spec/attribution-ledger.md) — `APPROVERS_PINNED_AT_REVIEW`, `SIGNATURE_SCOPE_BOUND`, scope gating that PR-2/PR-3 connect to
- [repo-sync-contract.md](../../docs/spec/repo-sync-contract.md) — per-artifact repo-spec divergence rules PR-1 must reconcile

## Design Notes

Runtime load model (verified 2026-05-30): `nodes/<node>/app/Dockerfile` copies that node's own `.cogni` to `/app/.cogni`; `COGNI_REPO_PATH=/app` (k8s) / `/repo/current` (compose). So the per-node `repo-spec.yaml` is the live node-spec; the root file is the cogni-git-review manifest for the monorepo. The operator's identity appearing in both is the duplication PR-1 removes.

The three-tier model is not a new invention — `identity-model.md` already declared `node_id` ⊥ `scope_id` and "dao_address is an attribute of a scope, lives in `.cogni/projects/*.yaml`". The code and file layout lagged the spec; this project closes that gap rather than designing anew.
