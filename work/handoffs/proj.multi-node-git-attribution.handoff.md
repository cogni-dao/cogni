---
id: proj.multi-node-git-attribution
type: handoff
work_item_id: proj.multi-node-git-attribution
status: active
created: 2026-06-30
updated: 2026-06-30
branch: derekg1729/attribution-main-merge-selection
last_commit: 2da62c87fb
---

# Handoff: Multi-node git-epoch attribution via the operator GitHub-App passthrough

## Mission

New mission: git-epoch attribution now works **end-to-end for the operator node** (PR #1892 — merged PRs become contributors-by-GitHub-identity, visible via the agent API). It works ONLY for the operator because the operator owns the org-wide GitHub App that receives webhooks. You own making it work for **every node** (blue, habitat, oss, external forks, anything spawned from `node-template`) **without building a GitHub App per node**. The operator app becomes a **standardized multi-tenant passthrough / git-attribution gateway**: nodes _consume_ it — they declare which repo(s) to attribute, grant the operator App access, and read their results — they do not run their own ingestion or App. This is the "operator-as-git-gateway, git = source 1 of N, per-node ledgers" north star. Design it into `node-template` so a fork gets attribution for free.

## Goal

- End state: a PR merged to a **non-operator** node's repo produces a contributor in **that node's** epoch (`node_id != operator`), readable via the operator's node-addressable attribution API — with **no per-node GitHub App, no per-node webhook URL, no per-node webhook secret**.
- A `node-template` fork that (a) is in the operator `nodes` registry and (b) declares `activity_ledger.source_refs: ["<its-repo>"]` gets working git attribution automatically once the operator App is installed on its repo (org-wide install covers forks).
- The standardized github policy (`cogni-v0.0` main-merge-selection — call it **git-epoch attribution policy v0.0.1**) is inherited by all nodes; the `attribution-pipeline-plugins` framework is the seam for nodes to publish their _own_ selection policies / enrichers for OTHER platforms (the "100 platforms" — git is just source 1 of N).
- **E2E validation:** register a second node whose repo receives real webhooks (on candidate-a: `cogni-test-org/test-cog` as its OWN node, not operator), merge a PR to it, and prove its receipts get `node_id = that node` (NOT operator), its epoch lists the contributor, and `GET /api/v1/attribution/.../contributors` for that node returns it. Today the same merge lands in the **operator's** ledger — that is the bug to fix. Candidate-a flight proof = `/version` SHA match + Loki `component=ledger` showing the receipt scoped to the non-operator `node_id`.

## Start By Reading

- **Foundation (what shipped):** PR #1892 + `work/handoffs/task.5066.handoff.md` (operator attribution e2e). Commits on this branch implement WS1–WS6 (idempotent `included`, show-by-identity, agent read API, `source_refs` fail-open filter, docs).
- **The single-tenant ingestion bug (core gap):** `nodes/operator/app/src/app/api/internal/webhooks/[source]/route.ts` (passes `nodeId: getNodeId()` — hardcoded operator) → `nodes/operator/app/src/features/ingestion/services/webhook-receiver.ts` (`insertIngestionReceipts` tags every receipt with that one `nodeId`). The normalizer already extracts the repo: `nodes/operator/app/src/adapters/server/ingestion/github-webhook.ts` `repoFullName()`.
- **The repo→node mapping that exists but is unused:** `packages/db-schema/src/attribution.ts` `nodes` table (`repoOwner`, `repoName`); `nodes/operator/app/src/adapters/server/node-registry/db-node-registry.adapter.ts`.
- **Already-per-node plumbing (do NOT rebuild):** `epochs`/`epoch_selection`/`ingestion_receipts` are `node_id`-scoped; `packages/scheduler-core/src/services/syncGovernanceSchedules.ts` takes `nodeId`; read routes use `getNodeId()`/`getScopeId()` — `nodes/operator/app/src/app/api/v1/attribution/epochs/[id]/contributors/route.ts`.
- **Per-node config:** `nodes/operator/app/src/shared/config/repoSpec.server.ts` (`getGovernanceConfig` reads the OPERATOR's repo-spec only) and the scaffold `nodes/operator/app/src/shared/node-app-scaffold/gens/repo-spec.ts` (emits `activity_ledger` + `source_refs` + `cogni-v0.0` for new nodes).
- **Specs:** `docs/spec/attribution-pipeline-overview.md` (now documents the gateway + `source_refs` allowlist + read surface + vNext roadmap), `docs/spec/plugin-attribution-pipeline.md`, `docs/spec/attribution-ledger.md`. Memory: `project_epoch_attribution_k3s_config_gap` (operator-as-git-gateway, per-node ledgers).

## Current State

- **Operator attribution: SHIPPED & validated on candidate-a** (PR #1892, `2da62c87`). `included` flips by policy idempotently; selected receipts show by GitHub identity (no linked account); `source_refs` is a selection-time fail-open allowlist; `GET .../epochs/[id]/contributors` (bearer or session) returns contributors-by-identity. Proof: candidate-a epoch 5, `source_refs=cogni-test-org/test-cog` → `included=3`, 2 identity contributors (`derekg1729` 2000pts, `flock-leader` 1000pts), `isLinked:false`. repo-spec now points prod at `cogni-dao/cogni`; PR is at the merge→prod-promote checkpoint.
- **Everything is `node_id`-scoped EXCEPT webhook ingestion**, which hardcodes the operator `node_id`. So a fork's merged-PR receipts land in the operator's ledger, not the fork's. That is the multi-node blocker.
- The operator GitHub App is **org-wide** (one App, one webhook URL, one secret). Per-node Apps are not viable (one webhook URL each; forks can't own org settings). The passthrough is the only path.
- Attribution data (receipts/epochs/`nodes`) lives in the **operator-owned Postgres**, multi-tenant by `node_id` — confirm this is the shared store the design assumes (NOT per-node DBs) before building.

## Design / Implementation Target

1. **Multi-tenant ingestion routing (the unblock, ~20 lines):** at webhook receipt, resolve `repository.full_name` → `nodes` table (`findNodeByRepo(owner, name)` on the registry adapter) → scope the receipt to that node's `node_id`/`scope_id`. Fallback to operator when no match. `webhook-receiver.ts` takes a resolved `targetNodeId` instead of the route's hardcoded `getNodeId()`.
2. **Source authority / anti-theft:** a receipt is attributed to node N only if N's `nodes`-table repo mapping AND N's declared `activity_ledger.source_refs` agree on the repo. A node must not be able to claim another node's repo. `source_refs` is already the selection-time allowlist; here it also becomes the routing authority.
3. **Per-node config + epoch execution:** the operator must resolve EACH registered node's `activity_ledger` (epoch length, source_refs, attribution_pipeline, approvers) — not just its own — and run that node's epochs + schedules. **Decision to make:** operator-orchestrated (operator runs sync/collect for all registered nodes — best fits "nodes consume the passthrough") vs node-self (each deployed node app self-syncs). Recommend operator-orchestrated for v0.
4. **Node-addressable read API:** `/epochs`, `/activity`, `/contributors` must serve ANY node's epochs by node identifier (param or `/api/v1/nodes/{nodeId}/attribution/...`), so a node reads its own results from the operator. Today they are operator-self-scoped.
5. **Policy framework is the extensibility seam (git is source 1 of N):** `cogni-v0.0` main-merge github = the inherited default ("v0.0.1"). Keep `attribution-pipeline-plugins` the place nodes publish custom profiles/selection-policies/enrichers for non-git platforms. Operator ships the github passthrough; nodes BYO policy. Do NOT hardcode github assumptions outside the plugins package.
6. **node-template:** ship `activity_ledger` + `source_refs: [own-repo]` + `cogni-v0.0` so a fork attributes automatically once registered + App-installed. **Must NOT** add a GitHub App, webhook URL, or webhook secret to the fork.

**Boundaries / must-not-regress:** operator's own attribution stays green; one org-wide App only; shipped operator e2e (idempotent `included`, identity contributors, `source_refs` filter, `/contributors`) unchanged; receipts append-only (route at ingestion-scope, don't drop/rewrite).

## Next Actions / Risks

- [ ] Confirm the attribution store is operator-owned + multi-tenant by `node_id` (shared Postgres), not per-node DBs — the whole design assumes this.
- [ ] Implement Req 1 (ingestion routing) + `findNodeByRepo`; prove a non-operator repo's receipt gets that node's `node_id` on candidate-a.
- [ ] Decide Req 3 (operator-orchestrated vs node-self); then per-node epochs/schedules.
- [ ] Req 4 node-addressable read API; Req 2 source authority check; Req 6 node-template defaults + a short opt-in doc.
- [ ] File the work items yourself (no preemptive decomposition was done — Derek dislikes work-item churn; capture as you go).
- Risk: `source_refs` match is exact-string; use GitHub's canonical `nameWithOwner` casing (verified lowercase for `cogni-dao/cogni`).
- Risk: external (non-org) node repos need an org-admin to add them to the operator App install; org-wide install auto-covers forks.
- Gotcha: scheduler-worker already runs per-node (per-node task queues / `COGNI_NODE_ENDPOINTS`); the gap is ingestion + per-node config resolution, not the worker runtime.
- Gotcha: promotion does NOT re-promote the scheduler-worker (memory `project_scheduler_worker_routing_stale`); any worker code change needs a pr_number flight (candidate-a) + explicit worker promote (prod).

## Pointers

| File / Resource                                                                                 | Why it matters                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `api/internal/webhooks/[source]/route.ts` + `features/ingestion/services/webhook-receiver.ts`   | The hardcoded-operator `nodeId` — the core change (Req 1)        |
| `adapters/server/ingestion/github-webhook.ts` `repoFullName()`                                  | Repo already extracted from payload; routing key                 |
| `packages/db-schema/src/attribution.ts` (`nodes`) + `node-registry/db-node-registry.adapter.ts` | repo→node mapping data + where `findNodeByRepo` belongs          |
| `packages/scheduler-core/src/services/syncGovernanceSchedules.ts`                               | Per-node schedule sync (already `nodeId`-parameterized)          |
| `shared/config/repoSpec.server.ts` (`getGovernanceConfig`)                                      | Reads operator's spec only — must become per-node (Req 3)        |
| `attribution/epochs/[id]/contributors/route.ts`                                                 | Read surface to make node-addressable (Req 4)                    |
| `node-app-scaffold/gens/repo-spec.ts`                                                           | node-template attribution defaults (Req 6)                       |
| `packages/attribution-pipeline-plugins/`                                                        | The policy/enricher framework — the "100 platforms" seam (Req 5) |
| `docs/spec/attribution-pipeline-overview.md`                                                    | Gateway + read-surface + vNext roadmap (updated this PR)         |
