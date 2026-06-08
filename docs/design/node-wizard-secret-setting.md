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
  -> provision/reconcile lane
  -> OpenBao path cogni/<env>/<node>
  -> ExternalSecret dataFrom.extract
  -> k8s Secret <node>-env-secrets
  -> Deployment envFrom
```

The wizard may trigger or report the owning lane, but it must not create a
parallel source of truth. Creating all-env shape is not the same as proving
all-env values exist; value materialization is validated by the
provision/reconcile and flight lanes.

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

### Agent-generated app values

The wizard does not generate these directly. The provision/reconcile lane reads
catalog metadata and writes values to OpenBao.

Examples:

- `AUTH_SECRET`
- `CONNECTIONS_ENCRYPTION_KEY`
- `INTERNAL_OPS_TOKEN`
- `METRICS_TOKEN`
- `GH_WEBHOOK_SECRET`
- per-node DB DSNs and passwords
- `APP_BASE_URL`
- `NEXTAUTH_URL`

If a value is `source: agent`, generation belongs to the secrets substrate
generator or provisioner. The wizard can report that the new node needs seed
coverage, but it must not write a secret value into the PR or a saved wizard
record.

### Derived values

Derived values are recomputed from repo state after the node appears in git.
The wizard should not store them as state.

Examples:

- `COGNI_NODE_DBS`
- `COGNI_NODE_ENDPOINTS`
- per-node database names such as `cogni_<slug>`
- node-host-derived URLs when the provisioner has the environment domain

### Shared/operator environment values

Shared values come from the environment's existing authority, then fan out
through the catalog/provisioning model. The wizard does not copy them.

Examples:

- `OPENROUTER_API_KEY`
- `EVM_RPC_URL`
- `POSTHOG_API_KEY`
- `POSTHOG_HOST`
- `LANGFUSE_*`
- non-custody GitHub App/OAuth configuration

Today the provisioner may denormalize some shared values into
`cogni/<env>/<node>` so a single `<node>-env-secrets` extract can feed the pod.
That is still a substrate write, not wizard custody.

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

- B-tier Compose-infra values unless the infra/provision lane owns the write.
- D-tier CI-only values such as `VM_HOST` and `SSH_DEPLOY_KEY`.
- E-tier repo-level values such as `GHCR_DEPLOY_TOKEN` and
  `CHERRY_AUTH_TOKEN`.
- F-tier `.env.local` values.

These are environment or repository substrate concerns, not per-node birth
facts.

### Payments and custody values

Payment/wallet/signing keys are never baseline. A node receives them only when
its node spec/catalog explicitly opts into the relevant capability.

The wizard must not give every new node:

- `PRIVY_APP_SECRET`
- `PRIVY_SIGNING_KEY`
- user-wallet signing material
- custody or trading keys

This is a hard custody boundary, not a convenience choice.

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

This design owns desired Git shape only. It proves that a new node has:

- child repo ExternalSecret leaves for `candidate-a`, `preview`, and
  `production`;
- parent overlays for the same envs consuming `<slug>-env-secrets`;
- a non-secret publish log event naming the generated shape and pinned SHAs.

It does not prove that OpenBao already contains values at `cogni/<env>/<slug>`,
that ESO is Ready in a cluster, or that preview/production deploy branches have
synced node-domain leaves. Those are substrate and flight responsibilities. In
the current pipeline, candidate flight initializes the node submodule and syncs
`nodes/<slug>/k8s/external-secrets/candidate-a/` into the candidate deploy
branch; preview/production value and leaf reconciliation must be proven by the
env substrate lane.

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

1. Use a fresh throwaway node to prove candidate-a publish logs
   `feature.node_publish.secret_shape_generated`, the child repo contains all
   three ExternalSecret leaves, the parent PR overlays consume
   `<slug>-env-secrets`, and candidate flight materializes the candidate-a leaf
   without manual secret bridging.
2. Extend or verify the preview/production substrate lane so node-domain leaves
   from `nodes/<slug>/k8s/external-secrets/{preview,production}/` reach the
   corresponding deploy branch or cluster before those envs assert
   `<slug>-env-secrets`.

## Non-Goals

- Building a generic secret management UI.
- Adding a fourth secret write entry point.
- Storing secret values in wizard database rows.
- Making app-flight mutate OpenBao, GitHub secrets, or Compose runtime state.
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
> target. Agent-generated, derived, shared, Grafana, CI, Compose, and
> dual-plane values remain owned by the catalog/provision/reconcile secrets
> substrate. App flight may assert the consumed Secret and ExternalSecret, but
> it must not seed or repair them. The wizard must never write secret values to
> git or save them as wizard state.
