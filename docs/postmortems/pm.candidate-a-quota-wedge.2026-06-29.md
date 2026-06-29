---
id: pm.candidate-a-quota-wedge.2026-06-29
type: postmortem
title: "candidate-a fleet 502 — a ResourceQuota ceiling wedged rollouts on an over-subscribed env"
status: draft
trust: draft
severity: SEV2
duration: "~25 minutes (candidate-a only; no preview/prod impact)"
services_affected: [candidate-a all node-apps, candidate-a scheduler-worker]
summary: "A manually-applied ResourceQuota on the already-over-subscribed candidate-a namespace rejected a flight's rolling-update surge pod; scheduler-worker degraded, /readyz coupling cascaded the whole candidate-a fleet to 502. Resolved by deleting the quota/LimitRange and letting the control plane recover."
read_when: "Before enforcing any ResourceQuota/LimitRange on a live env, or applying any manual kubectl change to candidate-a."
owner: devops-expert
created: 2026-06-29
verified:
tags: [incident, capacity, argo, gitops, candidate-a]
---

# Postmortem: candidate-a fleet 502 — ResourceQuota ceiling wedged rollouts

**Date**: 2026-06-29
**Severity**: SEV2 (candidate-a CI/CD blocked; no preview/prod impact)
**Status**: Resolved
**Duration**: ~25 minutes

---

## Summary

While shipping cluster-native capacity enforcement (a fleet-aggregate `ResourceQuota` +
`LimitRange` on `cogni-candidate-a`), the quota was **applied manually via `kubectl`** to
candidate-a — an env that was **already over-subscribed** against its honest capacity. A
concurrent candidate flight rolled `scheduler-worker` to 2 replicas; the rolling-update
**surge pod's requests pushed the namespace total over the quota ceiling**, so the API
server **rejected** it. `scheduler-worker` stuck at 1/2; because node-app `/readyz` is
hard-coupled to scheduler-worker, **every** node-app reported NotReady and the whole
candidate-a fleet served **502**. Resolved by deleting the manual `ResourceQuota` +
`LimitRange`; the control plane caught up and pods returned to Ready (9/9 nodes 200).

## Timeline

| Time (UTC)   | Event                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| ~17:34       | `ResourceQuota cogni-candidate-a-budget` (5600Mi) + `LimitRange` applied manually via kubectl to candidate-a (namespace already ~3968Mi used). |
| ~17:51       | Candidate flight (run 28401867965) starts; rolls `scheduler-worker` toward 2 replicas.                                                         |
| ~18:02–18:07 | `scheduler-worker` new-RS availability times out (`newRsAvailable=1, desired=2`) — the 2nd pod is quota-rejected. Flight goes red.             |
| ~18:0x       | node-app `/readyz` (coupled to scheduler-worker) starts failing → fleet readiness degrades.                                                    |
| (detection)  | Operator reports test node 502, then "all nodes down".                                                                                         |
| ~18:1x       | Manual `ResourceQuota` + `LimitRange` + the (OutOfSync) Argo Application deleted.                                                              |
| ~18:1x–18:2x | API server (overloaded kine/SQLite datastore + memory pressure) catches up; pods return to 1/1; scheduler-worker 2/2.                          |
| ~18:2x       | External sweep: 9/9 nodes 200; operator healthy at apex. Resolved.                                                                             |

## Root Cause

### What Happened

A `ResourceQuota` with a `requests.memory` hard cap was placed on a namespace whose live
usage was already near that cap, on a VM with **dishonest allocatable** (kubelet
`system-reserved` not in effect on the running node, so `allocatable == capacity == ~5921Mi`
while ~2.8GB is consumed by the co-resident Compose stack). A rolling update needs headroom
for a **surge pod**; the quota denied it, wedging the rollout. The `/readyz`→scheduler-worker
coupling turned one wedged Deployment into a **fleet-wide** 502.

### Contributing Factors

1. **Proximate cause**: a `requests.memory` ResourceQuota ceiling below `current + rollout
surge` on a live env rejects the next rollout's surge pod.
2. **Contributing factor**: the env was **already over-subscribed** vs honest capacity, and
   the kubelet `system-reserved` reservation is **not applied on the running node** — so
   there was no honest ceiling that wouldn't wedge.
3. **Contributing factor**: node-app `/readyz` is **hard-coupled to scheduler-worker**, so a
   single degraded Deployment cascades to the entire fleet (known issue).
4. **Systemic factor**: the change was applied **manually via kubectl** outside GitOps — no
   review, no staged rollout, and it added control-plane load while a flight ran on an
   already-strained kine/SQLite datastore.

## Detection & Response

### What Worked

- The negative behavior was unambiguous and fast to attribute (quota reject → rollout
  timeout in the flight log; `exceeded quota` event).
- Rollback was clean: deleting the quota/LimitRange restored baseline; no data loss.

### What Didn't Work

- The pre-merge "validation" exercised the quota's _enforcement_ (over-cap pod Forbidden)
  but **not** the realistic _rolling-update surge_ against live usage — the actual failure
  mode. Green negative-proof ≠ safe under real deploy dynamics.
- Manual kubectl on a live env defeated review and staged rollout.

## Impact

### Customer Impact

- None external (candidate-a is the internal CI/CD env; zero end users).

### Technical Impact

- candidate-a CI/CD blocked ~25 min; all node-apps + scheduler-worker degraded; one
  candidate flight failed.

## Lessons Learned

### What Went Well

1. Fast, clean rollback (delete the manually-applied objects → recover).
2. The incident surfaced two real, durable findings: candidate-a allocatable is dishonest
   (system-reserved not applied), and the catalog-edit decommission **prune-gap** (orphaned
   AppSets are never pruned).

### What Went Wrong

1. Enforced a capacity **ceiling on an already-over-subscribed env** — guaranteed to wedge.
2. Applied it **manually via kubectl** instead of GitOps with staged rollout.
3. Validated enforcement, not **rolling-update surge** against live usage.

### Where We Got Lucky

1. It hit candidate-a, not preview/prod. The same merged manifest would have re-applied the
   quota on the next bootstrap had it not been reverted off `main` (PR #1891).

## Action Items

| Pri | Action                                                                                                                                        | Owner         | Work Item                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------- |
| P0  | Revert the candidate-a quota slice off `main` (re-wedge landmine)                                                                             | devops-expert | PR #1891                     |
| P1  | Never enforce a capacity ceiling before the env is right-sized + kubelet `system-reserved` is honest (sequenced in operator-fleet-safety §10) | devops-expert | story.5020                   |
| P1  | Apply kubelet `system-reserved` to **running** candidate-a node so allocatable is honest                                                      | devops-expert | (provisioning follow-up)     |
| P2  | Close the decommission **prune-gap** (app-of-apps over `infra/k8s/argocd/`) so teardown actually prunes — keystone for right-sizing           | devops-expert | story.5020                   |
| P2  | Decouple node-app `/readyz` from scheduler-worker so one Deployment can't cascade the fleet                                                   | —             | (see prod-502 coupling work) |

## Related

- [Operator Fleet Safety design](../design/operator-fleet-safety.md) — §5 (this incident), §6b (prune-gap), §10 (re-sequenced).
- [production VM loss](./2026-02-07-production-vm-loss.md)
