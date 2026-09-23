# Control-plane OOM protection — why deploy-infra kept "sealing/wiping" OpenBao

**Status:** Implemented (this PR). Bug: bug.5011. Related: bug.5113 (OpenFGA authz), bug.5051 (OpenBao leak).

## The symptom that looked like a deploy-infra bug

Operators repeatedly saw OpenBao "get sealed / wiped" and OpenFGA "go gone" **right
after the deploy-infra workflow ran** — so deploy-infra got blamed for corrupting the
secret/authz plane. Neither is what happened:

- **OpenBao is never wiped.** `secret-materialize.sh` is preserve-existing (`kv patch`,
  never blind `put`; creates only on a positive absent signal — a transport failure is
  explicitly not "absent", bug.5159/5206). deploy-infra only *reads* the vault.
- **deploy-infra never restarts the OpenBao pod.** It holds no `kubectl rollout`/`delete`
  against `openbao`. It fatals when it *reads* an already-sealed vault (`deploy-infra.sh:853`),
  which is why it looked like the culprit.

## The actual root cause: memory contention, not a secrets bug

The prod box is **6 GB and memory-oversubscribed** — it runs k3s (OpenBao + operator +
node pods) *and* a full docker-compose stack (several postgres, litellm, openfga, temporal,
redis, doltgres, alloy) with almost no per-service memory reservations.

**deploy-infra is a memory-spike event.** One run concurrently: pulls images, `up -d`s ~12
compose services, and `rollout restart`s every k8s node pod. The working set spikes, and the
kernel OOM-killer / kubelet eviction fires and picks the **least-protected** processes:

| Singleton | Before | Why it was the victim | Consequence when killed |
|---|---|---|---|
| **OpenBao** (k8s) | Burstable QoS (`req 384Mi ≠ lim 1Gi`), no priority | kernel `oom_score_adj ≈ 833` on a 6 GB box → prime target | Shamir 1-of-1, no auto-unseal → **reseal → secret plane down until a human unseals** |
| **OpenFGA** (compose) | no `mem_reservation`, no `oom_score_adj` | unprotected → freely OOM-eligible | authz plane down → `authz_unavailable` storms; every merge/promote 503s |
| **postgres** (compose) | no reservation | unprotected; datastore for openfga/litellm/app | takes the whole control plane with it |

They are **one root cause, not three independent "fainting helpers":** deploy-infra's memory
spike knocks over whichever critical singleton is least protected. OpenBao's knock-over is the
worst because a reseal is fatal (manual recovery), not a self-healing restart.

## The fix (this PR) — make the critical singletons un-killable under pressure

Surgical, no cloud, no new infra:

1. **OpenBao → Guaranteed QoS.** `cpu`/`memory` `request == limit` (500m / 1Gi) in
   `infra/k8s/argocd/openbao/values.yaml`. Guaranteed pods get kubelet-assigned
   `oom_score_adj = -997`, so the kernel kills essentially every other pod first. This is the
   load-bearing change — it directly stops the recurring reseal. (cpu ceiling is generous so a
   Raft vault under unseal/ESO load is never throttled.)
2. **OpenFGA → `mem_reservation: 256m` + `mem_limit: 768m` + `oom_score_adj: -800`** in the
   compose service. Soft floor the kernel honors + a "sacrifice others first" score.
3. **postgres → `mem_reservation: 512m` + `oom_score_adj: -900`** (protected hardest, since
   everything depends on it). No hard `mem_limit` — postgres sizes its own caches and a cgroup
   cap would OOM it mid-query.

## What this does and does NOT fix (no gold-coating)

- ✅ Stops deploy-infra's (or any) memory spike from OOM-killing the control-plane singletons →
  kills the recurring OpenBao reseal and OpenFGA-gone class at the mechanism.
- ❌ Does **not** remove the oversubscription itself. The box is still too small; if total
  demand exceeds RAM, *something* still dies — now it's a non-critical service, not the control
  plane. **The permanent fix is a bigger box / moving the secret+authz plane off the app box**
  (infra spend — owned separately, in progress).
- ➕ Complementary, still worth doing later: OpenBao **Transit auto-unseal** (makes any residual
  reseal self-heal — `docs/design/openbao-transit-auto-unseal.md`) and the **sealed-state Loki
  alert** (backstop detection). Both are backstops; this PR is the prevention.

## Verification

Code proves the exposure (QoS class + missing reservations + 6 GB box; the values.yaml comment
already recorded "memory-tight 6GB box → reseal"). The one runtime confirmation to run with
prod access: correlate OpenBao/OpenFGA OOMKilled events (`{service="kubernetes-events"}` /
docker events) against deploy-infra run timestamps — they should coincide before this change and
stop after. After rollout, confirm `kubectl get pod openbao-0 -n openbao -o jsonpath='{.status.qosClass}'`
returns `Guaranteed`.
