---
id: design.openfga-substrate-unification
type: design
title: OpenFGA as a First-Class Substrate Consumer
status: draft
trust: draft
summary: Retire OpenFGA's bespoke deploy-infra substrate path — unify its DB role/grants onto the OpenBao/ESO SSOT the nodes use, make store/model bootstrap a self-owned idempotent step, and move the runtime onto the Argo + shared-Postgres node-substrate lane.
owner: derekg1729
created: 2026-06-10
updated: 2026-06-10
tags: [authorization, openfga, substrate, secrets, ci-cd, rbac]
---

# OpenFGA as a First-Class Substrate Consumer

## Design

OpenFGA today provisions itself through a **bespoke path bolted onto `deploy-infra.sh`**: it authenticates to Postgres as the **root superuser**, its store/model bootstrap is a hand-rolled `deploy-infra` Step-6.6a gate, and it runs as a **Compose service fronted by a k8s `ExternalName`**. That split-brain is why the prod `503 authz_unavailable` surfaced — but the 503 is a _symptom_. The root cause is the shared-Postgres root-credential drift (Gotcha 12 / bug.5002), which wedges `db-provision` for **every** consumer (nodes, litellm, AND openfga) before Step-6.6a is ever reached. The shared-cred reconcile that fixes it is owned by the substrate lane; this design does **not** add an OpenFGA-specific workaround.

This design takes the North Star: **one substrate lane reconciles all DB consumers, and no service owns a bespoke bootstrap.** OpenFGA becomes a first-class consumer of the exact tooling and SSOT that nodes use.

The DB-credential half is **not a new invention** — it is OpenFGA finally joining the migration already specified in [`secrets-management.md` → "DB-credential provisioning"](../spec/secrets-management.md) (Invariant 15, bug.5002, Phases 0–3). OpenFGA is the one consumer still on root creds, so it is _behind_ even Phase 0 for its own role.

### Current split-brain (verified as-built)

| Dimension                | Node-substrate pattern (target)                                             | OpenFGA today                                                                                                                                                           | Source                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **DB auth**              | Dedicated role (`app_user`/`app_service`), password OpenBao-owned, set-once | **Root superuser** in the datastore DSN                                                                                                                                 | `docker-compose.yml` openfga + openfga-migrate `OPENFGA_DATASTORE_URI=postgres://${POSTGRES_ROOT_USER}:${POSTGRES_ROOT_PASSWORD}@…/openfga` |
| **Cred SSOT → runtime**  | OpenBao `cogni/<env>/<svc>` → ESO → pod DSN                                 | `POSTGRES_ROOT_PASSWORD` from rendered `.env` (GH-secret path)                                                                                                          | `deploy-infra.sh` runtime/.env render                                                                                                       |
| **DB role provisioning** | `db-provision` set-once, catalog-driven (`COGNI_NODE_DBS`)                  | DB created root-owned; **no role created**                                                                                                                              | `postgres-init/provision.sh` openfga branch                                                                                                 |
| **Bootstrap**            | n/a (stateless apps) or k8s Job                                             | **`deploy-infra.sh` Step-6.6a** runs `bootstrap-openfga.sh`, then `patch_operator_openfga_config` (OpenBao write) + `refresh_operator_openfga_secret` (forced ESO poll) | `deploy-infra.sh:1106-1204`                                                                                                                 |
| **Runtime**              | k8s Deployment + Service, Argo-reconciled                                   | **Compose service on VM** + k8s `ExternalName` → VM DNS:8080                                                                                                            | `infra/k8s/base/openfga-external/service.yaml`; `infra/catalog/openfga.yaml` `type: infra`                                                  |
| **Substrate lane**       | `assert-target-substrate.sh` type=node checks                               | **Excluded** — type=infra fails the assertion explicitly                                                                                                                | `assert-target-substrate.sh` infra branch                                                                                                   |

### Target architecture (the three North-Star moves)

1. **DB role + grants from the shared tooling + OpenBao/ESO SSOT.**
   - OpenFGA gets a **dedicated Postgres role** (`openfga`), created **set-once** by the same `db-provision` engine that creates node roles — catalog-driven, never `ALTER … PASSWORD` from `.env` (Invariant 15).
   - Its password lives in OpenBao at `cogni/<env>/openfga` (or `_shared`), is the **single source**, and reaches the runtime as an ESO-delivered `OPENFGA_DATASTORE_URI` — exactly the `secrets-management.md` Phase-2 read-path. **Root creds leave the datastore DSN entirely.**
   - Adds an `openfga` entry to the secrets catalog so it is provisioned by declaration, not by a special branch.

2. **Self-owned, idempotent store/model bootstrap — not a deploy-infra gate.**
   - `bootstrap-openfga.sh` already is idempotent (finds-or-creates store `cogni-<env>-rbac`; reuses the authz model by canonical-JSON hash, writes a new immutable model only on change). Its _logic_ stays; its _invocation site_ moves.
   - It becomes a step **OpenFGA owns** — a k8s **Job** (or init/startup hook) keyed to the OpenFGA + model version — that runs against the OpenFGA service and publishes `OPENFGA_STORE_ID`/`MODEL_ID`/`HASH` to the operator's OpenBao path for ESO to deliver.
   - **Delete** `deploy-infra.sh` Step-6.6a, `patch_operator_openfga_config`, `refresh_operator_openfga_secret`, and the operator process-env proof's coupling to it. A deploy-infra run no longer gates on OpenFGA, and an OpenFGA store refresh no longer requires a full infra deploy.

3. **First-class substrate consumer: Argo + shared-Postgres runtime.**
   - OpenFGA moves from Compose to a **k8s Deployment + in-cluster Service** (retiring the `ExternalName` indirection and the VM port exposure), reconciled by a per-`(env)` Argo AppSet, on the node-substrate lane.
   - Its catalog type changes from `infra` so `assert-target-substrate.sh` can assert it (a `type=service` contract, or it joins the node-style substrate checks). State stays in **shared Postgres** — the workload itself rolls statelessly; the durable authz data (stores/models/tuples) is the DB, already covered by the unified DB provisioning and owed a **backup contract** alongside the app DBs.
   - **The runtime move (Compose → k8s) is a deliberate call** (the litellm "stay in Compose" precedent is weaker here because OpenFGA carries stateful authz substrate). The DB-cred + bootstrap unification (moves 1–2) is **not optional** and can land before the runtime move.

### Migration — phased, each independently shippable

| Phase | Change                                                                                                                                                                                                                                                                                                                    | Gating                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **0** | **Shared-cred reconcile lands** (substrate lane, Derek). `db-provision` authenticates with the OpenBao-sourced superuser/role values; 28P01 clears for all consumers. Prod `deploy-infra` reaches Step-6.6a and the OpenFGA store bootstraps on the _existing_ path → the `503` clears as a stopgap.                      | **Owned by substrate lane; I drive the store bootstrap home on ping.**                              |
| **A** | **Dedicated OpenFGA DB role on the SSOT.** Add `openfga` role to `db-provision` (set-once) + catalog/secrets-catalog entry; password OpenBao-owned; datastore DSN becomes ESO-delivered `OPENFGA_DATASTORE_URI`; **drop root creds** from openfga + openfga-migrate. Aligns OpenFGA to `secrets-management.md` Phase 1/2. | After Phase 0.                                                                                      |
| **B** | **Decouple the bootstrap.** Extract store/model bootstrap into a self-owned idempotent **Job**; remove `deploy-infra` Step-6.6a + the OpenBao-patch/ESO-poll helpers.                                                                                                                                                     | After A (or parallel; this is the "drive the store bootstrap home, idempotently, decoupled" piece). |
| **C** | **Runtime to k8s/Argo.** OpenFGA Deployment + Service + per-env AppSet; retire Compose service + `ExternalName`; catalog type → first-class substrate; join `assert-target-substrate`; add authz-DB backup contract.                                                                                                      | Deliberate call; after A–B.                                                                         |

### Invariants that must hold

- **OpenBao is the sole source** of the OpenFGA DB role password; `db-provision` is a set-once _reader_, never a second writer (no `ALTER … PASSWORD` from `.env` — the bug.5002 anti-fix).
- **Authz models are immutable**, reused by canonical-hash; a new model is written only on content change.
- **Deny-by-default + fail-closed**: a missing/unconfigured store yields `authz_unavailable`, never allow.
- **No bespoke per-service bootstrap**: bootstrap is a declared, idempotent substrate step, not inline deploy-infra logic.
- **Fail loud on source-read failure**: if the bootstrap or DB-role read can't reach OpenBao, fail — never fall back to a divergent `.env` value.
- **Store + tuple continuity (the #1604 contract)**: the migration must never reset the `cogni-<env>-rbac` store or drop `developer` tuples. Phase A keeps the same OpenFGA Postgres data (new login role, same database); Phase B relocates the bootstrap but resolves the **same** `STORE_ID`/`MODEL_ID` the operator already reads; Phase C moves the runtime over the **same shared Postgres**. #1604's request → approve → flight flow (the `developer` tuple it writes, proven on candidate-a) must keep working unchanged across A/B/C.

## Relationship to in-flight work

This design is the **substrate plumbing beneath** the app-layer RBAC product flow, not a competitor to it. They are orthogonal (zero shared files) and complementary:

- **#1604** (node developer-access request → approve flow) is the **product/app layer**: a `node_developer_requests` tracking table in the **operator** app DB, the request/decision routes, and the owner Developers UI — all consuming the existing OpenFGA `developer` tuple via `AuthorizationPort`. Its tracking table rides the per-node app DSN that #1610 just fixed, **not** OpenFGA's DB. This design changes none of that contract (see Non-Goals).
- This design is the **infra enabler for #1604's own flagged blocker**: #1604 notes "prod operator pod has no `OPENFGA_STORE_ID` → approval `503` in prod; built to be proven on candidate-a." Phase 0 (shared-cred reconcile) + Phases A–B are exactly what make the OpenFGA substrate reliably available in prod, so #1604's approve flow works in prod, not only candidate-a.

## Goal

- OpenFGA's Postgres role + grants are created by the same `db-provision`/catalog tooling as nodes, with its password single-sourced from OpenBao/ESO; **no root credentials in any OpenFGA datastore DSN.**
- The OpenFGA store/model bootstrap is a self-owned, idempotent step (Job/startup), fully decoupled from `deploy-infra.sh` (Step-6.6a and its OpenBao-patch/ESO-poll helpers deleted).
- OpenFGA participates in the substrate lane as a first-class consumer (catalog type, `assert-target-substrate`), with the runtime on Argo + shared-Postgres as the deliberate end-state.
- **E2E signal:** on candidate-a, rotating the OpenFGA DB password in OpenBao only (no GH-secret edit) converges role + runtime with zero 28P01; a store/model refresh runs via its own Job without a full infra deploy; `POST /api/v1/nodes/{id}/developers` returns `200` (not `503`) end-to-end.

## Non-Goals

- **Not** building an OpenFGA-specific workaround for the shared-cred drift — that fix is the substrate lane's shared-cred reconcile (Phase 0), which unblocks nodes + litellm + openfga together.
- **Not** changing the authorization model DSL, the action→relation mapping, or the route-level RBAC checks (`rbac.md` stays the authz contract).
- **Not** introducing a parallel DB-cred migration — OpenFGA joins the existing `secrets-management.md` Phase 1/2 path.
- **Not** moving OpenFGA off shared Postgres onto a dedicated/PVC datastore in this design (the workload moves to k8s; the data stays in shared Postgres).

## Open Questions / Deliberate Calls

- **Runtime move timing (C):** ship A+B first (cred + bootstrap unification, the non-optional part) and treat the Compose→k8s move as a follow-on, or do them together? Statefulness argues for k8s sooner; blast radius argues for later.
- **One store per env vs per node:** today a single `cogni-<env>-rbac` store serves all nodes. Keep env-shared (simpler, matches current authz model) unless per-node isolation becomes a requirement.
- **Catalog type for OpenFGA:** introduce a `type=service` substrate contract in `assert-target-substrate.sh`, or model OpenFGA as a node-like target? The skill notes `type=service`/`type=infra` "fail until their own contracts exist" — this design is the trigger to define the `service` contract.
- **Authz-data backup contract:** the app DBs have a `db-backup` timer; the OpenFGA store/model/tuples need an equivalent before C is "done."
