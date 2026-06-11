---
id: design.node-wizard-formation-wiring
type: design
title: "Graph-Execution Routing as a Per-Node Substrate (registry-driven, aligned with OpenFGA)"
status: draft
created: 2026-06-10
skills:
  - ../../.claude/skills/node-wizard-expert/SKILL.md
  - ../../.claude/skills/devops-expert/SKILL.md
spec_refs:
  - ../spec/node-baas-architecture.md
  - ../spec/node-formation.md
related:
  - ./openfga-substrate-unification.md
  - ../../work/handoffs/manual-edits-ledger.node-wizard-2026-06-10.md
---

# Graph-Execution Routing as a Per-Node Substrate

## Outcome

Success is when **a wizard-spawned node's Temporal worker routing is provisioned as
substrate, read from shared per-node membership data** — so `chat/completions` works
on candidate-a / preview / production with **zero hand-edits**, and the scheduler-worker
learns its node set the same way OpenFGA learns its `node:` objects.

## Framing (node-baas substrate, aligned with #1613)

[`node-baas-architecture.md`](../spec/node-baas-architecture.md) §BaaS Substrate Map:
**Graphs** = managed substrate — operator provides "execution host, **routing**,
observability." The scheduler-worker polling `scheduler-tasks-<node_id>` **is** that
routing. This is the peer of the **Authorization** row #1613 adds for OpenFGA.

The two designs must wire per-node-ness the **same way**. #1613's load-bearing shape:

> Shared substrate, owned by no node. **One env-shared store; per-node identity is
> `node:` objects (data) in that store** — never a per-node-provisioned server.

So the corrected Temporal design follows the same rule: **per-node membership is
DATA the shared worker reads — not a per-node infra reconcile of a configmap.**

## What was wrong, what's right

- ❌ **First drafts** (catalog `node_id` projection; then `reconcile-node-substrate.sh`
  mutating a provision-owned configmap) were both **per-node infra wiring** — exactly
  the bespoke-per-node pattern #1613 retires.
- ✅ **Right:** the scheduler-worker **discovers its node set from shared per-node
  membership data** (the node registry), exactly as OpenFGA reads `node:` objects
  from its shared store. Membership is data; the worker is a stateless reader.

Identity is untouched: `repo-spec.yaml` stays the `node_id`/on-chain SSOT, already
consumed for **billing attribution**; the membership record carries the resolved
`node_id` so the worker never reads across a submodule boundary. (Temporal keeps
per-node **queues** for failure isolation — task.0280 — vs OpenFGA's single graph;
that is a data-shape choice, not a wiring divergence.)

## The convergence — one per-node membership SSOT

Today "which nodes does X serve" is answered three disconnected ways:

| Plane | Source today | Should read |
| --- | --- | --- |
| Deploy (AppSets) | catalog `envs:` (#1607) | membership SSOT |
| Authz (OpenFGA) | `_shared` fan + `node:` objects (#1613) | membership SSOT |
| Graph routing (this) | `COGNI_NODE_ENDPOINTS` configmap | membership SSOT |

**Converge on one per-node membership SSOT: the node registry** (`nodes` table,
task.5083) as the **runtime projection** of the provisioned set — populated from
catalog `envs:` (which nodes per env) + repo-spec (`node_id`/URL) at
provision/registration. All three substrates then read the *same* truth. This is a
cross-cutting decision to settle once with dev2 (#1607) + fga-dev (#1613), not a
third bespoke list.

## Staged plan (demand-gated, like #1613)

- **Stage 1 — membership becomes data.** Scheduler-worker reads its node set from the
  membership SSOT (operator-owned API/projection over the `nodes` registry) at boot +
  on a refresh interval, replacing the catalog-rendered `COGNI_NODE_ENDPOINTS`. **Retire**
  `render-scheduler-worker-endpoints.sh` + the drift gate — the whole drift class goes.
  Keep the mint's skip (`github-repo-write.ts:1184`) — correct; routing isn't formation git.
- **Stage 2 — dynamic lifecycle (endgame).** Worker starts/stops a per-node worker as
  membership changes and scales concurrency by per-node queue depth. "Wired" =
  "registered." Demand-gated on >1 active node beyond operator (same trigger #1613 uses
  for its Argo move).

## Rejected

- **Catalog `node_id` projection / configmap reconcile (this design's own earlier
  drafts):** per-node infra wiring; diverges from #1613's "membership is data" rule.
- **Mint-time endpoint splice:** mint can't read submodule `node_id` at PR-gen and
  shouldn't — routing isn't formation git.
- **A third bespoke per-node list:** the explicit anti-goal; converge on the registry.

## Invariants (review criteria)

- [ ] REPO_SPEC_IS_IDENTITY_SSOT: unchanged; reconciler/registry *reads* `node_id`,
      never re-declares identity (spec: node-baas)
- [ ] MEMBERSHIP_IS_DATA: per-node membership is shared data the worker reads, not a
      per-node infra mutation — same shape as OpenFGA `node:` objects (#1613)
- [ ] ONE_MEMBERSHIP_SSOT: graph routing, authz, and deploy read one per-node
      membership source (the registry); no new bespoke list
- [ ] NO_SILENT_DROP: a node present in the membership SSOT but absent from the worker
      (or vice-versa) fails loud
- [ ] BORN_GREEN: a flighted spawn reaches `chat/completions` with zero hand-edits
- [ ] SIMPLE_SOLUTION: net-deletes the catalog-render + drift-gate; reuses the registry

## Files (Stage 1)

- Modify: `services/scheduler-worker/*` — read node set from the membership SSOT (API/projection) at boot + refresh; drop the configmap dependency
- Add: operator membership projection/endpoint over the `nodes` registry (slug, node_id, internal URL) — the shared source the worker + OpenFGA read
- Remove: `scripts/ci/render-scheduler-worker-endpoints.sh` drift gate + catalog-rendered `COGNI_NODE_ENDPOINTS` base configmap
- Keep: `github-repo-write.ts:1184` skip
- Test: registry has node X → worker polls `scheduler-tasks-<node_id>`; registry empty → worker idles; no git/catalog edit anywhere in the path

## E2E validation signal

Re-flight oss with **no manual scheduler edit** → the registry carries oss (from its
provisioned membership) → the worker polls oss's queue → `chat/completions` returns a
completion. Cross-check: OpenFGA's `node:oss` object resolves from the same membership.
Repeat on preview (born-correct #1584).
