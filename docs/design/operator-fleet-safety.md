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

## Status — live (2026-06-30) — THIS is the doc tracking the fleet-reliability work

The keystone (a continuously-reconciled + **prunable** AppSet layer — the prerequisite
for safe per-env decommission and load-shedding) is **merged and validated**. Capacity
_enforcement_ (`ResourceQuota`) stays deferred until the env is right-sized — see
[pm.candidate-a-quota-wedge](../postmortems/pm.candidate-a-quota-wedge.2026-06-29.md).

| Rung                                                                                         | What                      | State                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keystone — per-env app-of-apps** (closes the decommission prune-gap; continuous reconcile) | #1893 (merged `9235e102`) | 🟢 **MERGED** · validated candidate-a (live app-of-apps, Synced/Healthy) **+ preview** (reconcile-appset operator+scheduler-worker succeeded via new path) · prod promote in flight |
| CI/CD spec DRY (12→3 SSOT, −2k lines)                                                        | #1894                     | 🟡 open                                                                                                                                                                             |
| SLA #1 — honest capacity (kubelet `system-reserved` on RUNNING nodes)                        | provisioning              | 🔴 not applied (`alloc==cap`)                                                                                                                                                       |
| SLA #2 — deterministic admission (`ResourceQuota` after right-size)                          | —                         | 🟡 deferred (would wedge an over-subscribed env)                                                                                                                                    |
| SLA #4 — failure isolation (`/readyz` decoupled from scheduler-worker)                       | —                         | 🔴 still coupled — caused the 06-29 cascade AND the only preview-promote failure                                                                                                    |
| SLA #5 — one-action remediation (`OperatorDeployPlanePort.remove` verb)                      | next task                 | ⚪ unblocked by the keystone; not built                                                                                                                                             |
| SLA #6 — GitOps + observable (operator fleet UI, story.5013)                                 | —                         | ⚪ data plane exists (deploy-state, balances, Mimir); no aggregate page                                                                                                             |

### The deployment-reliability contract (the SLA we are building toward)

1. **Honest capacity** — each env VM's allocatable reflects real headroom (kubelet reservation applied; infra eventually split off the node VM).
2. **Deterministic admission** — a deploy lands only if its rendered requests fit the honest budget; fail-closed, loud.
3. **Existing deploys protected** — a new/oversized deploy can never starve a running one.
4. **Failure isolation** — one node/service degrading cannot cascade the fleet.
5. **One-action remediation** — load shed via operator-app per-env decommission (GitOps prune).
6. **GitOps + observable** — no manual kubectl; capacity/health visible in the operator UI.

**Critical path:** keystone ✅ → decommission verb → right-size candidate-a → kubelet honesty → `ResourceQuota` → `/readyz` decouple → fleet UI.

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

## 5. This slice (candidate-a) — REVERTED after the 2026-06-29 incident

> ⛔ **REVERTED.** The candidate-a `ResourceQuota`/`LimitRange` below was shipped,
> then **reverted** the same day. Enforcing a memory ceiling on an **already
> over-subscribed** env (§2) is unsafe: a flight's rolling-update **surge pod** was
> **rejected by the quota** → scheduler-worker rollout wedged → `/readyz` coupling
> cascaded the whole candidate-a fleet to **502**. It was also applied **manually**
> (anti-pattern). **Lesson: never enforce a capacity ceiling before the env is
> right-sized and the kubelet reservation is honest.** Admission enforcement is
> re-sequenced to AFTER §2 (honest allocatable) + decommission-driven right-sizing.

The (now reverted) shape, kept for the record:

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

This is the `OperatorDeployPlanePort.remove` **"Phase 1"** referenced in
[operator-managed-deployments.md](./operator-managed-deployments.md).

> ⚠️ **The teardown does NOT actually work today** — `operator-managed-deployments.md`'s
> claim that dropping `envs[]` makes "Argo prune the pods" is **aspirational, not real**
> (verified 2026-06-29). `render-node-appset.sh` deletes the per-node AppSet **file**
> from git, but **nothing re-applies the bootstrap `infra/k8s/argocd/kustomization.yaml`**
> after a catalog edit — flight/promote apply only the _current_ node's AppSet, never the
> aggregate. Plain `kubectl apply` never deletes absent resources, so the orphaned
> AppSet + its Application **linger and keep the pods running**. DNS/Caddy reconcile is
> **forward-only** (no delete). So decommission has a **delivery gap**.

The **prerequisite** (the keystone task — see §10) is to make the AppSet layer
**continuously reconciled**: an **app-of-apps Argo Application** over
`infra/k8s/argocd/` so a removed AppSet is **auto-pruned**. This _also_ makes deploys
more reliable — today AppSet changes only land at bootstrap. **Only after** the
prune-gap closes is decommission real; then the **gap** is:

- the **app-of-apps prune fix** (keystone — makes any teardown actually prune),
- the **typed verb** (`OperatorDeployPlanePort.remove`) that commits the `envs[]` edit
  via the operator GitHub App,
- **reverse DNS / Caddy de-reconcile** (both are forward-only today),
- a **`node.decommission_env` OpenFGA relation** (needs OpenFGA re-bootstrap), and
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

## 10. Pareto sequence (re-ordered after the 2026-06-29 incident)

Reliability-first. The keystone is closing the **AppSet prune-gap** (§6b): it is what
makes the deploy layer self-healing AND makes any teardown actually prune — without it,
decommission is fiction and capacity can never be reclaimed.

| #   | Step                                                                              | State                |
| --- | --------------------------------------------------------------------------------- | -------------------- |
| 1   | Revert #1886 bespoke predictor to baseline                                        | ✅ done              |
| 2   | Revert the premature candidate-a quota slice (incident landmine) + this doc       | ◀ this PR           |
| 3   | **app-of-apps over `infra/k8s/argocd/`** — continuous reconcile + AppSet prune    | 🎯 keystone, next PR |
| 4   | `decommission-env` (typed verb + reverse DNS/Caddy + OpenFGA + UI) — needs #3     | ⏳ then              |
| 5   | Right-size candidate-a (decommission non-essential nodes) + apply kubelet reserve | ⏳ then (uses #3/#4) |
| 6   | Re-introduce admission (`ResourceQuota`) — ONLY after #5 makes the env honest     | ⏳ after right-size  |
| 7   | preview/prod env quotas                                                           | ⏳ follow-up         |
| 8   | Fleet UI v0                                                                       | ⏳ story.5013        |

## Related

- [Operator-Managed Deployments](./operator-managed-deployments.md) — the
  `OperatorDeployPlanePort.remove` Phase 1 that REMEDIATION (§6b) reuses.
- [CI/CD Spec](../spec/ci-cd.md) — Argo-owns-reconciliation; git-as-steering-wheel.
- [CI/CD Platform Boundary](../spec/cicd-platform-boundary.md) — the `DeployCapability`
  / `ComputeResourcePort` seams that formation routing (§7) builds on.
- [VM/pod memory efficiency](../research/2026-06-10-vm-pod-memory-efficiency.md) —
  the measured per-pod footprint that informs honest right-sizing (§5 step 5).
