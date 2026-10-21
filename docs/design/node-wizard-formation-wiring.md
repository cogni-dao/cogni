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
  - node-baas-substrate-model
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

---

# Owner binding — node registry ownership from repo-spec approvers (registry RLS)

> Added 2026-08-05 after `pm.prod-reprovision-nodes-registry-reseed.2026-08-05`. Same
> `REPO_SPEC_IS_IDENTITY_SSOT` direction as above, applied to **ownership** instead of routing.

## Problem

A fresh env reprovision brings up an **empty operator `nodes` registry** (node rows are
app-written state, not migration state). Node ownership is `nodes.owner_user_id` enforced by the
`tenant_isolation` RLS policy, so the owner wallet ends up owning **zero** nodes and the operator UI/API
can't see or manage any of them — even though the repos, catalog, overlays, and pods all exist. This
recurs on **every** reprovision until ownership is _derived_, not hand-seeded.

## The load-bearing identity principle (why this is env-agnostic)

`wallet_address` is a **stable, env-independent binding** ([identity keys](https://cognidao.org/knowledge/identity-keys-no-overload): bindings are
auth-method-agnostic). `user_id` is an **env-local surrogate** — SIWE mints a fresh UUID per env on
first login. **Ownership MUST resolve _through_ the wallet, never a hardcoded per-env `user_id`.** Do
that and one seed/binding is correct on candidate-a, preview, and production simultaneously — SIWE
reuses the wallet's row on the owner's next login, so `session.id == owner_user_id` falls out for free.
This is why registry seeding is **not** per-env; a "different migration per env" is the anti-pattern.

## Tactical (do-now): one env-agnostic seed migration

Mirror `nodes/operator/app/src/adapters/server/db/migrations/0037_seed_first_class_nodes.sql`:

1. `INSERT INTO users (id, wallet_address) … ON CONFLICT (wallet_address) DO NOTHING` — ensures the
   owner exists even on an env where the wallet has never logged in (0037 silently no-ops there).
2. `INSERT INTO nodes (…) SELECT …, u.id, 'active' FROM users u WHERE lower(u.wallet_address)=lower('<approver wallet>') ON CONFLICT (slug) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id`
   — non-destructive (no `node_access_requests` cascade), idempotent, re-run safe.

- `nodes.id` MUST be the canonical `node_id` (repo-spec / catalog projection — `REPO_SPEC_IS_IDENTITY_SSOT`).
  Exclude stale forks that reuse another node's id (e.g. `standalone-node`/`cogni-poly` reusing operator's
  `4ff8eac1…`) → PK collision.
- Runs as the operator `migrate` initContainer → seeds all three envs + self-heals on every future reprovision.
- Operational how-to + the RLS-read gotcha: `.claude/skills/database-expert` § "Reseeding the operator `nodes` registry".

## Ideal (#2 — the endgame, and the right design): bind ownership from repo-spec approvers at formation

The migration is a stopgap. The **correct** design derives ownership from a DAO **governance-owner**
SSoT in repo-spec: identity lives in repo-spec, ownership is _read from it_, never authored in a
migration or hand-seeded — the ownership peer of the `node_id` projection above.

> ⚠️ **TERM RECONCILIATION REQUIRED AT IMPLEMENTATION — do not skip.** There is **no distinct
> governance-owner / node-admin field in repo-spec today.** The only wallet in the spec is
> `activity_ledger.approvers[0]` (line 22-23; today `0x070075…c949`, `derekg1729.eth`) — but that is a
> **ledger-attribution term** (who approves epochs / attribution — the money plane), **NOT** a
> governance-ownership term. Governance ownership and ledger approval are two deliberately-separate
> planes; **the implementer MUST NOT overload `activity_ledger.approvers` as the ownership source**
> just because the wallet happens to match in MVP. Reconcile the term before wiring #2 — pick one and
> record the decision right here:
>
> 1. **Add a distinct field** (e.g. repo-spec `governance.owners` / `admin`) and bind `owner_user_id`
>    from _that_. Cleanest; keeps the two planes un-overloaded.
> 2. **Consciously reuse** `activity_ledger.approvers` with a stated "same wallet in MVP" rationale
>    **and** a repo-spec alias so the ownership meaning is explicit, not silently inferred.
>
> The wallet _value_ is unambiguous today (one wallet in the spec), so the tactical migration below is
> **unblocked**; but #2's formation-binding is **blocked on this reconciliation.**

- **Node-wizard formation** (`gens/*` + `github-repo-write.ts`, the `POST /api/v1/nodes` + publish path)
  binds `nodes.owner_user_id` at creation by resolving the repo-spec **governance-owner wallet** (the
  reconciled field — see ⚠️ callout) → the env-local `users.id` (get-or-create by wallet).
  Self-projecting, exactly like `node_id`.
- **Registry recovery** stops needing a migration at all: a reprovision replays formation-time ownership
  from repo-spec. The migration path stays only as a break-glass backfill for pre-existing nodes.
- **Multi-owner:** the reconciled governance-owner field is a list → future multi-owner is a fan-out over
  the list, not a schema change.

### Also required for #2: the operator **nodes page** RLS read

The nodes page loads via the `tenant_isolation` RLS policy (`owner_user_id = current_setting('app.current_user_id')`),
so it only ever returns rows the session's wallet owns. Two things to verify/fix when wiring #2:

- **Correctness:** the page must run inside a tenant scope (`SET LOCAL app.current_user_id = <session user_id>`);
  a query without it returns **0 rows** (silent — looks like an empty account, not an error). This is the
  same trap that made the fresh prod DB _look_ empty during the incident.
- **Performance:** the per-request RLS-scoped registry query should be **cached / optimized** (owner→nodes
  is small and changes rarely) — don't re-scan under RLS on every page load. A short-TTL per-session cache
  or a covering index on `nodes(owner_user_id)` (already present as `nodes_owner_user_id_idx`) is enough.

## Invariants (review criteria)

- [ ] OWNER_RESOLVED_BY_BINDING: `owner_user_id` is resolved from the repo-spec approver **wallet**, never a
      hardcoded env-local `user_id`. One migration/binding is correct on all envs.
- [ ] OWNER_FROM_REPO_SPEC (ideal): formation reads the **reconciled governance-owner field** from
      repo-spec — ownership is derived from the governance SSoT, not authored (peer of
      `REPO_SPEC_IS_IDENTITY_SSOT`). **Blocked on the ⚠️ term-reconciliation above:** must NOT overload
      `activity_ledger.approvers` (ledger/money plane) as the ownership source.
- [ ] CANONICAL_NODE_ID: `nodes.id` == repo-spec/catalog `node_id`; stale-fork id collisions excluded.
- [ ] RLS_SCOPED_READ: the nodes page reads inside `SET LOCAL app.current_user_id`; unscoped reads (0 rows)
      are treated as a bug, not an empty account. Cache/optimize the scoped query.

## Files (to touch when executing #2)

- `.cogni/repo-spec.yaml` schema + `node-formation` mint — **FIRST: resolve the ⚠️ term reconciliation** (add a distinct governance-owner/`admin` field, or alias `activity_ledger.approvers`); everything below reads that reconciled field, never `activity_ledger.approvers` verbatim
- `nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts` + `gens/` — bind `owner_user_id` from the reconciled governance-owner field at formation
- `nodes/operator/app/src/app/api/v1/nodes/route.ts` — owner resolution get-or-create by wallet
- the operator nodes page + its data loader — RLS scope correctness + caching/optimization
- `nodes/operator/app/src/adapters/server/db/migrations/00XX_seed_registry_nodes.sql` — the stopgap backfill (mirror 0037)
