---
id: node-app-scaling-architecture
type: research
title: "Node-App Scaling Architecture — honest scheduling + infra/app tiering to 50+ wizard-born nodes"
status: draft
trust: draft
summary: OSS-only, Cherry-only Pareto path from ~3 choking node-apps per co-resident VM to 20 → 50+ wizard-born node-apps — by making k3s scheduling honest, tiering the shared Compose stack off the app box, and scaling the app tier horizontally with k3s workers. Inlines its own measured footprint baseline (preview, 2026-06-10).
read_when: Designing env capacity, deciding how the node-wizard scales, debugging node-app Pending/Insufficient-memory, or evaluating an infra-VM split vs bigger VMs.
owner: derekg1729
created: 2026-06-10
tags: [infra, capacity, kubernetes, scaling, architecture]
---

# Node-App Scaling Architecture

This is the _what we should build_. Coordinate with the in-flight
provision-vs-deploy decoupling of `scripts/setup/provision-env-vm.sh` (dev2) —
the per-env membership SSOT (Step 0) lands inside that refactor.

### Measured footprint (preview, 2026-06-10) — self-contained baseline

Every density number below derives from these measurements; they are inlined so
this design stands on its own evidence, not a dangling citation.

| Measurement                                    | Value                   | Source (verifiable now)                                                                           |
| ---------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| Compose stack RSS on a preview VM              | **≈ 2.8 GB**            | `docker stats` on the preview VM (postgres/doltgres/litellm/temporal×3/redis/caddy/openfga/alloy) |
| node-app `migrate` init **request**            | **384Mi** (limit 1Gi)   | `infra/k8s/base/node-app/deployment.yaml:57`                                                      |
| node-app `app` container **request**           | **256Mi** (limit 512Mi) | `infra/k8s/base/node-app/deployment.yaml:99`                                                      |
| Pod scheduling reservation `= max(init, app)`  | **384Mi/pod today**     | K8s effective-request rule                                                                        |
| Preview unblock: deleted 9 over-committed apps | requests **95% → 18%**  | `kubectl describe node` before/after                                                              |

> A fuller per-process breakdown belongs in a dedicated measurement doc; until
> that lands, the table above is the authoritative baseline for this design.

## Outcome

**Near-term (the actual work):** wizard-born nodes deploy reliably **where they
are needed** — `operator` + the node(s) under test per env — on _honest_ k3s
scheduling, with no per-env capacity surgery and no over-commit crash-loops.

**Proven-out scaling path (demand-gated, NOT imminent):** the same architecture
extends to 50+ concurrently-running node-apps by tiering shared infra off the app
box and adding k3s workers — but only if real node-count pressure appears.

> **Altitude check.** At 1 dev / 0 users, 50 _concurrent_ node-app pods per env
> is almost certainly not the real requirement — most nodes need to _exist and be
> managed_ by the operator, not run a pod in every env (product vision: nodes are
> often fixtures; "ai-only canary PRs are the real POC"). So **Steps 0–1 are the
> near-term answer; Steps 2–3 are options held in reserve.** Building the infra
> split now — new VM, data migration, cross-VM networking, recurring spend —
> ahead of that demand is the G02 perfectionism `feedback_mvp_stage_first` warns
> against. The trigger to start Step 2 is named below, not assumed.

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
- **Trim the `migrate` init request to the app-container floor (384Mi → 256Mi).**
  The pod's scheduling reservation is `max(initRequest, appRequest)` =
  `max(384, 256)` today. The `app` container requests 256Mi
  (`deployment.yaml:99`), so trimming the init **below 256Mi buys zero
  scheduling density** — 256Mi becomes the app-bound floor. Trim the _request_,
  not the _limit_: keep the init limit generous (1Gi) and stagger migrations, or
  a tight limit OOMKills the migrate when several run at once (an eviction risk,
  **not** scheduler over-commit — lowering a request can never cause over-commit).
- **Gate the `migrate-doltgres` init on Doltgres adoption.** Most nodes carry no
  `doltgres-schema` → a dead 384Mi init + a guaranteed crash-loop surface. Emit
  it only when the node has a Doltgres migration dir.
- **Tune rollout `maxUnavailable`/`maxSurge`** so a stuck new RS can't pin a
  second replica's RAM per node during deploys.

Honest density on a 6 GB co-resident box: ~3 (over-committed, crashing) →
**~5–7 reliably scheduled** at today's 384Mi/pod, rising to **~8** once the init
request is trimmed to the 256Mi app floor (allocatable ≈ 5.9 − 2.8 Compose − 0.7
k8s − 0.3 evict ≈ 2.1 GB; ÷ 0.384 ≈ 5.5, ÷ 0.256 ≈ 8). **Tension to respect:**
honest scheduling _lowers_ what the scheduler places (it stops over-committing) —
it does not add RAM. The init trim raises the per-pod ceiling only down to the
256Mi app floor; below that it does nothing. The real risk after trimming is
**actual-RAM eviction/OOMKill** under concurrent migrations (a _limit_/usage
concern), not over-commit (a _request_ concern) — mitigate by keeping the migrate
limit generous and staggering rollouts, not by inflating the request. Pure k3s
config + kustomize patches, no new VM, no new spend.

### Step 1.5 — Bigger co-resident VM · the cheapest demand-gated lever (do this before Step 2)

**Trigger:** Step 1 honest density (~8/6 GB) is exhausted by genuine demand.

Before paying the Step-2 topology tax, **resize the co-resident VM**. The Compose
stack is a fixed ~2.8 GB; every added GB of VM is honest app headroom. A 16 GB
co-resident box: allocatable ≈ 16 − 2.8 − 0.7 k8s − 0.3 evict ≈ 12.2 GB ÷ 384Mi ≈
**~31 node-apps** (≈ 47 if the Step-1 init trim to 256Mi is applied first) —
**zero topology change, zero cross-VM networking, zero data migration.** This
dominates Step 2 on the cost/complexity Pareto until ~30 nodes:
Step 2's 6 GB app-only VM yields only ~13, and its 16 GB app-only ~38 figure
costs a _whole second VM_ plus the private-network/TLS/partition/migration work
below for a marginal +7 over staying co-resident. **Vertical resize of the
co-resident box is the right next move; the infra split (Step 2) earns its
complexity only once a single VM — at whatever size Cherry sells — can't hold the
demand, or the Compose stack itself saturates CPU.**

### Step 2 — Tier shared infra off the app box · the structural option (demand-gated)

**Trigger:** the largest single co-resident VM (Step 1.5) is exhausted by genuine
demand, or the Compose stack saturates CPU and must own its own box. Not before.

A dedicated **infra VM** runs the Compose stack; **app VMs run only k3s +
node-apps** → `allocatable` becomes honest with no reservation guesswork.
Density: `max_node_apps ≈ (VM_RAM − 0.7 k8s) / 384Mi` → 6 GB app VM ≈ **~13**,
16 GB ≈ **~38**.

**This is a topology change with a real data plane — design it, don't wave it
away:**

- **Cross-VM networking.** Today postgres/doltgres/litellm/temporal are
  _localhost_ to the app pods. Off-box, every query crosses the network →
  requires Cherry **private networking** between the infra + app VMs (net-new
  provisioning), **TLS + firewall** on postgres/doltgres (they currently bind
  loopback, effectively trusted), and the existing `ExternalName`/
  ContainerRuntimePort indirection repointed at the private endpoint (that
  abstraction carries the endpoint _string_ only — not the network/TLS/firewall).
- **New failure mode.** Co-resident, infra + app share one failure domain;
  split, a **network partition** (infra VM reachable-but-slow, or unreachable)
  is a new class the app tier must degrade against.
- **Data migration.** Existing postgres/doltgres volumes must move off the app
  box (dump/restore or re-provision from ESO-backed creds) — a one-time play,
  not a config flip.
- **The infra tier has its _own_ ceiling.** Moving the memory double-count off
  the app box does not make shared infra infinite: one `litellm` proxying N
  nodes' LLM traffic and one `temporal` running N nodes' workflows have limits
  this doc does not measure. Assumption: fine to ~tens of nodes at MVP load;
  **signal to shard:** litellm/temporal CPU saturation or p95 latency regression
  in Grafana. Re-measure before trusting past ~20 nodes.

Reuses the existing Compose stack (relocated, not rebuilt).

### Step 3 — Horizontal app tier · 50+ (demand-gated)

**Trigger:** one infra-tiered app VM is full and vertical (a bigger box) is no
longer cost-effective. Join additional Cherry VMs as **k3s agents (workers)**;
Argo already deploys the apps, so the scheduler spreads pods across workers with
no per-node manifest change. Capacity becomes a provisioning knob — add a worker
when `allocatable` drops below a threshold. 2 × 16 GB app workers (infra tiered
off) ≈ **~76 node-apps**. Each VM is recurring Cherry spend — gate on demand,
not headroom. Cherry-only, OSS-only.

## Invariants

<!-- CODE REVIEW CRITERIA -->

- [ ] HONEST_ALLOCATABLE: on any co-resident box, k8s `allocatable` must reflect
      non-k8s RAM (system-reserved accounts for Compose); no scheduler
      over-commit. (spec: this doc, Step 1)
- [ ] SHARED*INFRA_NOT_PER_NODE: node-apps share one `postgres`/`doltgres`/
      `temporal`/`litellm`/`redis` **server**; never per-node infra \_instances* —
      that is the thing that fundamentally does not scale. This is **compatible
      with per-node databases/credentials**: [`node-baas-architecture`](../spec/node-baas-architecture.md)
      and the live #1584 per-node-DB-cred cutover provision a per-node `DATABASE` + role + ESO secret _inside_ the one shared server (DBs/schemas scale with
      load, not node count). Shared **server**, per-node **database** — not a
      contradiction; the anti-pattern is a per-node postgres _process_.
- [ ] OFF_BOX_DATA_PLANE_IS_PRIVATE_AND_TLS (Step 2 only): if shared infra moves
      off the app box, the DB/runtime endpoints ride a private Cherry network
      with TLS + firewall — never a public interface or an untrusted hop. The
      app tier degrades gracefully on infra-VM partition.
- [ ] DEMAND_GATED_SCALING: Steps 2–3 (new VMs, spend) start only at their named
      trigger — exhausted honest density / full app VM — never speculatively.
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
- **Vertical-only as the _terminal_ strategy (one ever-bigger VM forever).** Caps
  out, can't reach 50+, single point of failure. Horizontal workers (Step 3) are
  the terminal scale axis. Note this rejects vertical _as the endgame_, not
  vertical _as the next cheap step_ — resizing the co-resident VM (Step 1.5) is
  explicitly the first demand-gated lever, ahead of the infra split.
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
