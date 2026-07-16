---
id: story.5023.handoff
type: handoff
work_item_id: story.5023
status: active
created: 2026-07-16
updated: 2026-07-16
branch: derekg1729/attribution-operator-gateway-p1
last_commit: 2248d770f0
---

# Handoff: Multi-node attribution — operator-as-gateway

## Mission

**Pickup:** Make a **spawned node** (node-template, boop, any fork) show real epoch attribution on **its own** `/gov/epoch`, collected from git activity — the way the **operator node already does** on prod (operator epochs 4/5 have real contributors). The operator is the product; attributing contribution across the node network is a vNext pillar. Phase 1 (git ingestion federation) is **shipped**. You own the roadmap — the highest-value next step is **R1 (collect dispatch-hop)**, which is what actually makes a node's epoch *visible*.

## Goal

- A git PR merged in a node's `source_refs` repo → an `ingestion_receipts` row in **that node's own DB** (Phase 1, done) → the node runs collect in-process → **the node's own `/gov/epoch` lists the contributor**.
- E2E validation signal: on candidate-a, merge a PR in a routable node's `source_refs` repo (a `cogni-test-org` repo, whose webhooks reach candidate-a), then read that node's **own** attribution surface and see the receipt/epoch — NOT the operator's.
- Candidate-a flight proof (every PR): `POST /api/v1/vcs/flight`, confirm `https://test.cognidao.org/version` `buildSha` == PR head, then exercise the deployed surface + read your own request from Loki (`namespace="cogni-candidate-a"`), then post a `/validate-candidate` scorecard. That scorecard is the merge gate.

## Start By Reading

- **`docs/design/attribution-operator-gateway.md`** — the locked design + visual + phased roadmap (R1–R4). Read this first.
- Knowledge hub: recall `multi-node-attribution-collect` (guide) + `attribution-node-epoch-visual` (html) — inbox `contrib-derek-conductor-dereks-macbook-p-e82d9d72`.
- `docs/spec/attribution-pipeline-overview.md` (pipeline + profile), `docs/spec/node-baas-architecture.md` §"Node→Temporal seam", `docs/spec/temporal-patterns.md` (dispatch-hop, per-node principal), `docs/spec/multi-node-tenancy.md` (`SHARED_COMPUTE_HOLDS_NO_DB_CREDS`, task.0280).
- **Graph precedent to mirror** (the whole model): `services/scheduler-worker/src/adapters/run-http.ts` + `nodes/operator/app/src/app/api/internal/graph-runs/route.ts` (+ the in-app graph executor at `nodes/operator/app/src/app/api/internal/graphs/[graphId]/runs/route.ts`).
- Phase 1 code (this branch): the `## Pointers` table below.

## Current State

- **Merged to main:** #1924 (route webhooks to owning node by `source_refs`), #1916 (node-addressable `/api/v1/nodes/[id]/attribution/*` reads).
- **Phase 1 — #1946 MERGED to `main`** (commit `6471076b`, 2026-07-16): node internal receipt seam + operator HTTP delivery + design doc. CI green; validated on candidate-a (🟡 scorecard on the PR — own-node no-regression + route live/gated proven; positive remote delivery deferred).
- **PR #1944 (old "step-2") is CLOSED/superseded** — it extended the operator boot-time governance-sync to schedule each node's `CollectEpochWorkflow` on the shared `ledger-worker`. Wrong model: that worker writes to ONE `DATABASE_URL`, so a foreign node's epochs land in the operator's DB, not the node's. Do not revive it.
- **Verified truth:** collect is currently Temporal-worker-bound (`services/scheduler-worker/src/ledger-worker.ts`); the node app is Next.js-only (`attributionStore` read-only). Operator epochs work; other nodes' don't — because nothing writes to *their* DB.
- **Known gap (Phase 1):** positive *remote* delivery (operator sender → a foreign node's receiver → that node's DB) is UNPROVEN on candidate-a — no deployed foreign node exists in the operator app's `COGNI_NODE_ENDPOINTS` (an env this PR adds; unset on candidate-a). Own-node path is unchanged (no prod regression).

## Design / Implementation Target

Invariant (must hold across all phases): **the node app is the SOLE writer of its own ledger.** The shared worker dispatches over HTTP and holds no per-node DB creds. Auth uses the shared `SCHEDULER_API_TOKEN` as MVP (same as graphs) — **retire it for the per-node dispatch principal (task.5033) as the immediate hardening.**

**R1 — collect dispatch-hop (do this next):**
1. Extract a plain `runCollectPass(store, sourceRegistrations, registries, config)` from the Temporal workflow — the steps in `services/scheduler-worker/src/activities/{ledger,enrichment}.ts` are already pure callables over the store + plugin registries.
2. Add `POST /api/internal/attribution/collect` on the node app (mirror `/api/internal/graph-runs`): Bearer-gated, runs `runCollectPass` in-process against the node's OWN DB. Import `@cogni/attribution-pipeline-plugins` + init registries in the node container (currently missing).
3. Route `LEDGER_INGEST` schedules to `NodeTaskWorkflow` → the node's `/collect` route, instead of `CollectEpochWorkflow` on `ledger-tasks`. Keep the operator's existing `ledger-worker` coexisting during migration (no-regression for operator epochs).
4. Must NOT regress: the operator's own epochs (they run on `ledger-worker` today). Must NOT: give the shared worker a per-node DB credential.

**R2/R3/R4** (later, per design doc): per-node dispatch principal (retire the shared token); profile→ingestion-spec (profile defines *what to ingest*, retiring `INGEST_ALL_FILTER_LATER`); non-git sources (dolt/slack/notion) on the same receipt seam.

## Next Actions / Risks

- [x] #1946 merged to main (commit 6471076b, 2026-07-16).
- [ ] Provision `COGNI_NODE_ENDPOINTS` for the operator app + confirm a reachable foreign node, then prove positive remote delivery (the Phase-1 🟡 → 🟢).
- [ ] Build R1 (steps above) as its own PR off `main`; validate on candidate-a → node's own `/gov/epoch` shows an epoch.
- **Gotcha:** to prove routing/delivery, trigger a **real** GitHub-App webhook (a PR on a `cogni-test-org` repo) — never sign with the webhook secret yourself. candidate-a only receives webhooks from `cogni-test-org` (via `cogni-operator-test` App).
- **Gotcha:** a node routes/collects only if it is `published`/`active` in the operator `nodes` table AND its `source_refs` repo delivers webhooks to that env. `test-cog` is NOT registered on candidate-a (404); `boop` (b6640e17) is + declares `source_refs: cogni-test-org/boop`.
- **Gotcha:** DH004 doc-header lint reads only the FIRST `Scope:` line — put the negative clause (`not`/`does not`) on that line. `biome check --write` does NOT format markdown; run prettier via the workspace root.
- **Anti-pattern flagged (file a bug):** `GH_WEBHOOK_SECRET` is deploy-infra-generated + force-pushed to the App every deploy ("re-breaks each run"); should be App-owned SSOT → OpenBao → ESO.

## Pointers

| File / Resource | Why it matters |
| --- | --- |
| `docs/design/attribution-operator-gateway.md` | Locked design + roadmap (primary briefing) |
| `packages/node-contracts/src/attribution.receipts.internal.v1.contract.ts` | Phase 1 wire seam (frozen contract) |
| `nodes/operator/app/src/app/api/internal/attribution/receipts/route.ts` | Node receiver (writes its own ledger) |
| `nodes/operator/app/src/features/ingestion/services/webhook-receiver.ts` | Operator sender: own→local, remote→HTTP deliver |
| `nodes/operator/app/src/adapters/server/ingestion/http-receipt-delivery.ts` + `.../ports/receipt-delivery.port.ts` | Delivery adapter (mirrors `run-http.ts`) + its port |
| `services/scheduler-worker/src/adapters/run-http.ts` | The dispatch-hop pattern to copy for R1 |
| `services/scheduler-worker/src/activities/{ledger,enrichment}.ts` | Collect steps to extract into `runCollectPass` (R1) |
| Knowledge inbox `contrib-derek-conductor-dereks-macbook-p-e82d9d72` | AI-facing design + human visual |
| PR #1946 · #1924 · #1916 (merged) · #1944 (closed, wrong model) | History |
