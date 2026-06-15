---
id: design.node-wizard-formation-wiring
type: design
title: "Born-green Temporal routing — node_id projection + is_built_by_this_repo lift"
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

# Born-green Temporal Routing

## Outcome

A wizard-spawned **submodule** node is born with its scheduler-worker Temporal
routing — so `chat/completions` works on candidate-a / preview / production with
**zero hand-edits**. (Graph routing is the node-baas **Graphs** substrate, peer of
OpenFGA's **Authorization** row, #1613.)

## Root cause (the load-bearing correction)

`is_built_by_this_repo` — a **build-target** filter — was wrongly gating the
**routing** CSVs (`node_internal_service_endpoint_csv` + `node_billing_endpoint_csv`,
`image-tags.sh`). It `continue`d past every submodule node, so the scheduler-worker
never learned their `scheduler-tasks-<node_id>` queues (chat hangs) **and** billing
lost their attribution endpoint. The drift gate stayed green because the rendered
CSV and the configmap both excluded them. Proven on candidate-a: oss returned a
haiku only after the endpoint was hand-added (ledger row 12).

## Approach (as-built)

1. **Lift `is_built_by_this_repo` from the routing CSVs** — they now enumerate
   **every** catalog `type:node`. The filter stays in build-target selection, where
   "what does THIS repo build" belongs.
2. **node_id projection onto submodule rows only.** A submodule node's `node_id`
   lives in its minted repo-spec, unreadable from the parent at render time. So the
   catalog carries a `node_id` PROJECTION on submodule rows (`source_repo` set);
   in-repo rows keep reading the repo-spec (schema **forbids** `node_id` there).
   `image-tags.sh` resolves submodule `node_id` from the catalog, in-repo from the
   repo-spec. `REPO_SPEC_IS_IDENTITY_SSOT` holds — repo-spec is the authority; the
   catalog field is a verified mirror, also consumed for **billing**.
3. **Hard CI drift gate** (`render-scheduler-worker-endpoints.sh --check`):
   initialises each submodule and asserts `catalog.node_id == repo-spec.node_id`
   (repo-spec wins on mismatch) — the projection can never silently fork the identity.
4. **The mint self-projects + self-splices.** `gens/catalog.ts` emits `node_id` for
   the minted submodule node; `github-repo-write.ts` splices the endpoint into the
   base configmap via `insertSchedulerEndpoint` (the `:1184` "until the projection
   lands" skip is now resolved). Every future spawn's formation PR is drift-clean +
   born-green.

## Alignment with #1613 / #1607

- **Graphs substrate** (this) is the peer of **Authorization** (#1613): both shared,
  operator-provisioned, owned-by-no-node; identity stays in repo-spec/SSOT and
  per-node membership is read as data.
- **#1607** added the catalog `envs:` per-node field; this adds `node_id` — same
  catalog-as-per-node-metadata direction. Temporal keeps per-node **queues** for
  failure isolation (task.0280), unlike OpenFGA's single graph — a data-shape
  choice, not a wiring divergence.

## Endgame (deferred, demand-gated like #1613)

Converge all three per-node-membership readers (deploy `envs:`, authz `node:`
objects, graph routing) onto **one membership SSOT** — the node registry (`nodes`
table, task.5083) as the runtime projection — and have the scheduler-worker
**dynamically discover + scale** per-node workers from it. The projection above is
the static, git-time increment that makes spawns born-green today without the
runtime-registry dependency.

## Invariants (review criteria)

- [ ] REPO_SPEC_IS_IDENTITY_SSOT: identity stays in repo-spec; catalog `node_id` is a
      drift-gated projection on submodule rows only (verify-scheduler-endpoints)
- [ ] ROUTING_NOT_BUILD: `is_built_by_this_repo` gates build selection only, never
      routing/billing CSVs
- [ ] NO_SILENT_DROP: a `type:node` with unresolvable `node_id` fails the CSV + gate
- [ ] BORN_GREEN: a flighted spawn reaches `chat/completions` with zero hand-edits
- [ ] SIMPLE_SOLUTION: reuses the existing generator + drift-gate; one catalog field

## Files (implemented)

- `scripts/ci/lib/image-tags.sh` — lift `is_built_by_this_repo` from both routing CSVs; resolve submodule `node_id` from the catalog projection
- `scripts/ci/render-scheduler-worker-endpoints.sh` — `verify_projection` hard gate (catalog == repo-spec)
- `infra/catalog/_schema.json` — `node_id` allowed on submodule rows (source_repo), forbidden on in-repo
- `infra/catalog/{ayo,coulditbe,creative,node-template,oss,pandora,please}.yaml` — backfill `node_id`
- `infra/k8s/base/scheduler-worker/configmap.yaml` — regenerated (all 10 nodes)
- `nodes/operator/app/src/shared/node-app-scaffold/gens/catalog.ts` — emit `node_id`
- `nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts` — thread `nodeId` + splice endpoint (resolve the `:1184` skip)

## E2E validation signal

Re-flight oss with **no manual scheduler edit** → catalog projection feeds the
configmap → worker polls oss's queue → `chat/completions` returns a completion.
