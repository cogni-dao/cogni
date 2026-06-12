---
id: vm-pod-memory-efficiency
type: research
title: VM Pod Memory Efficiency — node-app footprint + co-resident k3s/Compose capacity
status: draft
trust: draft
summary: Measured memory profile of node-app pods and the runtime VM, why ~6 GB VMs OOM the full node catalog, and ranked levers to fit more nodes per VM.
read_when: Sizing an env VM, debugging node-app `Pending — Insufficient memory` / `/readyz` 502, or optimizing per-pod memory.
owner: derekg1729
created: 2026-06-10
tags: [infra, capacity, kubernetes]
---

# VM Pod Memory Efficiency

Findings for future optimization. Measured on the standard ~6 GB / 6-vCPU Cherry
VM (preview `84.32.25.59` + candidate-a `84.32.9.111`, 2026-06-10). Not a spec —
a starting point for whoever optimizes pod density per VM.

## TL;DR

A node's VM runs **k3s and the Compose infra stack on the same box**, and **k3s
reports the full VM RAM as allocatable while Compose has already taken ~2.8 GB of
it**. The scheduler can't see that, over-commits, and node-app pods land
`Pending`/OOM. The fix axis is not "tune the pod" first — it's the **co-resident
double-count**. A 6 GB VM realistically fits ~2–3 node-apps, not the ~10-node
catalog.

## Measured memory profile

### node-app pod (per replica)

| Container                 | Kind                                 | request | limit |
| ------------------------- | ------------------------------------ | ------- | ----- |
| `app` (main)              | long-running                         | 256Mi   | 512Mi |
| `migrate` (init)          | **one-shot** (`restartPolicy` empty) | 384Mi   | 1Gi   |
| `migrate-doltgres` (init) | **one-shot**                         | 384Mi   | 1Gi   |

**Scheduling reservation = `max(maxInitReq, sumMainReq)` = `max(384, 256)` =
384Mi** (init containers are one-shot, run sequentially, and release their
reservation once complete). Steady-state running footprint ≈ **256Mi**. The naive
sum (1024Mi) is _not_ what k8s reserves — but see the stuck-init trap below.
Non-Doltgres nodes (e.g. `resy`) have no `migrate-doltgres` init → 640Mi naive /
256Mi steady-state.

### VM-level (the real constraint)

| Consumer                                                                                                                         | Memory      |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| VM total RAM (`free -m`)                                                                                                         | ~5.9 GB     |
| Compose infra + OS, idle (`postgres`, `doltgres`, `litellm`, `temporal` + `temporal-ui` + `temporal-postgres`, `redis`, `caddy`) | ~2.8 GB     |
| k8s system / Argo / ESO / OpenBao / monitoring (pod requests)                                                                    | ~0.7 GB     |
| **Physical RAM left for all node-app pods**                                                                                      | **~2.4 GB** |

k8s `allocatable.memory` = ~5.9 GB (full VM) — it does **not** subtract Compose's
2.8 GB. So k8s will happily schedule ~5.7 GB of pods onto a box that has ~2.4 GB
actually free → kernel OOM / swap thrash / `Pending`.

## Why the full catalog OOMs preview

1. **Co-resident double-count (root cause).** k3s allocatable ignores Compose's
   ~2.8 GB. Everything below is amplified by this.
2. **Rollout churn doubles pod count.** A stuck rollout keeps the old ReplicaSet
   alive (it won't drain until the new one is Ready) while the new one can't
   schedule → 2 pods/node → demand doubles → deadlock.
3. **Stuck-init pins the 384Mi.** A pod crash-looping in `migrate`/
   `migrate-doltgres` (e.g. the 28P01 DB-cred failure, or `CreateContainerConfigError`)
   holds its 384Mi init reservation indefinitely while doing nothing.

10 nodes × 2 ReplicaSets × ~384Mi ≈ 7.7 GB demanded against ~2.4 GB physical →
most pods `Pending — Insufficient memory`, including `operator`.

## Optimization levers (ranked by payoff)

1. **Split Compose infra off the node-app VM** (biggest win). A dedicated infra
   VM (postgres/doltgres/litellm/temporal/redis) removes the 2.8 GB double-count
   and makes k8s allocatable honest. Then `max_node_apps ≈ (VM_RAM − 0.7) / 0.4`.
2. **Right-size the per-env node set.** Most envs only need `operator` + the
   node(s) under test. Deploying the full ~10-node catalog to every env is the
   actual cause here, not pod bloat. The node set per env is a catalog/overlay
   decision — make it explicit, not "every node everywhere."
3. **Account for Compose in k8s `system-reserved` / eviction thresholds** so the
   scheduler stops over-committing on a co-resident box (cheaper stopgap than a
   VM split).
4. **Trim the migrate init requests.** 384Mi req / 1Gi limit is generous for a
   drizzle-kit migration + a `dolt_commit`. Profiling actual peak (likely
   128–192Mi) would shrink the scheduling reservation and reduce stuck-init waste.
5. **Gate `migrate-doltgres` on Doltgres adoption.** Nodes with no
   `doltgres-schema` (most today) carry a dead 384Mi init + a guaranteed
   crash-loop surface. Emit the init only when the node has a Doltgres migration
   dir.
6. **Tune rollout `maxUnavailable`/`maxSurge`** so a stuck new RS doesn't pin a
   second replica's worth of RAM per node during deploys.

## Budget rule (until Compose is split off)

```
usable_for_node_apps ≈ VM_RAM_GB − 2.8 (Compose) − 0.7 (k8s system)
max_node_apps        ≈ floor(usable / 0.4)     # 0.4 GB peak (init) per node
```

- 6 GB → ~2–3 nodes · 8 GB → ~4–5 · 16 GB → ~14.
- Running the full catalog on one env needs ≥ 14 GB **or** an infra-VM split.

Symptoms of violating this: node-app pods `Pending — Insufficient memory`, 2
stuck ReplicaSets/node, `/readyz` 502 with no healthy backend.
