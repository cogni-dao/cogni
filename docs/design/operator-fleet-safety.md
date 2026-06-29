---
id: design.operator-fleet-safety
type: design
title: "Operator Fleet Safety — honest env capacity via native Kubernetes, not a bespoke scheduler"
status: draft
created: 2026-06-29
spec_refs:
  - ../spec/ci-cd.md
  - ../spec/cicd-platform-boundary.md
related:
  - ./operator-managed-deployments.md
  - ../research/2026-06-10-vm-pod-memory-efficiency.md
work_items:
  - story.5020
  - task.5057
---

# Operator Fleet Safety

> A node or deploy spec must never silently starve an environment of capacity.
> This is the refined roadmap that **replaces** the reverted #1886 bespoke
> resource-fit predictor. It supersedes the earlier version of this file.

## Outcome

A node/deploy spec **cannot starve an env's capacity unnoticed**. Enforcement is
done by **native Kubernetes primitives** (not a bespoke scheduler), it lands via
the **normal PR → candidate-a → validation** loop, and it requires **no prod SSH**.
When a workload doesn't fit, the failure is honest and loud (`Pending` /
Argo `Degraded`), never a silent OOM and never a dead-end 409.

## Why #1886 was reverted

#1886 shipped a 2,475-line `@cogni/deploy-policy` package that **reimplemented
kube-scheduler math** in TypeScript (a 671-line evaluator), wrapped it in
Rego/Conftest, and bolted it onto CI + flight + promote + a publish gate. It was
reverted in full. The corrected design below does the same job with primitives the
cluster already enforces, and removes the structural mistakes (double-bookkeeping,
per-target guards that can't aggregate, a publish hard-block that bricked node
formation).

## 1. Safety floor — already shipped (DONE)

These are **live in the base manifests and provisioning today** — not vNext:

| Mechanism                       | Where                                                       | Value                        |
| ------------------------------- | ----------------------------------------------------------- | ---------------------------- |
| App container requests          | `infra/k8s/base/node-app/deployment.yaml`                   | `memory: 384Mi`, `cpu: 200m` |
| Migrate init-container requests | `infra/k8s/base/node-app/deployment.yaml`                   | `memory: 256Mi`, `cpu: 100m` |
| kubelet `system-reserved`       | `infra/provision/cherry/base/{bootstrap.yaml,variables.tf}` | `memory=2900Mi`              |
| kubelet `eviction-hard`         | `infra/provision/cherry/base/{bootstrap.yaml,variables.tf}` | `memory.available<350Mi`     |

Because every workload declares `resources.requests`, over-commit surfaces as an
honest **`Pending`** pod the scheduler refuses to place — not an OOM kill of a
running peer. The kubelet reservation + eviction floor keep the node OS alive
under pressure. This floor is the foundation everything else builds on.

## 2. FINDING — candidate-a allocatable is dishonest

Measured **2026-06-29** on the running candidate-a node:

- `capacity == allocatable == 6062896Ki (~5921Mi)` — the kubelet `system-reserved`
  arg is **NOT in effect on the running node**. The reservation predates the
  bootstrap arg, so the node was never restarted under it. Allocatable is
  reporting raw RAM, minus nothing.
- Aggregate `cogni-candidate-a` container memory **requests = 2816Mi** (init-peak
  sum **3456Mi**) across **11 pods**.
- The VM also runs a **~2.8GB Compose stack** outside k8s, leaving roughly
  **~3000Mi honestly schedulable**.

So candidate-a is **already over-subscribed against honest capacity**: ~2.8–3.5GB
of k8s requests against ~3GB of real headroom. Applying the kubelet reservation to
**running** nodes + right-sizing the fleet is a **prerequisite to an honest quota**.
That is a **provisioning follow-up**, not this PR — but the dishonest allocatable
is why this PR ships a generous ceiling rather than the honest target (see §6).

## 3. Key decision — do NOT build a bespoke scheduler

Enforcement is **native Kubernetes `ResourceQuota` + `LimitRange`** on the shared
`cogni-<env>` namespace. Verified: **every node overlay and the Argo AppSet
destination target a single `cogni-<env>` namespace**, so **one `ResourceQuota`
caps the whole fleet's aggregate requests** for that env. It is cluster-
authoritative, fail-closed, and loud (over-budget applies surface as Argo
`Degraded`).

### Map need → primitive

| Need                                 | Preferred OSS primitive                     |
| ------------------------------------ | ------------------------------------------- |
| Manifest is valid k8s                | `kubeconform`                               |
| Every container declares requests    | `LimitRange` (runtime) + `kube-linter` (CI) |
| Aggregate per-env budget is enforced | `ResourceQuota`                             |
| Runtime backstop under pressure      | kubelet `system-reserved` + `eviction-hard` |
| Live scheduling / bin-packing        | the **kube-scheduler** (already running)    |

### Explicitly rejected (from #1886)

- **The 671-line TS evaluator** — reimplements scheduler math the cluster already does.
- **Rego-over-a-TS-report** — double-bookkeeping; the report and Rego can disagree.
- **Per-`(env,target)` flight/promote guards** — structurally **cannot aggregate**:
  deploy branches are per-target, so no single guard ever sees the env total.
- **The publish hard-block** — it **bricked node formation** by denying the first
  wizard node (a node with no env can't fit any env). Formation must route, not block.

## 4. One SSOT for the VM budget

Capacity numbers derive from **Terraform** (`system_reserved_memory` /
`eviction_hard_memory` in `infra/provision/cherry/base/variables.tf`) **or** from
**measured allocatable** — never from a parallel hand-maintained file. The reverted
`infra/capacity/envs.yaml` had already **drifted from Terraform by ~745Mi**; it was
deleted in the revert and must not return. Two sources of truth for capacity is the
bug, not the feature.

## 5. This PR's slice (candidate-a)

A **`LimitRange`** and a **`ResourceQuota`** for candidate-a, both in
`infra/k8s/env/candidate-a/`, synced by a **dedicated Argo Application**:

| Object          | Setting                                                  | Intent                                                                                  |
| --------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `LimitRange`    | `defaultRequest` `memory: 256Mi`, `cpu: 100m`; low `min` | Guarantee **every** container has requests (closes the gap a stray manifest could open) |
| `ResourceQuota` | `~5600Mi` memory / `~5500m` cpu                          | **Generous runaway-ceiling**, NOT the honest target                                     |

The quota is deliberately a **runaway ceiling, not the honest cap (~3000Mi)**:
candidate-a is already over-subscribed (§2), so an honest quota today would
**wedge live rollouts**. The ceiling catches a genuine runaway while leaving room
for the existing fleet. Sizing **ratchets DOWN** as kubelet honesty (§2) and
right-sizing land. **preview/prod env-apps are deferred** follow-ups.

## 6. The capacity-control loop (the operator's eventual fleet management)

Three legs. Only ADMISSION lands in this PR.

### (a) ADMISSION — `ResourceQuota` blocks over-budget applies _(this PR)_

The quota refuses applies that would exceed the env budget; Argo reports
`Degraded`. Cluster-authoritative and fail-closed.

### (b) REMEDIATION — atomic per-env decommission frees budget _(next task)_

This is the `OperatorDeployPlanePort.remove` **"Phase 1"** already specified in
[operator-managed-deployments.md](./operator-managed-deployments.md) — see that doc
for the full design; it is **not re-specified here**. The teardown **mechanism
already works**: drop an env from the catalog `envs[]` → the per-node AppSet stops
rendering → Argo `prune:true` removes the pods → reversible by re-adding the env.

The **gap** (the next task) is:

- the **typed verb** (`OperatorDeployPlanePort.remove`),
- **reverse DNS / Caddy de-reconcile** so the apex/edge stops routing the dead env,
- a **`node.decommission_env` OpenFGA relation**, and
- a **per-env UI action** in
  `nodes/operator/app/src/features/nodes/deployments/NodeDeployments.tsx`.

### (c) OBSERVATION — operator fleet UI _(story.5013)_

The fleet read model is deferred to story.5013. The **per-node deploy-state read
panel already ships** (`NodeDeployments.tsx` → `GET /api/v1/nodes/{id}/deploy-state`).

## 7. Capacity-aware formation = ROUTE, never dead-end (the 10x vision)

When a node **doesn't fit** an env, the operator must offer a **path**, never a bare
409:

1. **Plan more compute** — via the typed `DeployCapability` / `ComputeResourcePort`
   seam (Cherry → Akash), or
2. **Offer decommission** of a stale env (§6b) to free budget.

This is the explicit **contrast with the reverted publish hard-block**, which
returned no path and so bricked the first wizard node. Keep the routing seam now;
build the auto-funding planner later.

## 8. Fleet UI seams that already exist

The fleet UI (story.5013) is mostly an **aggregation** over seams that already ship:

| Seam                              | Surface                                                |
| --------------------------------- | ------------------------------------------------------ |
| `ComputeResourcePort.balances()`  | `GET /api/v1/compute/balances`                         |
| `DeployCapability.getDeployState` | `GET /api/v1/nodes/{id}/deploy-state`                  |
| Node inventory                    | `nodes` table + `GET /api/v1/nodes`                    |
| Per-env intent                    | catalog `envs[]` + overlays                            |
| Live mem/cpu/OOM                  | Alloy → cAdvisor + node-exporter → Grafana Cloud Mimir |
| Per-env headroom                  | the new `ResourceQuota` (used vs hard) _(this PR)_     |

**Missing** = a **per-env / per-VM aggregation read model** + the **fleet page**
itself. Those are story.5013, not this PR.

## 9. Non-goals

- No bespoke scheduler / resource-fit predictor.
- No new deploy / promote / provision workflow.
- No prod SSH.
- No parallel capacity file (capacity SSOT = Terraform or measured allocatable).
- No publish hard-block.

## 10. Pareto sequence

| #   | Step                                                            | State                     |
| --- | --------------------------------------------------------------- | ------------------------- |
| 1   | Revert #1886 to baseline                                        | ✅ done                   |
| 2   | This design doc                                                 | ◀ this PR                |
| 3   | candidate-a `LimitRange` + ceiling `ResourceQuota` via Argo app | ◀ this PR                |
| 4   | `decommission-env` (typed verb + DNS/Caddy + OpenFGA + UI)      | ⏳ next task              |
| 5   | Apply kubelet reservation to running nodes + right-size fleet   | ⏳ provisioning follow-up |
| 6   | preview/prod env quotas                                         | ⏳ follow-up              |
| 7   | Fleet UI v0                                                     | ⏳ story.5013             |

## Related

- [Operator-Managed Deployments](./operator-managed-deployments.md) — the
  `OperatorDeployPlanePort.remove` Phase 1 that REMEDIATION (§6b) reuses.
- [CI/CD Spec](../spec/ci-cd.md) — Argo-owns-reconciliation; git-as-steering-wheel.
- [CI/CD Platform Boundary](../spec/cicd-platform-boundary.md) — the `DeployCapability`
  / `ComputeResourcePort` seams that formation routing (§7) builds on.
- [VM/pod memory efficiency](../research/2026-06-10-vm-pod-memory-efficiency.md) —
  the measured per-pod footprint that informs honest right-sizing (§5 step 5).
