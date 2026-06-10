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

The DB-credential half is **not a new invention** — it is OpenFGA joining the migration already specified in [`secrets-management.md` → "DB-credential provisioning"](../spec/secrets-management.md) (Invariant 15, bug.5002). **OpenFGA _and litellm_ are the consumers still on root creds** (`provision.sh:259`, `compose:178/293`); both are in Invariant-15 scope. OpenFGA is the one with stateful authz data on top, so it carries the bootstrap split-brain too.

### Current split-brain (verified as-built)

| Dimension                | Node-substrate pattern (target)                                       | OpenFGA today                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DB auth**              | Dedicated role, password OpenBao-owned, set-once                      | **Root superuser** in the datastore DSN (`compose:293/312`)                                                                                                    |
| **Cred SSOT → runtime**  | OpenBao `cogni/<env>/<svc>` → set-once reader → `.env` (Invariant-15) | `POSTGRES_ROOT_PASSWORD` from rendered `.env`                                                                                                                  |
| **DB role provisioning** | `db-provision` set-once, catalog-driven                               | DB created root-owned; **no role** (`provision.sh:270`)                                                                                                        |
| **Bootstrap**            | n/a / k8s Job                                                         | **`deploy-infra` Step-6.6a** → `bootstrap-openfga.sh` + `patch_operator_openfga_config` + `refresh_operator_openfga_secret` (`deploy-infra.sh:1106/1129/1164`) |
| **Runtime**              | k8s Deployment + Service, Argo                                        | **Compose service** + k8s `ExternalName` (`openfga-external/service.yaml`; `catalog/openfga.yaml type: infra`)                                                 |

### Target architecture (the three North-Star moves)

1. **DB role + grants from the shared tooling + OpenBao SSOT.**
   - OpenFGA gets a **dedicated Postgres role** (`openfga`), created **set-once** by the same `db-provision` engine that creates node roles — never `ALTER … PASSWORD` from `.env` (Invariant 15).
   - **In A/B OpenFGA stays a Compose service, so the DSN travels OpenBao → `deploy-infra` set-once reader → runtime `.env`** — the Invariant-15 path app DB creds + litellm already use (`secrets-management.md:233`), **not** ESO (ESO reaches k8s pods only; that is C). A declares `OPENFGA_DB_PASSWORD` in the secrets catalog so it is provisioned by declaration and rides the `task.5052` read-path automatically. **Root creds leave the datastore DSN.**

2. **Self-owned, idempotent store/model bootstrap — _relocated_, not deleted.**
   - `bootstrap-openfga.sh` is already idempotent (finds-or-creates store `cogni-<env>-rbac`; reuses the authz model by canonical-JSON hash). Its _logic_ stays; its _invocation site_ moves into a k8s **Job** keyed to the OpenFGA + model version.
   - **B deletes the deploy-infra _gating_ and _relocates_ the publish — it does not eliminate it.** The Job still writes `STORE_ID`/`MODEL_ID` to OpenBao + triggers ESO delivery (`patch_operator_openfga_config` + `refresh_operator_openfga_secret` logic, moved _into_ the Job). What dies is Step-6.6a's coupling: a deploy-infra run no longer gates on OpenFGA, and a store refresh no longer needs a full infra deploy. _Open:_ how the Job obtains `infra/openfga/rbac-model.json` (today scp'd to `/tmp`, `deploy-infra.sh:1886`) — ConfigMap or baked image.

3. **Runtime to Argo — _demand-gated_, off the critical path.**
   - C would move OpenFGA from Compose to a **k8s Deployment + in-cluster Service** (retiring `ExternalName` + the VM port exposure), per-`(env)` Argo AppSet. **Only here** does the catalog type leave `infra` and an `assert-target-substrate.sh` `type=service` contract get defined — a **C-only** question.
   - C's upside is **lane-uniformity / retiring `ExternalName`**, not statefulness: durable state stays in shared Postgres (Non-Goal #4), so the _workload_ is stateless and rolls fine in Compose — the same litellm case the devops-expert skill codifies as "runtime stays Compose, move explicitly deferred." At MVP altitude (`feedback_mvp_stage_first`), **C is demand-gated** (mirrors PR #1606).
   - **A + B clear the 503, the bug.5002 class, and the split-brain. C earns its way in later.**

### Migration — phased, each a task under [`proj.rbac-hardening`](../../work/projects/proj.rbac-hardening.md), one PR each

| Phase                             | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Status / gating                                                                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0 — Invariant-15 reconcile**    | The DB-cred SSOT reconcile (`secrets-management.md` Phase 2 / `task.5052`): `deploy-infra`/`db-provision` source DB passwords from OpenBao, killing the root-cred drift for **all** consumers. _Not a new "Phase 0" number — the existing task._ Stopgap in flight (2026-06-10): a prod operator promote (`skip_infra=false`) drives `bootstrap-openfga` on the bespoke path to create prod's empty `OPENFGA_STORE_ID` + flip operator `app_user → app_operator`. | **Substrate lane.** fga-dev verifies (a) prod store bootstrapped, (b) #1604's approve-flow clears its 503 on cognidao.org. If deploy-infra `28P01`s at db-provision before reaching bootstrap, driving the bootstrap home _is_ this. |
| **A — dedicated OpenFGA DB role** | `openfga` role in `db-provision` (set-once) + `OPENFGA_DB_PASSWORD` catalog entry; datastore DSN → `openfga:<pw>` (drop root) on openfga + openfga-migrate; password rides the Invariant-15 `.env` read-path. **Pull `db-backup` parity in here** — the authz data is in shared Postgres today; the gap is live now and widens the moment A makes OpenFGA a first-class DB consumer. Catalog stays `type: infra`.                                                 | Rides Phase-0's read-path; the dedicated-role + drop-root + backup land as **one reviewed PR with code**.                                                                                                                            |
| **B — relocate the bootstrap**    | Move store/model bootstrap into a self-owned idempotent **Job**; delete Step-6.6a's _gating_; relocate (not delete) the OpenBao publish + ESO trigger into the Job.                                                                                                                                                                                                                                                                                               | After A.                                                                                                                                                                                                                             |
| **C — runtime to Argo**           | Deployment + Service + AppSet; retire Compose service + `ExternalName`; catalog `type: service` + `assert-target-substrate` contract.                                                                                                                                                                                                                                                                                                                             | **Demand-gated**, not scheduled.                                                                                                                                                                                                     |

### Invariants that must hold

- **OpenBao is the sole source** of the OpenFGA DB role password; in A/B `deploy-infra` is a set-once **`.env`-reader** of it (ESO only at C). `db-provision` creates the role once and never `ALTER … PASSWORD` from `.env` (the bug.5002 anti-fix).
- **Authz models are immutable**, reused by canonical-hash; a new model is written only on content change.
- **Deny-by-default + fail-closed**: a missing/unconfigured store yields `authz_unavailable`, never allow.
- **No bespoke per-service bootstrap**: bootstrap is a declared, idempotent step (a Job in B), not inline deploy-infra logic.
- **Fail loud on source-read failure**: if the bootstrap or DB-role read can't reach OpenBao, fail — never fall back to a divergent `.env` value.
- **Store + tuple continuity (the #1604 contract)**: the migration must never reset the `cogni-<env>-rbac` store or drop `developer` tuples. A keeps the same OpenFGA Postgres data (new login role, same database); B resolves the **same** `STORE_ID`/`MODEL_ID` the operator already reads; C moves the runtime over the **same shared Postgres**. #1604's request → approve → flight flow (proven on candidate-a) must keep working unchanged across A/B/C.

## Relationship to in-flight work

Substrate plumbing **beneath** the app-layer RBAC product flow, not a competitor. Orthogonal (zero shared files), complementary:

- **#1604** (node developer-access request → approve flow) is the **product/app layer**: a `node_developer_requests` tracking table in the **operator** app DB + routes + owner UI, consuming the existing OpenFGA `developer` tuple via `AuthorizationPort`. Its table rides the per-node app DSN that #1610 fixed, **not** OpenFGA's DB. This design changes none of that contract.
- This design is the **infra enabler for #1604's own flagged blocker** (prod `OPENFGA_STORE_ID` empty → 503). Phase 0 + A make the OpenFGA substrate reliably available in prod.

## Goal

- OpenFGA's Postgres role + grants are created by the same `db-provision`/catalog tooling as nodes; **no root credentials in any OpenFGA (or litellm) datastore DSN.**
- The store/model bootstrap is a self-owned, idempotent Job, decoupled from `deploy-infra.sh` gating (Step-6.6a deleted; publish relocated into the Job).
- `db-backup` parity for the OpenFGA authz data lands with the DB-consumer change (A), not deferred.
- **E2E signal (candidate-a):** rotating `OPENFGA_DB_PASSWORD` in OpenBao converges role + runtime `.env` with zero 28P01; a store/model refresh runs via its own Job without a full infra deploy; `POST /api/v1/nodes/{id}/developers` returns `200` (not `503`).

## Non-Goals

- **Not** an OpenFGA-specific workaround for the shared-cred drift — that is the substrate lane's Invariant-15 reconcile (`task.5052`), which unblocks nodes + litellm + openfga together.
- **Not** changing the authorization model DSL, action→relation mapping, or route-level RBAC checks (`rbac.md` stays the authz contract).
- **Not** a parallel DB-cred migration — OpenFGA joins the existing `secrets-management.md` Invariant-15 path.
- **Not** moving OpenFGA off shared Postgres onto a dedicated/PVC datastore (C moves the workload to k8s; the data stays in shared Postgres).
- **Not** an `assert-target-substrate.sh` / catalog-`type` change in A/B — OpenFGA stays `type: infra` until C.

## Delivery constraints

- **One reviewed PR with the code** — design rides with the Phase-A implementation (`feedback_one_pr_per_task`).
- **Ping the manager before touching substrate scripts**; sequence the merge **after prod is green**. This unification _removes_ bespoke logic (kills the split-brain) = syntropy, not churn — but respect the freeze coordination.
- **Same-day sync-porter required.** Phase A touches `scripts/ci/**`, `infra/**`, `deploy-infra.sh` → devops-expert requires a backflow porter to `Cogni-DAO/cogni` committed before merge, else `sync-drift` accumulates. Name the porter in the PR.

## Review resolution (fga-dev → reviewer REQUEST CHANGES, 2026-06-10)

| #            | Reviewer point                                                      | Resolution                                                                                   |
| ------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1 (blocking) | Phase-A DSN is `.env`-reader, not ESO (Compose until C)             | Move 1 + Invariants + Migration-A now say OpenBao → set-once `.env`-reader in A/B; ESO at C. |
| 2            | Phase 0 = Invariant-15 reconcile (`task.5052`), not 1606/1607       | Migration row 0 re-anchored + linked; stopgap state recorded.                                |
| 3            | Defer C as demand-gated; statefulness arg is backwards              | Move 3 rewritten: state stays in PG, workload stateless, C demand-gated.                     |
| 4            | Catalog-type is C-only                                              | Non-Goal added; Move 3 + Migration-A keep `type: infra` in A/B.                              |
| 5            | Backup belongs in A                                                 | Pulled into Migration-A + Goal.                                                              |
| 6            | B relocates the publish, not deletes; `rbac-model.json` source open | Move 2 rewritten; open question named.                                                       |
| 7            | "one consumer on root" imprecise — litellm too                      | Opening para + Goal say "OpenFGA _and litellm_."                                             |
| 8            | Name a same-day sync-porter; one PR with code                       | Delivery-constraints section added.                                                          |

## Open Questions / Deliberate Calls

- **`rbac-model.json` to the Job (B):** ConfigMap (rendered from the repo file) vs baked into the OpenFGA image.
- **One store per env vs per node (C+):** today a single `cogni-<env>-rbac` store serves all nodes. Keep env-shared unless per-node isolation is required.
- **C trigger:** what demand signal promotes C off the backlog (e.g. a second stateful Compose-infra service, or `ExternalName` causing an incident).

---

## Design Review — pass 2 (provision/deploy-split + BaaS lens, reviewer 2026-06-10)

Pass-1 corrections all landed cleanly (resolution table is accurate). This pass reviews Phase A against two things pass-1 didn't weigh: the **provision-vs-deploy separation mission** and [`node-baas-architecture.md`](../spec/node-baas-architecture.md). One finding rewrites Phase-A's framing; it directly answers fga-dev's two open asks.

### 🔴 Finding 1 — "Phase A rides Phase-0's read-path" is too optimistic. The dedicated infra-DB role is **net-new plumbing**, not a free ride on task.5052.

Verified in the as-built:

- `provision.sh` has a dedicated **infra-DB pass** (`PROVISION_INFRA_ONLY=1`, `provision.sh:30`) — "set by deploy-infra.sh's dedicated infra-DB pass." In that pass, litellm and openfga DBs are created **root-owned, no role** (`provision.sh:306`, `:317`).
- The `provision_app_role <role> <openbao-password>` pattern (`provision.sh:152`, called `:232`) — the set-once, OpenBao-sourced login role — exists **only in the per-node pass** (`INFRA_ONLY != 1`).
- task.5052 / Invariant-15 threads the **superuser** password from OpenBao into the infra pass (so root stops drifting). It does **not** create dedicated litellm/openfga login roles.

**Therefore:** a dedicated `openfga` login role with an OpenBao-sourced password requires introducing the `provision_app_role` pattern **into the `INFRA_ONLY` branch for the first time** — seed `OPENFGA_DB_PASSWORD` to OpenBao, thread it into the infra-pass env, call `provision_app_role openfga "$OPENFGA_DB_PASSWORD"`, then flip the Compose DSN. That plumbing is the real Phase-A substrate work. Reframe Move 1 / Migration-A from "joins task.5052's read-path" to **"extends `db-provision`'s `INFRA_ONLY` branch with the per-role OpenBao pattern that today only the per-node pass has."** (litellm is the symmetric twin — the same new pattern serves both; consider doing both in one pass so the infra-DB-role shape is defined once, not openfga-bespoke.)

### Answers to fga-dev's asks

**Q1 — does task.5052 thread OpenBao into the infra-DB pass, or do these roles need their own wiring?** → **Their own wiring.** task.5052 covers root-from-OpenBao; the dedicated infra-DB *role* is the new pattern above. You were right to hold and not guess the mechanism. The OpenBao read itself is already available at infra-pass time — the `${DEPLOY_ENV}-db-reader` role is bound to the `db-provisioner` SA at `provision-env-vm.sh:1434` (5b.4c), and the infra pass runs in Phase 5f **after** the 5c OpenBao seed — so the only gaps are (a) seed `OPENFGA_DB_PASSWORD` at 5c, (b) confirm the `*-db-reader` policy glob grants the openfga path, (c) add the `provision_app_role` call in the `INFRA_ONLY` branch.

**Q2 — draft Phase-A code now, or hold?** → **Hold the `provision.sh` / `db-provision` edit; draft only the non-colliding declarations.** Reasons: the infra-DB-role pattern is net-new (above), the file is mid-split (Finding 2), and the freeze is imminent. What you *can* write now without collision: the `infra/secrets-catalog.yaml` `OPENFGA_DB_PASSWORD` entry (Finding 3) and the design of the `INFRA_ONLY` `provision_app_role` change. Do **not** open a draft PR that edits `provision.sh` against the pre-split shape — it will rebase into rework the moment dev2's split moves the lane.

### 🟡 Finding 2 — Phase A edits a file whose lane ownership is in flux; state the post-split target.

The `INFRA_ONLY` pass is invoked by `deploy-infra.sh`, which today runs **inside** provision-env Phase 5f (`provision-env-vm.sh:1690`). provision-env explicitly "owns the SUBSTRATE (…**Compose**, DB-cred gate)" (`:2057`). The active mission — separate VM provisioning from deploy-infra/pod deploys (dev2, PR #1607) — is pulling exactly this apart. Since OpenFGA is **"likely the last allowed substrate feature"** before the freeze, Phase A must declare which **post-split** lane owns infra-DB-role creation (VM-provision infra pass vs a decoupled deploy-infra vs a substrate-materialization step) and target *that*, or be explicitly sequenced to land **before** the split freezes. It can't safely do both — this is the coordination point to settle with dev2 before writing the provision-script edit, beyond the existing "ping before substrate scripts."

### 🟡 Finding 3 — BaaS lens: OpenFGA is operator-plane substrate, not a node. Name the catalog file + path.

`node-baas-architecture.md` invariant: *node declares shape; operator wires environment.* OpenFGA is operator-plane infra (peer of litellm/temporal/redis), **not** a node — so its secret declaration goes in **`infra/secrets-catalog.yaml`** (operator-domain), at `cogni/<env>/openfga/OPENFGA_DB_PASSWORD` (dedicated service path; `_shared` only if litellm/openfga deliberately share), **never** a `nodes/<node>/.cogni/secrets-catalog.yaml`. This is consistent with the design's `type: infra` stance — just make the catalog file + path explicit in Migration-A so it doesn't get filed as a node secret. (The BaaS substrate map's "operator provides per-node DB, roles, RLS, backups" also confirms the `db-backup` parity you pulled into A is correctly operator-plane.)

### Verdict

**APPROVE the direction; REQUEST one doc edit before code:** reframe Phase A per Finding 1 (net-new infra-DB-role pattern, not a task.5052 ride) and add the post-split lane-ownership call (Finding 2) + catalog file/path (Finding 3). Then: declarations can be drafted now; the `provision.sh` edit holds for dev2's split + manager sequencing. The store/tuple-continuity invariant and the one-PR-with-code constraint remain correct as written.

---

## Design Review — pass 3 (current-state vs roadmap, reviewer 2026-06-10)

Re-analysis prompted by the correct observation: **OpenFGA is v0 operator-only today, but is on a hard trajectory to become a standard substrate consumed by _every_ node app.** Verified both halves precisely:

| Artifact | Current state (v0) | Roadmap (all-nodes) |
| --- | --- | --- |
| OpenFGA server (DB, store, runtime) | one shared Compose instance / env; one `cogni-<env>-rbac` store | **same** — one shared instance, one env store (litellm-shape) |
| Consumer of the authz API | **operator app only** — only `container.ts:843` builds the `AuthorizationPort` | **every node app** builds an `AuthorizationPort` and checks |
| `OPENFGA_DB_PASSWORD` | operator-plane infra cred; server→shared-PG | **same** — singular, operator-plane; nodes hit the API, never the DB |
| `OPENFGA_API_URL`/`STORE_ID`/`MODEL_ID` (consumed config) | published to the **operator** path only; **not** in `NODE_BASELINE_KEYS` (verified — no node ExternalSecret references it) | **fanned to every node app** via the existing baseline-fan / `_shared` seam (`reconcile-secrets.sh:41,205`) |

This **sharpens, not overturns** Findings 2–3 — and surfaces the one thing pass-2 missed:

### Finding 2 — UNCHANGED. Orthogonal to the consumer model.
The `openfga` DB + login role are **singular operator-plane infra regardless of how many apps consume the API** (one server, one DB, created once in the infra-DB pass). The provision/deploy-split lane-ownership question is independent of consumer count. Stands as written.

### Finding 3 — CORRECT for the DB password; that's the litellm precedent, and the all-nodes future _confirms_ it.
`OPENFGA_DB_PASSWORD` → `infra/secrets-catalog.yaml` @ `cogni/<env>/openfga/*`, never a node catalog — **roadmap-stable.** The litellm analogy is exact: litellm is operator-plane shared infra whose DB cred is operator-owned *and* whose runtime config is fanned to every node. Nodes consuming OpenFGA's API no more makes its DB credential per-node than nodes calling litellm makes litellm's DB cred per-node. So Phase A is correct as designed; the all-nodes trajectory does not touch it.

### 🔴 Finding 4 (NEW — the part pass-2 missed) — Phase B's publish target is where the roadmap bites. Build it for fan-out, not the operator path.
The artifact that becomes "standard substrate for all node apps" is **not** the DB cred — it's the consumed runtime config (`OPENFGA_API_URL`/`STORE_ID`/`MODEL_ID`). Today the bootstrap publishes these to the **operator-specific** path (`patch_operator_openfga_config` → operator ExternalSecret). If Phase B's Job re-encodes that operator-hardcoded target, the v0→all-nodes port becomes a publish rewrite. **Build the publish against the fan-out seam now:** write `OPENFGA_API_URL/STORE_ID/MODEL_ID` to `cogni/<env>/_shared` (the spec's cross-service opt-in path, already delivered to every type:node by `seed_node_app_secrets`), or add them to `NODE_BASELINE_KEYS` with `shared: true`. Then **the consumer set stays operator-only today** (do _not_ wire node apps' `AuthorizationPort` speculatively — `container.ts:843` stays operator-only until node apps actually enforce; that's premature otherwise), but flipping a node on later = adding it to the consumer list, **not** re-architecting the Job. _(Aside: `STORE_ID`/`MODEL_ID` are non-secret identifiers per the cicd-secrets-expert config-vs-secret triage — they ride the OpenBao/ESO path only because they're bootstrap-resolved/dynamic. `_shared` is the right vehicle given they already flow through ESO; a ConfigMap is the purer home if you ever decouple them.)_

### Resolve two open questions with the roadmap as the deciding reason
- **"One store per env vs per node" → env-shared, permanently.** The all-nodes model is the *reason*, not just current simplicity: the model already carries per-node `node:` objects + `developer` relations, so every node app checks the **same** `cogni-<env>-rbac` graph. Per-node stores would shatter the authz graph (a `developer` granted on node X must be checkable by X's app against the shared model). Promote this from "keep unless isolation required" to "env-shared is the end-state."
- **"C trigger" → named: the second consumer.** Today an OpenFGA/`ExternalName` outage blasts only the operator. The moment a node app beyond operator consumes the API, an outage takes down authz for **every** node — the SPOF goes N×. "First node app beyond operator wired to OpenFGA" is the concrete demand signal that promotes C off the backlog. Still demand-gated; now the trigger is specific.

### Net prescription for current work (A/B), under the all-nodes model
1. **Phase A — unchanged.** Singular operator-plane DB role + `infra/secrets-catalog.yaml` cred. Correct; roadmap-stable.
2. **Phase B — publish to the `_shared`/baseline-fan seam, consumer-count-agnostic.** Operator-only consumer today; one-line node opt-in later. This is the single change the roadmap demands of current work.
3. **Lock env-shared store + name the C trigger** in the open-questions section.
4. **Do not** pull node-app `AuthorizationPort` wiring into this work — that's the roadmap's job, gated on the published config being fan-ready (which #2 guarantees).
