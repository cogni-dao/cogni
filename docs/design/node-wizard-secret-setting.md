---
id: design.node-wizard-secret-setting
type: design
title: "Node Wizard Secret Setting"
status: draft
created: 2026-06-08
skills:
  - ../../.claude/skills/node-wizard-expert/SKILL.md
  - ../../.claude/skills/cicd-secrets-expert/SKILL.md
spec_refs:
  - ../spec/secrets-classification.md
  - ../spec/secrets-management.md
  - ../spec/node-ci-cd-contract.md
related:
  - ./secrets-catalog-per-node.md
knowledge_id: node-wizard-secret-setting
---

# Node Wizard Secret Setting

## Decision

The node wizard generates **secret shape**, not secret values.

A wizard-created node-birth PR must make the new node structurally deployable
on the ESO-first substrate by adding the git artifacts that describe where
secrets will flow. It must not mint an alternate set of app/runtime values,
copy operator secrets into git, or save progress state that can be derived from
GitHub, GHCR, OpenBao/ESO, candidate flight, or the deployed app.

Values are owned by the secrets substrate:

```
catalog + node birth facts
  -> secret-materialize <env> <node>
  -> OpenBao path cogni/<env>/<node>
  -> reconcile-substrate reads OpenBao and provisions DB/edge/ESO
  -> ExternalSecret dataFrom.extract
  -> k8s Secret <node>-env-secrets
  -> Deployment envFrom
  -> assert-substrate verifies read-only
```

The wizard may trigger or report the owning lane, but it must not create a
parallel source of truth. Creating all-env shape is not the same as proving
all-env values exist; value materialization is validated by the
provision/reconcile and flight lanes.

## V0 E2E Checkpoint

For a normal wizard-created node, there are **no per-node human secret values**.
The node inherits the environment's existing DAO/org unlocks and receives
generated node-local material from the substrate lane.

The explicit v0 flow is:

1. Environment genesis/provisioning has already established the DAO/org secret
   bank for the environment.
2. The wizard creates the node-birth PR: catalog target, ExternalSecret leaf,
   overlay, AppSet, child repo pin, and launch-pack facts.
3. Candidate flight runs the narrow node substrate readiness lane before the
   read-only substrate assertion.
4. That lane preserves any existing `cogni/<env>/<slug>` values, fills missing
   generated node-local values, denormalizes only the environment values the
   node is allowed to consume, applies `<slug>-env-secrets`, updates edge/DB
   inventory, and runs the targeted DB provisioners.
5. `assert-substrate` verifies ExternalSecret readiness, DB/edge shape, and
   app substrate without writing secrets.

The v0 lane is a checkpoint, not the final backend. It still needs a follow-up
PR that splits `secret-materialize` from substrate reconcile and replaces
historical broad fallback with an explicit OpenBao shared-bank / owner-grant
model. Do not hide that follow-up by calling current denormalization the final
authority model.

### Inputs Needed For A New Node

For a standard non-payment wizard node: **none per node**.

Use the formation contract in
[`secrets-classification.md`](../spec/secrets-classification.md#node-wizard-formation-contract).
The v0 candidate-a proof should not ask anyone for a new value during node
birth. If a shared/environment value is needed and absent, that is an
environment-bank repair, not a node-wizard form field.

## Why This Exists

The prior node wizard could create a parent node-birth PR whose overlays still
referenced legacy imperative Secrets such as `<slug>-node-app-secrets`. That
shape cannot satisfy app-flight substrate assertions for an ESO-first target:
flight can see a Deployment, but the Deployment consumes a Secret that no
ExternalSecret owns.

Fresh-node proof should fail only for real missing values, child images, or
runtime health. It should not fail because the wizard emitted the wrong
substrate shape.

## Sources Of Authority

Use these in order:

1. `node-wizard-expert` for wizard scope: birth facts, launch pack handoff,
   child repo ancestry, and what not to persist in wizard state.
2. `cicd-secrets-expert` for secrets custody: OpenBao/ESO vs GitHub env
   secrets, catalog tiers, value write lanes, and anti-patterns.
3. `docs/spec/secrets-classification.md` for routing tiers and naming.
4. `docs/spec/secrets-management.md` for OpenBao/ESO invariants.
5. `scripts/setup/lib/reconcile-secrets.sh` and
   `scripts/lib/secrets-catalog-loader.ts` for current fan-out behavior.

Before changing live launch behavior, recall the operator knowledge block
`node-launch-handoff` and refine it if the handoff contract changes.

## Wizard-Owned Artifacts

A wizard birth flow has two write surfaces: the child node repo seed and the
parent operator PR that pins and deploys it. Together they should produce this
footprint for the birth matrix (`candidate-a`, `preview`, `production`):

| Artifact                                             | Surface             | Wizard responsibility                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `k8s/external-secrets/<env>/external-secret.yaml`    | child repo seed     | Declare one ExternalSecret for the node/env. When mounted, this appears at `nodes/<slug>/k8s/...`.                                                                                     |
| `k8s/external-secrets/<env>/kustomization.yaml`      | child repo seed     | Make the ExternalSecret leaf available to provision/reconcile. Candidate flight syncs the `candidate-a` leaf today; preview/production runtime sync belongs to the env substrate lane. |
| `infra/catalog/<slug>.yaml`                          | parent operator PR  | Declare node topology, source repo, image repo, ports, and deploy branches.                                                                                                            |
| `infra/k8s/overlays/<env>/<slug>/kustomization.yaml` | parent operator PR  | Point every node-app Deployment/initContainer secret reference at `<slug>-env-secrets` for all birth envs.                                                                             |
| `infra/k8s/argocd/<env>-<slug>-applicationset.yaml`  | parent operator PR  | Make the target visible to Argo and the candidate/preview/production flight lanes.                                                                                                     |
| launch pack facts                                    | operator app record | Tell the assistant what was minted and what to prove next.                                                                                                                             |

For each birth environment (`candidate-a`, `preview`, `production`), the
minimum ExternalSecret is:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: <slug>-env-secrets
  namespace: cogni-<env>
  labels:
    app.kubernetes.io/part-of: cogni-secrets-substrate
    app.kubernetes.io/component: <slug>
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao-backend
    kind: ClusterSecretStore
  target:
    name: <slug>-env-secrets
    creationPolicy: Owner
    deletionPolicy: Retain
  dataFrom:
    - extract:
        key: <env>/<slug>
```

`ClusterSecretStore` has `path: cogni`, so the ExternalSecret extract key is
`<env>/<node>` even though the logical OpenBao path is
`cogni/<env>/<node>`.

## Value Routing Classes

Secrets use the authority model from `docs/spec/secrets-management.md`:
`origin` answers who can produce the value, `custody` answers which system is
authoritative, and `consumers` answers where it is rendered. The wizard may
write git shape for a consumer, but it never takes custody of secret bytes.

### Agent-generated app values

The wizard does not generate these directly. The `secret-materialize` lane
reads catalog metadata and writes missing values to OpenBao.

If a value is `source: agent`, generation belongs to the secrets substrate
materializer. The wizard can report that the new node needs materialization,
but it must not write a secret value into the PR or a saved wizard record.

### Derived values

Derived values are recomputed from repo state after the node appears in git.
The wizard should not store them as state. If a derived value embeds or agrees
with a secret, it must derive from OpenBao-owned inputs, not from VM `.env` or
GitHub Environment Secrets.

### Shared/operator environment values

Shared values come from the environment's existing authority, then fan out
through the catalog/provisioning model. The wizard does not copy them.

Concrete key-level classification is canonical in the YAML catalogs, with
contract boundaries in
[`secrets-classification.md`](../spec/secrets-classification.md#node-wizard-formation-contract).

Today the provisioner may denormalize some shared values into
`cogni/<env>/<node>` so a single `<node>-env-secrets` extract can feed the pod.
That is still a substrate write, not wizard custody.

If a required shared/vendor value is missing, `secret-materialize` fails loud.
Candidate flight must not accept the value as an input or invent it.

### Grafana and observability

Grafana is not a per-node wizard secret.

There are two different classes:

- D-tier parent inputs such as `GH_GRAFANA_URL` and
  `GH_GRAFANA_PARENT_SA_TOKEN`; these are provisioning-only inputs and never
  reach the VM or app pod.
- A1/B-tier child values minted or carried by the provisioner, such as
  `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, Loki, Prometheus, and PDC
  values.

The wizard should not mint a Grafana admin/root token or copy an operator token
into a node. If observability inputs are absent, node birth should still produce
valid substrate shape; the scorecard can mark observability incomplete without
blocking basic app launch.

### CI, repo, Compose, and local-only values

The wizard ignores these for v0 node birth:

- Compose-infra values unless the infra/provision lane owns the write. If a
  Compose-rendered value creates or supports a pod-facing dependency, its
  custody is OpenBao, not Compose.
- D-tier CI-only values.
- E-tier repo-level values.
- F-tier `.env.local` values.

These are environment or repository substrate concerns, not per-node birth
facts.

### Payments and custody values

Payment/wallet/signing keys are never baseline. A node receives them only when
its node spec/catalog explicitly opts into the relevant capability.

The wizard must not give every new node wallet, signing, custody, or trading
material. This is a hard custody boundary, not a convenience choice.

### Dual-plane values

Some generated values must also be mirrored to an external system. The canonical
example is `GH_WEBHOOK_SECRET`: it is `source: agent`, but also has
`syncTo: github-app-webhook`.

The right shape is:

1. The substrate generates the value.
2. The infra/secrets lane writes it to OpenBao.
3. The same owning lane syncs it to the GitHub App webhook config.
4. Candidate/app flight only asserts readiness; it does not repair the value.

The wizard must not turn dual-plane sync into human paste work.

## ExternalSecret And Overlay Contract

For ESO-enabled envs, every node-app secret reference in the generated overlay
must resolve to the ESO-owned target:

```
<slug>-env-secrets
```

The wizard must not generate or preserve:

```
<slug>-node-app-secrets
```

This includes:

- main container `envFrom`
- initContainer `envFrom`
- explicit `valueFrom.secretKeyRef.name` references, such as Doltgres migrator
  `DOLTGRES_URL`

App-flight substrate assertions are read-only. If they find a consumed Secret
with no Ready ExternalSecret, the fix belongs to the birth PR shape or the
secrets/provisioning lane, not the app-flight lane.

## Runtime Reconciliation Boundary

This design owns desired Git shape only. The runtime sequence is:

```
secret-materialize <env> <node>
  -> reconcile-substrate <env> <node>
  -> assert-substrate <env> <node>
  -> flight/promote/verify
```

In the target split, `secret-materialize` is the only phase that writes OpenBao
values for a new node. It preserves existing values, generates missing
`source: agent` node-local values, derives from non-secret and OpenBao-owned
inputs, inherits only explicitly granted environment values, and logs key names
only. Ordinary wizard nodes do not ask a human for per-node values; a missing
DAO/org value is an environment-bank precondition failure. `reconcile-substrate`
reads OpenBao and provisions dependent substrate: DBs/roles, edge routing,
`COGNI_NODE_DBS`, and the node ExternalSecret leaf. `assert-substrate` is
read-only.

### Phase custody contract (the load-bearing split)

The v0 `reconcile-node-substrate.sh` collapses materialize into reconcile and is
the anti-pattern this design retires. The split below is the merge target, not a
nice-to-have; each row is verified against current code.

| Phase                 | Token             | OpenBao       | VM `.env`            | Owns                                                                      |
| --------------------- | ----------------- | ------------- | -------------------- | ------------------------------------------------------------------------- |
| `secret-materialize`  | `<env>-writer`    | writes        | **never reads**      | generate/patch `source: agent` catalog keys; fail-loud on `source: human` |
| `reconcile-substrate` | `<env>-db-reader` | **read-only** | reads inventory only | DB roles (delegated to provisioners), edge, `COGNI_NODE_DBS`, ESO leaf    |
| `assert-substrate`    | reader            | read-only     | none                 | verify ESO Ready, ESO-only contract, DB/edge shape                        |

`secret-materialize` input is `infra/secrets-catalog.yaml` **only**. The writer
token is allowed in this phase and nowhere else; `reconcile-substrate` must hold
no OpenBao write capability. The token boundary and custody rule are the
canonical invariants in
[`secrets-management.md`](../spec/secrets-management.md#core-invariants) (15
`DB_ROLE_CREDS_ARE_OPENBAO_OWNED`, 16
`NODE_SECRET_MATERIALIZATION_PRECEDES_SUBSTRATE_RECONCILE`); this table is the
wizard-scoped view of them.

### Materialize execution model (batched, idempotent)

OpenBao is `ClusterIP` with no Ingress
([`openbao/values.yaml`](../../infra/k8s/argocd/openbao/values.yaml)), so the only
access from a CI runner is `ssh VM → kubectl exec openbao-0 → bao`. That single
constraint dictates the execution shape, and it has two non-negotiables:

- **No per-key SSH.** The retired v0 shape did ~6 round-trips _per key_ (ancestor
  scan + existing-read + metadata + write) over a fan-out of nodes — O(keys×nodes)
  SSH. The cost must be O(1) per node regardless of key count.
- **No re-materializing what exists.** A re-flight of a born node must write
  **nothing** — never regenerate or re-PATCH an already-present value (0 pod
  churn, no rotation).

The as-built `secret-materialize.sh` satisfies both with **read-once → diff →
write-missing-only**:

1. One prefetch reads the node path + ancestor paths (`node-template`, `operator`,
   `_shared`) into an on-disk cache; node-path existence is one `metadata get`.
2. All reads (`_resolve_node_value`'s existing-check, `inherit_shared_value`)
   serve from that cache — zero per-key SSH. Agent-generated keys skip the
   ancestor scan entirely (they are never inherited).
3. Only keys **absent** from the node path are resolved and accumulated; present
   keys are `unchanged` and skipped.
4. A single batched write (`bao kv put` for a new path, `patch` to merge an
   existing one) sends the missing keys as one JSON object on stdin — no secret
   value ever lands on a command line, and `patch` never clobbers sibling keys.

Net: token + prefetch + (one write only when something is missing). A re-flight is
`created=0 unchanged=N` with no write at all. Regression-guarded by the
idempotence assertion in `tests/secret-materialize.test.sh`.

**North star (staged, not yet built):** the SSH dependency exists _only_ because
the writer runs outside the cluster. Stage 2 moves materialize into an in-cluster
Job (ServiceAccount bound to `<env>-writer`) that talks to OpenBao over ClusterIP
— **zero SSH, zero fan-out**; the runner just applies the Job and waits. Stage 3
makes `source: agent` keys declarative via ESO `Password` generators + `PushSecret`
(`updatePolicy: IfNotExists`), so the cluster mints+stores them idempotently and
the imperative writer shrinks to derived/inherited values only.

### DB-credential custody (do not invent OpenBao keys)

All DB passwords are OpenBao-owned (secrets-management.md Invariant 15). They
differ only in how `secret-materialize` produces the value — never in custody:

- **`source: agent` (generate once):** `APP_DB_PASSWORD`,
  `APP_DB_SERVICE_PASSWORD`. Present in `secrets-catalog.yaml`; materialize
  generates when missing.
- **`source: derived` (compute from OpenBao input, write back to OpenBao):**
  `DOLTGRES_PASSWORD`, `DOLTGRES_READER_PASSWORD`, `DOLTGRES_WRITER_PASSWORD`, and
  `APP_DB_READONLY_PASSWORD`. The materializer derives each from the
  OpenBao-owned `POSTGRES_ROOT_PASSWORD` and writes it to `cogni/<env>/<node>`.
  These are not `source: human`, so materialize never fails loud on them.
- **DSN composites (`source: derived`):** `DATABASE_URL`,
  `DATABASE_SERVICE_URL`, `DOLTGRES_URL`. Composed from OpenBao-owned components,
  never read from VM `.env`.

Legacy state being purged, not the target: today the three `DOLTGRES_*` (and
`APP_DB_READONLY_PASSWORD` when unset) are derived deterministically **inside
`deploy-infra.sh` / `doltgres-provision`** and are absent from the catalog. A
value computed in a deploy script and never written to OpenBao is a parallel
store. The north-star fix moves that derivation into `secret-materialize`
(`source: derived` → OpenBao), and `deploy-infra` / `db-provision` /
`doltgres-provision` become **read-only consumers** that create each role
set-once from the OpenBao value. Neither substrate phase hand-rolls `CREATE
ROLE` for a password it derived itself.

### Inheritance: explicit `inheritFrom`, not blind scan

The v0 path inherits via a blind `TARGET_NODE -> node-template -> operator ->
_shared` OpenBao scan (`preload_value`). That silently grants a node any value an
ancestor happens to hold. Replace it with an explicit per-entry `inheritFrom`
catalog field (does not exist yet — proposed). Until it lands, **generate
per-node** rather than inherit caller-identity keys: `SCHEDULER_API_TOKEN`,
`BILLING_INGEST_TOKEN`, `GH_WEBHOOK_SECRET`, `INTERNAL_OPS_TOKEN`.

### Falsifying merge gate

Before either substrate PR merges, prove split-brain is dead: delete the VM
`.env` `APP_DB_PASSWORD`, run `secret-materialize` + `reconcile-substrate`, and
prove the node deploys green from OpenBao only. DB roles are unaffected (they
derive from `POSTGRES_ROOT_PASSWORD`). The lane stays gated to `candidate-a`
until materialize + reader are clean.

The wizard proves that a new node has:

- child repo ExternalSecret leaves for `candidate-a`, `preview`, and
  `production`;
- parent overlays for the same envs consuming `<slug>-env-secrets`;
- a non-secret publish log event naming the generated shape and pinned SHAs.

It does not prove that OpenBao already contains values at `cogni/<env>/<slug>`,
that ESO is Ready in a cluster, or that preview/production deploy branches have
synced node-domain leaves. Those are substrate and flight responsibilities. In
the current pipeline, candidate flight initializes the node submodule and syncs
`nodes/<slug>/k8s/external-secrets/candidate-a/` into the candidate deploy
branch; preview/production materialization and leaf reconciliation must be
proven by the env substrate lane.

## As-Built Anchors

- `nodes/operator/app/src/shared/node-app-scaffold/gens/envs.ts` defines the
  `candidate-a`, `preview`, and `production` node-birth matrix.
- `nodes/operator/app/src/shared/node-app-scaffold/gens/external-secret.ts`
  renders each child repo ExternalSecret leaf without any secret value.
- `nodes/operator/app/src/shared/node-app-scaffold/gens/overlay.ts` rewrites
  generated overlays from `<slug>-node-app-secrets` to `<slug>-env-secrets`.
- `nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts` writes the
  child repo leaves before opening the parent operator PR.
- `.github/workflows/candidate-flight.yml` initializes the submodule and copies
  the `candidate-a` node-domain ExternalSecret leaf into the candidate deploy
  branch.
- Generator and adapter tests assert the ExternalSecret name, target, extract
  key, and all-env overlay rewrite.
- `nodes/operator/app/src/app/api/v1/nodes/[id]/publish/route.ts` logs
  `feature.node_publish.secret_shape_generated` after the child repo and parent
  PR are pinned, with paths and SHAs but no secret values.

## Remaining Work

Wizard shape is proven: a fresh throwaway node (`gizmo`) produced a forked child
repo with all three ESO leaves and a parent birth PR whose overlays consume
`<slug>-env-secrets` with no legacy `<slug>-node-app-secrets` and no secret
values. The remaining work is the substrate engine, sequenced:

1. Keep `#1582` as the base: candidate-flight graph,
   `prepare-substrate-deploy-branch`, and provisioner-delegated DB creation.
2. Fold in only `#1579`'s contract/observability wrapper — structured redacted
   `target_substrate_reconcile_summary` to Loki, ESO-only hard fail on
   `<slug>-node-app-secrets`, read-only reconcile posture. Do not adopt its
   six-password `CREATE ROLE` logic. Close `#1579` once these are absorbed.
3. Add `secret-materialize <env> <node>` as a pre-reconcile step per the phase
   custody contract above. Neither PR has it yet; this is where "zero per-node
   human secrets" actually lives.
4. Make `reconcile-substrate` read-only: strip the `<env>-writer` mint, the VM
   `.env` reads, and the blind `preload_value` scan from
   `reconcile-node-substrate.sh`.
5. Pass the falsifying merge gate; keep the lane gated to `candidate-a`.
6. Extend the preview/production substrate lane so node-domain leaves from
   `nodes/<slug>/k8s/external-secrets/{preview,production}/` reach the
   corresponding deploy branch or cluster before those envs assert
   `<slug>-env-secrets`.
7. Fix the `please` `migrate` initContainer crash-loop so `verify-candidate` is
   green, not downstream-red (tracked separately; not a secret-shape blocker).

A known test-harness gap: generated AppSets pin `repoURL:
https://github.com/cogni-dao/cogni.git`, so a test-org node's overlay (added in
`cogni-test-org/cogni-monorepo`) is not what Argo reconciles. Correct for the
production parent (`cogni-dao/cogni`); flag for test-org E2E isolation.

## Non-Goals

- Building a generic secret management UI.
- Adding a fourth secret write entry point.
- Storing secret values in wizard database rows.
- Making app-flight accept secret values or repair secrets inside the read-only
  assertion phase.
- Moving all `_shared` secrets to owner-scoped paths; that is tracked by the
  broader secrets substrate migration.

## Knowledge Block Candidate

This content should be promoted into the operator knowledge hub as a compact
block, likely `node-wizard-secret-setting`, after review:

> The node wizard owns secret shape, not secret values. A wizard-created
> node-birth PR must generate ESO-first artifacts: overlays consume
> `<slug>-env-secrets`, and each
> `nodes/<slug>/k8s/external-secrets/{candidate-a,preview,production}/`
> directory contains one ExternalSecret extracting `<env>/<slug>` into that
> target. Agent-generated, derived, shared, Grafana, CI, Compose, DB, and
> dual-plane values remain owned by the secrets substrate. A new node's env
> runtime path is `secret-materialize` (OpenBao writes) →
> `reconcile-substrate` (DB/edge/ESO reads) → `assert-substrate` (read-only).
> Flight may orchestrate those phases, but it must not accept secret values or
> repair secrets inside the assertion phase. The wizard must never write secret
> values to git or save them as wizard state.
