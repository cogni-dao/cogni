---
id: design.operator-fleet-safety
type: design
title: "Operator Fleet Safety — block unsafe node specs before they starve an env"
status: draft
created: 2026-06-29
spec_refs:
  - ../spec/cicd-platform-boundary.md
  - ../spec/ci-cd.md
  - ../spec/merge-authority.md
  - ../spec/node-ci-cd-contract.md
  - ../research/2026-06-10-node-app-scaling-architecture.md
work_items:
  - story.5020
  - task.5055
  - task.5057
  - task.5056
---

# Operator Fleet Safety

## Outcome

A new node or rendered deploy spec cannot starve production capacity or break the
shared edge unnoticed. The operator must reject unsafe fleet changes before
Argo/AppSet apply, using normal PR -> candidate-a -> validation flow, without
production SSH and without inventing a parallel scheduler.

This is a safety design, not a dashboard design. A dashboard may display the
result later, but the gate must be machine-enforced before a human looks.

## Current incident shape

The 2026-06 production outage exposed two separate classes:

1. **Edge reliability:** shared Caddy can start/recreate before its admin API is
   ready. A reload attempted in that window can fail or leave hash state ahead of
   live config. PR #1880 fixes this narrow race by waiting for Caddy admin
   readiness before reload/hash persistence and by making Caddy reconcile changes
   select candidate substrate validation.
2. **Fleet admission:** prod could accept a node/deploy shape whose Kubernetes
   pod requests exceeded what the co-resident VM could honestly schedule. The
   existing gate is only a node count ceiling in
   `nodes/operator/app/src/features/nodes/capacity.ts`; it does not read rendered
   requests, rollout surge, init-container effective requests, or VM reservations.

These must not be collapsed into one PR. Edge hardening is a small incident fix;
fleet admission is the next platform design slice.

## Key decision: do not build a bespoke scheduler

Kubernetes scheduling remains the authority. The operator should not guess live
placement better than the scheduler. The operator should do two narrower things:

1. Make Kubernetes scheduling honest by declaring real requests, limits,
   rollout behavior, and kubelet/system reservations.
2. Fail PRs and operator write actions when the **rendered desired state** is
   already impossible or regressive against declared env budgets.

Use OSS tools and native Kubernetes policy wherever they fit:

| Need                           | Preferred primitive                                                             | Why                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Manifest schema validity       | `kubeconform` or equivalent existing k8s schema validation                      | Avoid hand-validating Kubernetes YAML.                                                            |
| Missing/unsafe resource fields | `kube-linter`, Polaris, or Kyverno/OPA policy                                   | Standard policy checks, not ad hoc shell greps.                                                   |
| Cogni aggregate env budget     | OPA/Conftest policy over rendered manifests plus env budget data                | The aggregate math is Cogni-specific, but declarative policy is better than bespoke CI branching. |
| Runtime backstop               | Kubernetes `ResourceQuota`, `LimitRange`, requests/limits, kubelet reservations | Cluster-native final guard if CI missed a path.                                                   |
| Live scheduling                | Kubernetes scheduler                                                            | Do not replace it.                                                                                |

The custom code should be glue: render Cogni's catalog/env intent, normalize the
inputs for a policy engine, and produce a clear operator error message.

## Boundary with node services and Shape B sidecars

This design must not block the operator roadmap where a node is a bundle that can
publish multiple deployable units. Another active implementation lane is adding
catalog support for remote-source nodes that publish additional artifacts
(`artifacts[]`), with Shape B pod-local sidecars as the first use case and
pay-gated services later.

Fleet safety should support that direction by evaluating the final rendered
Kubernetes pod shape, not by assuming one catalog row equals one app container.
That means sidecars, workers, and future node-owned services count when their
manifests are enabled for an env. The admission gate still does not invent
service semantics:

- Catalog fields may declare deployable artifacts and env allowlists.
- Kustomize overlays/generators own whether an artifact becomes a sidecar,
  worker Deployment, Service, Ingress, or nothing in that env.
- Resource-fit policy consumes the rendered manifests and reported artifact
  metadata. It does not decide how to wire the artifact.
- Promotion metadata must distinguish artifact keys from workload verification
  keys. A pod-local sidecar can have its own image digest and source SHA, but it
  must not appear to downstream gates as an independent routable app unless it
  also renders an independently verified workload.

Per the CI/CD freeze, a small catalog-driven extension to existing image
resolution/promotion scripts is acceptable only while it remains thin glue:
resolve `image_repository:sha-<sourceSha>` to digests and write those digests to
the existing overlay images. If support for node-added services grows into
health contracts, service routing, placement, scale, pay gates, or lifecycle
rules, that work moves to the typed operator deploy plane and the catalog/overlay
generators, not to more bash or workflow branching.

## Sources of truth

| Source                                                      | Owns                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/catalog/*.yaml`                                      | Node/service inventory, node ports, source repos, image targets.                                                                               |
| `infra/k8s/overlays/<env>/<node>/` and generators           | Desired Kubernetes manifests after rendering, including env membership and enabled sidecars/services.                                          |
| `infra/capacity/envs.yaml` (new)                            | Declared env capacity budget: allocatable memory/CPU, Compose reserve, kube/system reserve, edge reserve, required headroom, enforcement mode. |
| `docs/research/2026-06-10-node-app-scaling-architecture.md` | Measured baseline and staged scaling options.                                                                                                  |
| Kubernetes cluster state                                    | Runtime truth after apply; not the PR-time authority.                                                                                          |

`infra/capacity/envs.yaml` is intentionally git-owned. Provider APIs can enrich
it later, but CI and publish gates must be deterministic without calling Cherry.
It is not the source of truth for which nodes or services run in an env; that
comes from the catalog/rendered overlays. The capacity file declares budgets and
policy mode only.

Example shape:

```yaml
production:
  mode: ratchet # ratchet | strict
  allocatable:
    memoryMi: 6040
    cpuMilli: 4000
  reservations:
    composeMemoryMi: 2867
    kubeMemoryMi: 700
    edgeMemoryMi: 128
    requiredHeadroomMi: 300
    requiredCpuHeadroomMilli: 250
  rollout:
    includeMaxSurge: true
  measurement:
    source: docs/research/2026-06-10-node-app-scaling-architecture.md
    measuredAt: "2026-06-10"
```

The exact numbers should be measured and updated in the same PR that introduces
the file. Unknown values fail as `needs_measurement`, not as silent allow.

## Resource-fit model

The MVP evaluator consumes rendered Kubernetes manifests and an env budget, then
emits a deterministic report:

```json
{
  "env": "production",
  "mode": "ratchet",
  "allowed": false,
  "reason": "memory over budget by 512Mi including rollout surge",
  "budget": {
    "allocatableMemoryMi": 6040,
    "allocatableCpuMilli": 4000,
    "reservedMemoryMi": 3995,
    "reservedCpuMilli": 250,
    "requiredHeadroomMi": 300
  },
  "workloads": [
    {
      "kind": "Deployment",
      "name": "poly-node-app",
      "replicas": 1,
      "podRequestMemoryMi": 384,
      "podRequestCpuMilli": 200,
      "rolloutExtraReplicas": 1,
      "effectiveMemoryMi": 768,
      "effectiveCpuMilli": 400
    }
  ]
}
```

For each pod template:

- App-container request = sum of all regular container requests, per resource.
- Init-container request = max init-container request, per resource.
- Pod effective request = max(app-container request, init-container request),
  per resource, matching Kubernetes scheduling behavior.
- Deployment effective replicas = desired replicas plus rollout surge when the
  rollout strategy can temporarily schedule an extra pod.
- Missing memory or CPU requests are a policy failure. A missing request is not
  zero.

For each env:

```
availableMemory = allocatableMemory
  - composeMemoryReserve
  - kubeMemoryReserve
  - edgeMemoryReserve
  - requiredMemoryHeadroom

availableCpu = allocatableCpu
  - reservedCpu
  - requiredCpuHeadroom

fit = totalRenderedEffectiveMemory <= availableMemory
  AND totalRenderedEffectiveCpu <= availableCpu
```

In `ratchet` mode, a PR fails only when it increases an existing overage or adds
a new unfit workload. The baseline is rendered `origin/main`, not a checked-in
report. CI should publish both baseline and PR JSON reports as artifacts so the
decision is auditable without making a generated report into policy truth. In
`strict` mode, any overage fails.

## Enforcement points

### 1. PR CI ratchet

Add one check that renders the impacted env/node manifests and evaluates them
against `infra/capacity/envs.yaml`. Use OPA/Conftest for the aggregate env
budget policy because it can evaluate rendered manifests plus budget data plus
the `origin/main` baseline as arbitrary structured input. Kyverno CLI remains a
good future companion for Kubernetes-native admission-style rules, but it is not
the first MVP engine for cross-workload budget math.

Acceptance:

- A fixture that adds an over-budget node fails.
- A fixture that only reduces requests passes.
- A fixture with missing memory or CPU requests fails.
- A fixture with a sidecar or second container counts that container's requests.
- A fixture with rollout surge counts the temporary extra replica.
- The output is JSON plus a short markdown summary suitable for a PR comment.

This is the first implementation of `task.5057` because it is non-mutating and
catches regressions before any runtime write.

### 2. Node publish gate

Replace or extend the count-only gate in
`nodes/operator/app/src/app/api/v1/nodes/[id]/publish/route.ts` with the same
resource-fit evaluator before the operator authors the node-formation PR.

The current count ceiling remains a temporary fallback while env budget data is
incomplete, but it is not the final policy.

Acceptance:

- Under budget: publish proceeds and opens the node PR.
- Over budget: publish returns 409 with env, resource, projected request, budget,
  and suggested next action.
- No GitHub/DoltHub writes happen after a failed gate.

### 3. Promote/apply precondition

Before candidate/preview/production writes deploy intent or applies AppSets,
run the same resource-fit check on the rendered target state.

This must reuse existing flight/promote seams. Do not add a new deploy workflow.
Per `cicd-platform-boundary.md`, new platform behavior belongs in typed
operator/control-plane code or declarative policy, not a new bash brain.

Clean seam for the MVP:

- Add a pure report/policy entrypoint that can render or consume already-rendered
  manifests for `{env, targets}` and run the Conftest policy.
- Existing workflows may call that entrypoint as a single guard before digest
  promotion or AppSet apply. The workflow passes paths and env/target inputs; it
  does not contain policy branches or resource math.
- Existing shell scripts may remain file movers/callers. They must not grow
  service placement rules, pay-gate behavior, or health-contract logic.

Acceptance:

- Candidate/prod promote of an unsafe rendered state fails before Argo/AppSet
  apply.
- Failure message names the env/node/resource blocker.
- Safe app-only digest promotions are not blocked by unrelated workloads that
  are not rendered/enabled in the target env.

## ComputeResourcePort boundary

`ComputeResourcePort` currently reads provider balances through
`balances(): Promise<readonly ComputeBalance[]>`. That is useful for funding and
runway, but it is not an admission controller.

For fleet safety:

- The admission gate must not depend on live Cherry API availability.
- The MVP does not need `provision()`, `release()`, or `settle()`.
- A future read extension may expose provider-agnostic VM inventory/capacity
  snapshots, but the gate still compares rendered Kubernetes demand against a
  git-owned env budget.

This keeps provider concerns behind the adapter. Cherry and Akash details must
not leak into CI policy, deploy workflows, or dashboard code.

This still points toward the roadmap: an AI operator should eventually see
per-env capacity, deny unsafe deployments, recommend the next action, and then
use typed operator capabilities to add/resize VMs or adjust deployments for
nodes. The denial reason from this MVP should therefore be machine-readable
enough to feed that future loop, but the MVP stops at deterministic admission and
does not provision compute.

## Edge observability slice

PR #1881 is useful but separate. It changes Caddy logs from container file output
to stdout so Alloy/Docker can ship `{service="caddy", env="<env>"}` to Loki.

Ship criteria for #1881:

- Rebase after #1880 lands.
- Run normal PR checks.
- Run `candidate-flight-infra.yml` against candidate-a, because this is
  `infra/compose/**` and not an app digest flight.
- Generate or observe a Caddy edge request.
- Post `/validate-candidate` with a Loki query showing Caddy log readback.

PR #1881 improves observability for future incidents. It does not block the
resource-fit admission design unless we need Caddy logs to validate a specific
edge PR.

## Runtime backstops

The PR-time gate is not enough. The cluster should also fail closed:

- Kubelet/system reservations account for the Compose stack on co-resident VMs.
- Every rendered app, sidecar, worker, and init container has memory and CPU
  requests.
- Optional `ResourceQuota`/`LimitRange` policies prevent unbounded namespaces.
- Argo health and `/version.buildSha` remain deploy proof, not `/readyz` alone.

Runtime rejection is a safety net, not the primary UX. The operator should tell
the contributor before Argo creates a red application.

## Non-goals

- No new deploy/promote/provision workflows.
- No production SSH as validation or repair.
- No dashboard-only safety claim.
- No bespoke Kubernetes scheduler.
- No provider-specific Cherry capacity logic in CI.
- No full multi-VM placement optimizer in the MVP.

## Pareto sequence

1. Merge #1880: Caddy admin wait + candidate substrate selection.
2. Write/review this design and settle the OSS policy-engine choice.
3. Implement `task.5057` as one resource-fit admission PR:
   - env budget file,
   - rendered-manifest policy check with OPA/Conftest,
   - CI ratchet,
   - publish gate,
   - promote/apply precondition if it stays small; otherwise split after the
     ratchet is green.
4. Let the active multi-artifact/sidecar lane proceed only if it stays
   catalog-driven image resolution/promotion glue. If it grows into service
   lifecycle or placement behavior, pause and move that part to typed deploy
   plane/generator work.
5. Rebase and ship #1881 if Caddy log validation is still low-churn.
6. Add machine scorecards/alerts/dashboard only after the admission gate exists.

## Review questions

- What exact `infra/capacity/envs.yaml` schema is enough for production without
  pretending to solve multi-VM placement?
- Which workloads are in the first strict cohort: operator, beacon, poly only,
  or every enabled production node?
- What typed deploy-plane/generator shape should own vNext pay-gated node
  services once `artifacts[]` is no longer only image-promotion glue?

## Links

- [CI/CD Platform Boundary](../spec/cicd-platform-boundary.md)
- [CI/CD Spec](../spec/ci-cd.md)
- [Merge Authority](../spec/merge-authority.md)
- [Node CI/CD Contract](../spec/node-ci-cd-contract.md)
- [Node-App Scaling Architecture](../research/2026-06-10-node-app-scaling-architecture.md)
