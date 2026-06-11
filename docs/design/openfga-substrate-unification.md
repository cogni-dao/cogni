---
id: design.openfga-substrate-unification
type: design
title: OpenFGA as a First-Class Substrate Consumer
status: draft
trust: draft
summary: Retire OpenFGA's bespoke deploy-infra substrate path — give it a dedicated Postgres role on the OpenBao SSOT (same Invariant-15 read-path nodes + litellm use), relocate the store/model bootstrap into a self-owned idempotent Job, and (demand-gated) move the runtime onto Argo.
owner: derekg1729
created: 2026-06-10
updated: 2026-06-10
tags: [authorization, openfga, substrate, secrets, ci-cd, rbac]
---

# OpenFGA as a First-Class Substrate Consumer

## Design

OpenFGA today provisions itself through a **bespoke path bolted onto `deploy-infra.sh`**: it authenticates to Postgres as the **root superuser**, its store/model bootstrap is a hand-rolled `deploy-infra` Step-6.6a gate, and it runs as a **Compose service fronted by a k8s `ExternalName`**. That split-brain is why the prod `503 authz_unavailable` surfaced — but the 503 is a _symptom_. The root cause is the shared-Postgres root-credential drift (Gotcha 12 / bug.5002), which wedges `db-provision` for **every** consumer (nodes, litellm, AND openfga) before Step-6.6a is ever reached. That reconcile is owned by the substrate lane (Invariant-15 / `task.5052`); this design does **not** add an OpenFGA-specific workaround.

North Star: **one substrate lane reconciles all DB consumers, and no service owns a bespoke bootstrap.** OpenFGA becomes a first-class consumer of the exact tooling and SSOT the nodes use.

OpenFGA is **shared substrate** — peer of postgres / litellm / redis. Provisioned by the operator plane, consumed by any node, **owned by no node**. **OpenFGA _and litellm_ are the consumers still on root creds** (`provision.sh:306/317`, `compose:293/312`); both are in Invariant-15 scope. OpenFGA is the one with stateful authz data on top, so it carries the bootstrap split-brain too.

**Temporal is the third shared-infra DB consumer — unified here (2026-06-11, this PR).** Unlike OpenFGA/litellm it already ran on a dedicated `temporal` role (not root), so its gap was narrower but bit harder: the role was **unmanaged by `provision.sh`** and its password was **GH-env-sourced**, not OpenBao. A failed prod `deploy-infra` (2026-06-11 05:27) restarted Temporal against a GH-env value the never-reconciled role had drifted from → `pq: password authentication failed for user "temporal"` → Temporal never binds `:7233` → every node app's readiness hard-gate fails → **prod 502 for ~6h**. The fix is the exact Move-1 pattern: `provision_app_role temporal` (the password-reconcile branch) in the `INFRA_ONLY` pass + `TEMPORAL_DB_PASSWORD` sourced from OpenBao `cogni/<env>/_shared` (shared-infra, owned by no node) via the `<env>-db-reader` seam — dropping the GH-env tier-B entry. Temporal stays a Compose service with no Move-2/3 analogue: its schema is auto-setup-owned, so there's no bootstrap split-brain to relocate.

### Current split-brain (verified as-built)

| Dimension                | Node-substrate pattern (target)                                       | OpenFGA today                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DB auth**              | Dedicated role, password OpenBao-owned, set-once                      | **Root superuser** in the datastore DSN (`compose:293/312`)                                                                                                    |
| **Cred SSOT → runtime**  | OpenBao `cogni/<env>/<svc>` → set-once reader → `.env` (Invariant-15) | `POSTGRES_ROOT_PASSWORD` from rendered `.env`                                                                                                                  |
| **DB role provisioning** | `db-provision` set-once, catalog-driven                               | DB created root-owned; **no role** (`provision.sh:317`)                                                                                                        |
| **Bootstrap**            | n/a / k8s Job                                                         | **`deploy-infra` Step-6.6a** → `bootstrap-openfga.sh` + `patch_operator_openfga_config` + `refresh_operator_openfga_secret` (`deploy-infra.sh:1106/1129/1164`) |
| **Runtime**              | k8s Deployment + Service, Argo                                        | **Compose service** + k8s `ExternalName` (`openfga-external/service.yaml`; `catalog/openfga.yaml type: infra`)                                                 |

### Target architecture (the three North-Star moves)

1. **Dedicated DB role on the OpenBao SSOT — net-new plumbing in the infra-DB pass.**
   - OpenFGA gets a dedicated `openfga` Postgres role, created **set-once** (never `ALTER … PASSWORD` from `.env` — Invariant 15). **This is not a free ride on `task.5052`:** the set-once, OpenBao-sourced `provision_app_role` pattern (`provision.sh:152`) exists today **only in the per-node pass**; the infra-DB pass (`PROVISION_INFRA_ONLY=1`, `provision.sh:30`) creates litellm/openfga DBs **root-owned with no role** (`:306`/`:317`). `task.5052` threads the **superuser** password from OpenBao — it does not create infra-DB roles. So Move 1 **extends the `INFRA_ONLY` branch with the per-role OpenBao pattern**: seed `OPENFGA_DB_PASSWORD` → thread it into the infra-pass env → `provision_app_role openfga "$OPENFGA_DB_PASSWORD"` → flip the Compose DSN. litellm is the symmetric twin — define the infra-DB-role shape once, not openfga-bespoke.
   - **In A/B OpenFGA stays a Compose service, so the DSN travels OpenBao → `deploy-infra` set-once reader → runtime `.env`** (`secrets-management.md:233`) — **not** ESO (ESO reaches k8s pods only; that is C). **Root creds leave the datastore DSN.**
   - `OPENFGA_DB_PASSWORD` is **OpenBao-custodied** (it provisions a role + backs a DSN — `secrets-add-new.md` Authority Gate), set self-serve as a **normal per-service secret**: `pnpm secrets:set <env> openfga OPENFGA_DB_PASSWORD` → `cogni/<env>/openfga/OPENFGA_DB_PASSWORD`. It is **not** a static `infra/secrets-catalog.yaml` entry — the operator-catalog loader allowlist is node-domain (`secrets-catalog-loader.ts:271`) and openfga is infra, not a node; forcing a tier (A1 fans to pods, B routes to GH-env) mis-classifies a Compose-only OpenBao cred. Custody split (no bespoke): the **setter** (`deploy-infra`) reads OpenBao via the env-wide `${env}-db-reader` seam and renders the value into the Compose `.env`; the **openfga service** reads it from `.env` like any normal secret — it never reads OpenBao or `_shared` directly. (Auto-generation on fresh provision — teaching the catalog loader about `type: infra` services — is a follow-up, not Phase A.)

2. **Self-owned, idempotent store/model bootstrap — _relocated_, and published to the fan-out seam.**
   - `bootstrap-openfga.sh` is already idempotent (finds-or-creates store `cogni-<env>-rbac`; reuses the authz model by canonical-JSON hash). Its _logic_ stays; its _invocation site_ moves into a k8s **Job** keyed to the OpenFGA + model version.
   - **B deletes the deploy-infra _gating_ and _relocates_ the publish — it does not eliminate it.** The Job still writes `STORE_ID`/`MODEL_ID` to OpenBao + triggers ESO delivery (`patch_operator_openfga_config` + `refresh_operator_openfga_secret` logic, moved _into_ the Job). What dies is Step-6.6a's coupling: a deploy-infra run no longer gates on OpenFGA, and a store refresh no longer needs a full infra deploy.
   - **Publish to the shared seam, not the operator path.** The consumed config (`OPENFGA_API_URL`/`STORE_ID`/`MODEL_ID`) is the artifact that becomes all-nodes substrate. Today it's published to the **operator-specific** path; the Job must instead write it to the **`_shared`/baseline-fan seam** (`cogni/<env>/_shared`, already delivered to every `type:node` by `seed_node_app_secrets`; or `NODE_BASELINE_KEYS` with `shared: true` — `reconcile-secrets.sh:41,205`). Then the v0→all-nodes flip is a one-line consumer opt-in, not a Job rewrite. _(These are non-secret identifiers; they ride OpenBao/ESO only because they're bootstrap-resolved. `_shared` is the right vehicle today; a ConfigMap is the purer home if ever decoupled.)_
   - _Open:_ how the Job obtains `infra/openfga/rbac-model.json` (today scp'd to `/tmp`, `deploy-infra.sh:1886`) — ConfigMap or baked image.

3. **Runtime to Argo — _demand-gated_, off the critical path.**
   - C would move OpenFGA from Compose to a **k8s Deployment + in-cluster Service** (retiring `ExternalName` + the VM port exposure), per-`(env)` Argo AppSet. **Only here** does the catalog type leave `infra` and an `assert-target-substrate.sh` `type=service` contract get defined — a **C-only** question.
   - C's upside is **lane-uniformity / retiring `ExternalName`**, not statefulness: durable state stays in shared Postgres (Non-Goal #4), so the _workload_ is stateless and rolls fine in Compose — the same litellm case the devops-expert skill codifies as "runtime stays Compose, move explicitly deferred." At MVP altitude (`feedback_mvp_stage_first`), **C is demand-gated.** Trigger: the **first node app beyond operator** wired to OpenFGA — at that point an `ExternalName`/Compose outage takes down authz for every node, so the SPOF goes N× and C earns its way in.
   - **A + B clear the 503, the bug.5002 class, and the split-brain. C earns its way in later.**

### Current state vs roadmap (why Move 2 publishes to the shared seam)

OpenFGA is **v0 operator-only today, on a hard trajectory to all-node consumption.** The server is shared; only the consumer set grows.

| Artifact                                                  | Current (v0)                                                                   | Roadmap (all-nodes)                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| OpenFGA server (DB, store, runtime)                       | one shared Compose instance / env; one `cogni-<env>-rbac` store                | **same** — one shared instance, one env store (litellm-shape)  |
| Consumer of the authz API                                 | **operator app only** — only `container.ts:843` builds the `AuthorizationPort` | **every node app** builds an `AuthorizationPort` and checks    |
| `OPENFGA_DB_PASSWORD`                                     | shared-infra cred; server→shared-PG                                            | **same** — one shared cred; nodes hit the API, never the DB    |
| `OPENFGA_API_URL`/`STORE_ID`/`MODEL_ID` (consumed config) | published to operator path only; **not** in `NODE_BASELINE_KEYS`               | **fanned to every node app** via the `_shared` / baseline seam |

So **the only change the roadmap demands of A/B is Move 2's publish target** (shared seam, not operator path). Do **not** wire node apps' `AuthorizationPort` now — that's the roadmap's job, gated on the published config being fan-ready, which Move 2 guarantees.

### Migration — phased, each a task under [`proj.rbac-hardening`](../../work/projects/proj.rbac-hardening.md), one PR each

| Phase                             | Change                                                                                                                                                                                                                                                                                                                                                                                                      | Status / gating                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Invariant-15 reconcile**    | The DB-cred SSOT reconcile (`secrets-management.md` Phase 2 / `task.5052`): `deploy-infra`/`db-provision` source DB passwords from OpenBao, killing root-cred drift for **all** consumers. Stopgap in flight (2026-06-10): a prod operator promote (`skip_infra=false`) drives `bootstrap-openfga` on the bespoke path to create prod's empty `OPENFGA_STORE_ID` + flip operator `app_user → app_operator`. | **Substrate lane.** fga-dev verifies (a) prod store bootstrapped, (b) #1604's approve-flow clears its 503 on cognidao.org. If deploy-infra `28P01`s before reaching bootstrap, driving it home _is_ this. |
| **A — dedicated OpenFGA DB role** | Extend the `INFRA_ONLY` pass with `provision_app_role openfga` (set-once) + `OPENFGA_DB_PASSWORD` in `infra/secrets-catalog.yaml`; DSN → `openfga:<pw>` (drop root) on openfga + openfga-migrate; password rides the Invariant-15 `.env` reader. **Pull `db-backup` parity in here** — the authz data is in shared Postgres today; the gap is live now. Catalog stays `type: infra`.                        | **Net-new plumbing** (not a task.5052 ride). **Confirm the post-split lane owner with dev2** (#1607) before editing `provision.sh`; lands as **one reviewed PR with code** after prod is green.           |
| **B — relocate the bootstrap**    | Move store/model bootstrap into a self-owned idempotent **Job**; delete Step-6.6a's _gating_; relocate the publish into the Job, **targeting the `_shared` fan seam** (not the operator path).                                                                                                                                                                                                              | After A.                                                                                                                                                                                                  |
| **C — runtime to Argo**           | Deployment + Service + AppSet; retire Compose service + `ExternalName`; catalog `type: service` + `assert-target-substrate` contract.                                                                                                                                                                                                                                                                       | **Demand-gated** on the first non-operator consumer.                                                                                                                                                      |

### Invariants that must hold

- **OpenBao is the sole source** of the OpenFGA DB role password; in A/B `deploy-infra` is a set-once **`.env`-reader** of it (ESO only at C). `db-provision` creates the role once and never `ALTER … PASSWORD` from `.env` (the bug.5002 anti-fix).
- **Shared substrate, owned by no node.** The DB cred is a single shared credential in the infra catalog; the consumed config publishes to the **`_shared` fan**, never an operator-specific path. v0 consumption is operator-only by circumstance, not by design.
- **Authz models are immutable**, reused by canonical-hash; a new model is written only on content change.
- **One env-shared store, permanently.** A single `cogni-<env>-rbac` store serves all nodes — the model already carries per-node `node:` objects + `developer` relations, so every node app checks the same graph. Per-node stores would shatter the authz graph and are a non-goal.
- **Deny-by-default + fail-closed**: a missing/unconfigured store yields `authz_unavailable`, never allow.
- **No bespoke per-service bootstrap**: bootstrap is a declared, idempotent step (a Job in B), not inline deploy-infra logic.
- **Fail loud on source-read failure**: if the bootstrap or DB-role read can't reach OpenBao, fail — never fall back to a divergent `.env` value.
- **Store + tuple continuity (the #1604 contract)**: the migration must never reset the `cogni-<env>-rbac` store or drop `developer` tuples. A keeps the same OpenFGA Postgres data (new login role, same database); B resolves the **same** `STORE_ID`/`MODEL_ID` the operator already reads; C moves the runtime over the **same shared Postgres**. #1604's request → approve → flight flow (proven on candidate-a) must keep working unchanged across A/B/C.

## Relationship to in-flight work

Substrate plumbing **beneath** the app-layer RBAC product flow, not a competitor. Orthogonal (zero shared files), complementary:

- **#1604** (node developer-access request → approve flow) is the **product/app layer**: a `node_developer_requests` tracking table in the **operator** app DB + routes + owner UI, consuming the existing OpenFGA `developer` tuple via `AuthorizationPort`. Its table rides the per-node app DSN that #1610 fixed, **not** OpenFGA's DB. This design changes none of that contract.
- This design is the **infra enabler for #1604's own flagged blocker** (prod `OPENFGA_STORE_ID` empty → 503). Phase 0 + A make the OpenFGA substrate reliably available in prod.
- **provision/deploy split** (dev2, #1607) is actively separating VM provisioning from `deploy-infra`/pod deploys. The `INFRA_ONLY` pass Move 1 edits runs inside provision-env Phase 5f today (`provision-env-vm.sh:1690`) — the exact lane being pulled apart. Settle the post-split owner with dev2 before writing the `provision.sh` edit.

## Goal

- OpenFGA's Postgres role + grants are created by the same `db-provision`/catalog tooling as nodes; **no root credentials in any OpenFGA (or litellm) datastore DSN.**
- The store/model bootstrap is a self-owned, idempotent Job, decoupled from `deploy-infra.sh` gating (Step-6.6a deleted; publish relocated into the Job, targeting the `_shared` fan).
- `db-backup` parity for the OpenFGA authz data lands with the DB-consumer change (A), not deferred.
- **E2E signal (candidate-a):** rotating `OPENFGA_DB_PASSWORD` in OpenBao converges role + runtime `.env` with zero 28P01; a store/model refresh runs via its own Job without a full infra deploy; `POST /api/v1/nodes/{id}/developers` returns `200` (not `503`).

## Non-Goals

- **Not** an OpenFGA-specific workaround for the shared-cred drift — that is the substrate lane's Invariant-15 reconcile (`task.5052`), which unblocks nodes + litellm + openfga together.
- **Not** changing the authorization model DSL, action→relation mapping, or route-level RBAC checks (`rbac.md` stays the authz contract).
- **Not** a parallel DB-cred migration — OpenFGA joins the existing `secrets-management.md` Invariant-15 path.
- **Not** moving OpenFGA off shared Postgres onto a dedicated/PVC datastore (C moves the workload to k8s; the data stays in shared Postgres).
- **Not** wiring node-app `AuthorizationPort` consumption — that's the roadmap, unblocked by Move 2's fan-ready publish.
- **Not** an `assert-target-substrate.sh` / catalog-`type` change in A/B — OpenFGA stays `type: infra` until C.

## Delivery constraints

- **One reviewed PR with the code** — design rides with the Phase-A implementation (`feedback_one_pr_per_task`).
- **Confirm the post-split lane owner with dev2, then ping the manager before touching substrate scripts**; sequence the merge **after prod is green**. This unification _removes_ bespoke logic (kills the split-brain) = syntropy, not churn — but respect the freeze coordination.
- **Same-day sync-porter required.** Phase A touches `scripts/ci/**`, `infra/**`, `deploy-infra.sh` → devops-expert requires a backflow porter to `Cogni-DAO/cogni` committed before merge, else `sync-drift` accumulates. Name the porter in the PR.
- **fga-dev's two asks, resolved:** (Q1) the dedicated infra-DB role needs **its own wiring** — task.5052 gives root-from-OpenBao, the role is the net-new pattern in Move 1; the OpenBao read is already available at infra-pass time (`*-db-reader` SA bound at `provision-env-vm.sh:1434`, infra pass runs after the 5c seed). (Q2) **Hold the `provision.sh` edit; draft only the non-colliding declarations** (the `infra/secrets-catalog.yaml` entry + the `provision_app_role` change design). Don't open a draft PR against the pre-split shape.

## Open Questions / Deliberate Calls

- **`rbac-model.json` to the Job (B):** ConfigMap (rendered from the repo file) vs baked into the OpenFGA image.
- **Post-split lane owner (A):** which lane owns infra-DB-role creation after dev2's provision/deploy split — settle with dev2 before the `provision.sh` edit.

_Resolved:_ env-shared store is the permanent end-state (per-node shatters the graph); the C trigger is the first non-operator consumer.

## Review resolution log

Reviewed across three passes (2026-06-10); all REQUEST-CHANGES points folded into the body above.

| Pass | Point                                                                   | Resolution (now normative)                                                                           |
| ---- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1    | Phase-A DSN is `.env`-reader, not ESO (Compose until C)                 | Move 1 + Invariants: OpenBao → set-once `.env`-reader in A/B; ESO at C.                              |
| 1    | Phase 0 = Invariant-15 reconcile (`task.5052`), not 1606/1607           | Migration row 0 re-anchored + linked; stopgap recorded.                                              |
| 1    | Defer C as demand-gated; statefulness arg backwards                     | Move 3: state stays in PG, workload stateless, C demand-gated on first non-operator consumer.        |
| 1    | Backup belongs in A; B relocates (not deletes) the publish; litellm too | Move 1/2 + Goal; "OpenFGA _and litellm_" in opening.                                                 |
| 1    | Name a sync-porter; one PR with code                                    | Delivery constraints.                                                                                |
| 2    | Dedicated infra-DB role is **net-new plumbing**, not a task.5052 ride   | Move 1 rewritten — extends the `INFRA_ONLY` branch with `provision_app_role`; answers fga-dev Q1/Q2. |
| 2    | Phase A edits a lane mid provision/deploy-split                         | Relationship + Delivery: confirm post-split owner with dev2 (#1607) before the `provision.sh` edit.  |
| 2/3  | "operator-plane substrate" mislabel → **shared substrate**              | Purged; DB cred is shared-infra (infra catalog) because cross-cutting, not operator-owned.           |
| 3    | Phase B publish must target the fan-out seam, not the operator path     | Move 2 + Current-state-vs-roadmap: publish to `_shared`/baseline fan; node opt-in is a one-liner.    |
| 3    | env-shared store + C trigger                                            | Promoted to Invariants (env-shared permanent) + Move 3 (trigger = first non-operator consumer).      |
