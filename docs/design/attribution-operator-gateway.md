---
id: attribution-operator-gateway
type: design
title: "Attribution: Operator-as-Gateway (multi-node ingestion + collection)"
status: draft
trust: draft
summary: "How a node gets epoch attribution in its OWN ledger: the operator gateways git activity into the node's ledger, and the node runs its own collect via the dispatch-hop. The node app is the sole writer of its ledger; one internal seam carries every write."
read_when: "Working on multi-node attribution, node ledger federation, the operator webhook gateway, or the collect dispatch-hop."
owner: derekg1729
created: 2026-07-16
spec_refs:
  - attribution-pipeline-overview-spec
  - attribution-ledger
  - spec.node-baas-architecture
  - substrate-temporal
  - temporal-patterns
  - multi-node-tenancy
  - identity-model-spec
work_items:
  - story.5023
---

# Attribution: Operator-as-Gateway

> How a node gets epoch attribution **in its own database**, visible on its own `/gov/epoch`. story.5023.

## The problem this solves

A node app reads its **own** Postgres. But the shared scheduler-worker holds **no per-node DB creds** (`SHARED_COMPUTE_HOLDS_NO_DB_CREDS`, task.0280), and attribution has **no HTTP write path** (only graphs + grants are federated, `services/scheduler-worker/src/adapters/run-http.ts`). So git activity routed to a node (#1924) lands in the **operator's** DB — invisible to the node. `node-template.cognidao.org/gov/epoch` is empty for exactly this reason.

## The invariant that resolves it

**The node app is the sole writer of its own ledger.** Only the node holds its DB creds; the shared worker is a **dispatcher**, not a DB writer. Therefore **every write to a node's ledger flows through one seam — the node's internal attribution API** — exactly mirroring the proven graph path (`executeGraphActivity` → `/api/internal/graphs/[id]/runs` → node runs it in-process against its own DB). Nodes DO have Temporal access (client + ESO namespace creds, node-baas-architecture § Node→Temporal seam); what they don't run is their own worker.

## The picture

```
① GIT INGESTION  — operator gateways the one source a node can't self-observe
   PR merged in node's source_refs repo
     → OPERATOR GitHub App  → resolve repo→owning node_id (source_refs, #1924)  → normalize → receipts
     → HTTP POST (Bearer SCHEDULER_API_TOKEN + Idempotency-Key)
     → NODE app  POST /api/internal/attribution/receipts   → node writes its OWN Postgres
     → node.ingestion_receipts

② COLLECTION  — dispatch-hop (ROADMAP)
   Temporal schedule → NodeTaskWorkflow (shared worker, no DB) → HTTP
     → NODE app POST /api/internal/attribution/collect → runCollectPass() IN-PROCESS (its profile, its DB)
     → node.epochs / selection / allocations

③ READ  (already works) — node's /gov/epoch reads its own DB
```

## Sources are a spectrum, not git-vs-node-local

The receipt seam makes source placement an **infra decision, never an attribution-model one**. A source sits somewhere between:

- **operator-gatewayed** — operator holds the source's creds/infra, observes for all nodes, resolves → owning node, delivers to the node's ingest seam. Chosen when consolidating third-party app infra is worth it.
- **node-local** — the node holds the creds, observes directly, writes its own receipts (no operator hop).

Same `ingestion_receipts` shape, same downstream pipeline. New source = one ingestion adapter → posts to the seam.

| source | initial placement | status |
| ------ | ----------------- | ------ |
| **git** (source 1) | operator-gatewayed (the one signal a node cannot self-observe) | this design |
| dolt | node-local **or** operator-gatewayed (undecided) | roadmap |
| slack / notion / linear | likely operator-gatewayed (consolidate creds) **or** node-local | roadmap |

## Profile is the ingestion SSOT (partial today)

The `attribution_pipeline` profile is meant to define **what activity a node monitors + ingests**, not only how it weights it. Today it does not: `PipelineProfile` (`packages/attribution-pipeline-contracts/src/profile.ts`) carries only `enricherRefs`/`allocatorRef`/`selectionPolicyRef`/`defaultWeightConfig`, and ingestion is `INGEST_ALL_FILTER_LATER` — `source_refs` filters at **selection** (fail-open). Until the profile carries an ingestion spec, `activity_sources.source_refs` drives **which repos**; event-type filtering stays at selection. Making the profile drive ingestion (which sources + event-types) is roadmap item 3.

## Phased delivery

- **Phase 1 (this design) — git ingestion federation.** The node's internal receipt seam + the operator delivering git receipts to it. Proof: a git PR → an `ingestion_receipts` row in the **node's own** DB. MVP auth = shared `SCHEDULER_API_TOKEN` (same as graph dispatch). No collect yet.
- **Roadmap 1 — collect dispatch-hop.** Extract `runCollectPass(store, sourceRegistrations, registries, config)` (steps are already pure callables in `ledger.ts`/`enrichment.ts`); add `POST /api/internal/attribution/collect` (mirror graph-runs); import `@cogni/attribution-pipeline-plugins` + init registries in the node container; route `LEDGER_INGEST` schedules to `NodeTaskWorkflow`→`/collect` (operator's `ledger-worker` coexists during migration). → node's `/gov/epoch` shows a real epoch.
- **Roadmap 2 — per-node dispatch principal.** Wire the fail-closed `NodePrincipalResolver` (task.5033) for graph + attribution dispatch; **retire the shared `SCHEDULER_API_TOKEN`** (the internal-ops-token we're deprecating).
- **Roadmap 3 — profile→ingestion-spec.** Add an ingestion spec to `PipelineProfile`; make ingestion profile-driven; retire `INGEST_ALL_FILTER_LATER`.
- **Roadmap 4 — non-git sources** (dolt/slack/notion) on the same seam.

## Phase 1 wire contract + files

- **Contract (seam):** `packages/node-contracts/src/attribution.receipts.internal.v1.contract.ts` — `internalDeliverReceiptsOperation` (`{ nodeId, source, receipts[] }`; receipts carry no `node_id` on the wire — the node stamps its own; Date→ISO). Mirrors `graph-runs.create.internal.v1.contract.ts`.
- **Node receiver:** `nodes/operator/app/src/app/api/internal/attribution/receipts/route.ts` — Bearer `SCHEDULER_API_TOKEN`; asserts `body.nodeId === getNodeId()` (NODE_WRITES_OWN_LEDGER); `attributionStore.insertIngestionReceipts` (idempotent). Mirrors `/api/internal/graph-runs`.
- **Operator sender:** `nodes/operator/app/src/features/ingestion/services/webhook-receiver.ts` — own node → local write (no regression); remote node → `http-receipt-delivery.ts` (mirrors `run-http.ts`) POSTs to the node's receipt seam via `COGNI_NODE_ENDPOINTS`.

## Related

- [Attribution Pipeline Overview](../spec/attribution-pipeline-overview.md) · [Attribution Ledger](../spec/attribution-ledger.md) · [Node BaaS Architecture](../spec/node-baas-architecture.md) · [Substrate Temporal](../spec/substrate-temporal.md) · [Temporal Patterns](../spec/temporal-patterns.md) · [Multi-Node Tenancy](../spec/multi-node-tenancy.md)
- Graph precedent: `services/scheduler-worker/src/adapters/run-http.ts` + `nodes/operator/app/src/app/api/internal/graph-runs/route.ts`
