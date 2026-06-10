---
id: node-app-scaling-architecture
type: research
title: "Node-App Scaling Architecture — honest scheduling + infra/app tiering to 50+ wizard-born nodes"
status: draft
trust: draft
summary: OSS-only, Cherry-only Pareto path from ~3 choking node-apps per co-resident VM to 20 → 50+ wizard-born node-apps — by making k3s scheduling honest, tiering the shared Compose stack off the app box, and scaling the app tier horizontally with k3s workers. Builds on the measured footprint in vm-pod-memory-efficiency.
read_when: Designing env capacity, deciding how the node-wizard scales, debugging node-app Pending/Insufficient-memory, or evaluating an infra-VM split vs bigger VMs.
owner: derekg1729
created: 2026-06-10
tags: [infra, capacity, kubernetes, scaling, architecture]
---

# Node-App Scaling Architecture

Design built on the measurements in
[`vm-pod-memory-efficiency`](2026-06-10-vm-pod-memory-efficiency.md). That doc is
the _what we measured_; this is the _what we should build_. Coordinate with the
in-flight provision-vs-deploy decoupling of `scripts/setup/provision-env-vm.sh`
(dev2) — the per-env membership SSOT (Step 0) lands inside that refactor.

## Outcome

Success is when the **node-wizard can mint 20 → 50+ node-apps and every one
schedules and serves `/readyz 200` with no per-env capacity surgery** — because
the app tier scales horizontally on _honest_ k3s scheduling and the heavy shared
infra is provisioned once, off the app box.

## The disease (root cause)

Every env VM co-hosts the shared Compose stack (`postgres`, `doltgres`,
`litellm`, `temporal` ×3, `redis`, `caddy`, `openfga`, alloy ≈ **2.8 GB**) _and_
the k3s node-app pods. **k3s reports the full VM RAM as `allocatable` — it cannot
see the 2.8 GB Compose already took** — so the scheduler over-commits and pods
land `Pending`/crash-loop. Density is both _capped_ and _dishonestly scheduled_.
Two amplifiers: rollout churn keeps 2 ReplicaSets/node (old won't drain until new
is Ready), and a pod stuck in `migrate`/`migrate-doltgres` init pins its 384Mi
init reservation forever while doing nothing.

Empirically (preview, 2026-06-10): `/readyz` only reached 200 after **deleting 9
over-committed node-apps** — memory _requests_ fell 95% → 18% and operator
scheduled. That delete is a band-aid; this design removes the disease.

## Approach — OSS-Pareto, staged by payoff

All four steps reuse infrastructure already in the repo (k3s, Argo CD, ESO +
OpenBao, the Compose stack, Cherry Servers). **No new vendor. No managed k8s.**

### Step 0 — Per-env node membership (SSOT) · cheapest waste removal

Stop deploying the full ~10-node catalog × every env. An env deploys only the
node-apps it needs (preview today: `operator`). Make the per-env set a single
SSOT — `nodes_for_env()` in `scripts/ci/lib/image-tags.sh` — and derive
DBs/DNS/overlays/verify/AppSet-apply from it (Gotcha 19). **Owner: dev2's
provision/deploy split** (SSOT function drafted; do not land in provision until
that design is set).

### Step 1 — Honest scheduling · no new VM

- **Account for Compose in k3s reservations.** Set `kube-reserved` /
  `system-reserved` / eviction thresholds so `allocatable` subtracts the ~2.8 GB
  Compose footprint. The scheduler stops over-committing; `Pending`/crash from
  over-schedule disappears.
- **Trim the `migrate` init request** (384Mi → profile actual peak, ~128–192Mi).
  Shrinks the scheduling reservation and the stuck-init waste.
- **Gate the `migrate-doltgres` init on Doltgres adoption.** Most nodes carry no
  `doltgres-schema` → a dead 384Mi init + a guaranteed crash-loop surface. Emit
  it only when the node has a Doltgres migration dir.
- **Tune rollout `maxUnavailable`/`maxSurge`** so a stuck new RS can't pin a
  second replica's RAM per node during deploys.

Realized density on a 6 GB box: ~3 → **~8–10**. Pure k3s config + kustomize
patches.

### Step 2 — Tier shared infra off the app box ⭐ · the structural win

A dedicated **infra VM** runs the Compose stack; **app VMs run only k3s +
node-apps** → `allocatable` becomes honest with zero reservation guesswork. The
shared infra scales with _total load_, not node count: per-node DBs are schemas
on one `postgres`/`doltgres` server, and one `litellm`/`temporal`/`redis` serves
all nodes fine at this scale. Density: `max_node_apps ≈ (VM_RAM − 0.7 k8s) /
req` → 6 GB app VM ≈ **~13**, 16 GB ≈ **~38**. Reuses the existing Compose stack
(relocated, not rebuilt) and the existing `ExternalName`/ContainerRuntimePort
portability that already abstracts in-VM service endpoints.

### Step 3 — Horizontal app tier · 50+

Join additional Cherry VMs as **k3s agents (workers)**. Argo already deploys the
apps; the scheduler spreads pods across workers with no per-node manifest change.
Capacity becomes a provisioning knob — add a worker when `allocatable` drops
below a threshold — not a redesign. 2 × 16 GB app workers (infra tiered off) ≈
**~76 node-apps**. Cherry-only, OSS-only.

## Invariants

<!-- CODE REVIEW CRITERIA -->

- [ ] HONEST_ALLOCATABLE: on any co-resident box, k8s `allocatable` must reflect
      non-k8s RAM (system-reserved accounts for Compose); no scheduler
      over-commit. (spec: this doc, Step 1)
- [ ] SHARED_INFRA_NOT_PER_NODE: node-apps share one
      `postgres`/`doltgres`/`temporal`/`litellm`/`redis`; never per-node infra
      instances — that is the thing that fundamentally does not scale.
- [ ] PER_ENV_MEMBERSHIP_IS_SSOT: an env's node set derives from one SSOT
      (`nodes_for_env`), not hand-maintained lists across the appset + overlay
      renderers + the wizard scaffolder. (Gotcha 19)
- [ ] BUILD_ONCE_PROMOTE_BY_DIGEST: app-tier scaling must not reintroduce
      downstream rebuilds. (spec: ci-cd, devops-expert)
- [ ] REPRODUCIBLE_IN_GIT: every capacity change lives in provision
      scripts/k3s config/k8s manifests — never ad-hoc `kubectl`/SSH. (spec:
      devops-expert)
- [ ] OSS_ONLY_CHERRY_ONLY: no managed k8s, no new vendor; k3s + Cherry only.
- [ ] SIMPLE_SOLUTION: leverages the existing Compose stack, Argo AppSets, and
      k3s multi-node — no bespoke control plane.

## Rejected alternatives

- **Managed k8s (EKS/GKE/AKS).** Vendor lock + spend for a 1-dev / 0-user MVP;
  k3s + Cherry already works and is reproducible. Re-evaluate only at real load.
- **Postgres/Temporal as in-cluster operators/StatefulSets.** Operationalizing
  stateful data planes inside k8s is high-complexity for zero benefit here;
  Compose-on-a-VM is boring and sufficient.
- **Vertical-only (one ever-bigger VM).** Caps out, can't reach 50+, single
  point of failure. Horizontal workers (Step 3) are the scale axis.
- **Per-node infra (each node its own DB server / temporal).** The canonical
  anti-pattern — cost and ops grow linearly with node count.
- **Operator-only-everywhere (the band-aid).** Caps density at 1 node/env;
  directly contradicts the wizard product (many nodes). Acceptable as a
  same-day unblock, never as the design.

## Files (high-level scope — future, sequenced)

- Modify: `scripts/ci/lib/image-tags.sh` — `nodes_for_env()` SSOT (Step 0; drafted).
- Modify: `scripts/setup/provision-env-vm.sh` — derive node set from the SSOT;
  k3s reservation flags (Steps 0–1). **dev2's lane** — do not edit until their
  provision/deploy design is set.
- New: infra-VM provisioner / split of the Compose stack off the app box (Step 2).
- Modify: node-template overlay — trim `migrate` init request; conditional
  `migrate-doltgres` init; rollout surge/unavailable (Step 1).
- Modify: k3s bootstrap (`infra/provision/cherry/k3s/`) — `kube-reserved` /
  `system-reserved` / eviction thresholds (Step 1); agent-join for additional
  workers (Step 3).

## Coordination

dev2 owns the provision-vs-deploy decoupling in `provision-env-vm.sh` and is
researching it now. This doc is the umbrella scaling architecture; their split is
the enabling refactor under Steps 0–2. The SSOT in `image-tags.sh` is drafted and
handed to that design — no provision edits land until we converge.
