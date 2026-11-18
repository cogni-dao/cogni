---
id: pm-prod-swap-thrash-2026-08-27
type: postmortem
title: "Production swap-thrash: 10 days of fleet-wide 502s nobody saw"
status: active
trust: reviewed
summary: "The production VM swap-thrashed for 10 days. kubelet stalled, every pod repeatedly left its Service endpoints, and all nodes 502'd intermittently. Poly's table scans were the driver; the real defect is that it degraded for 10 days and was found by a human failing to log in."
read_when: Prod is slow or 502ing, a node flaps NotReady, or you are deciding what detection the fleet owes itself.
owner: derekg1729
created: 2026-08-27
verified: 2026-08-27
tags: [postmortem, production, capacity, poly, postgres, observability]
---

# Production swap-thrash, 2026-08-27

> Incident item: `bug.5065`. Mitigation: poly scaled to 0.
> Related: `bug.5067` (deploy-infra AUTH*SECRET), `bug.5066` (Deployments UI shows no
> path to remove a dead node), `bug.5012` (the `poly_trader*\*` scan class).

## Summary

The production VM swap-thrashed for ten days. kubelet stalled, the node flipped
`NotReady` 83 times, and each flip removed every pod from every Service's endpoints —
so all nodes returned 502 intermittently while their pods were perfectly healthy.
Poly's `poly_trader_current_positions` scans were the driver; the real defect is that
it ran for ten days and was detected by a human failing to sign in.

Mitigated by scaling poly to 0. Prod recovered within minutes: load 63 → 12,
iowait 86% → 29%.

## What a user saw

Derek tried to sign in to production and got **"Error verifying signature."** Twice.
Nothing else — no alarm, no page, no red dashboard.

That is the entire human-facing signal from a **ten-day** degradation.

## What was actually happening

The single production VM (6 vCPU / 5.9 GB, `5.199.162.44`) was in continuous swap thrash:

```
load 42.91 on 6 cores        iowait 70–86%
free 141 MB of 5920 MB       swap 1347 MB of 2047 MB in use
si/so ~20 MB/s sustained     23–29 processes blocked in D-state
cumulative: 3.00e9 pages swapped in / 2.74e9 out
```

**Load 42 was disk wait, not CPU** — summed process CPU was only ~150%. That distinction
is the whole diagnosis: every "is the app slow?" instinct is wrong when `b` and `wa` are
the tall columns.

Under that pressure kubelet itself could not post status on time:

```
Warning  NodeNotReady   6m59s (x83 over 10d)   node-controller   Node is not ready
```

**Each of those 83 flips removed every pod from every Service's endpoints.** Caddy then
had no upstream and returned 502 — for nodes whose pods were individually perfectly
healthy. That is why the outage looked fleet-wide, uncorrelated with any deploy, and
intermittent enough to be dismissed as a blip.

## The driver

`poly`. Live on the box at diagnosis time:

```
autovacuum: VACUUM public.poly_trader_current_positions      27m14s
INSERT INTO "poly_trader_current_positions" (...)            19m34s
autovacuum: VACUUM public.poly_market_metadata               18m40s
WITH active_conditions AS (SELECT DISTINCT condition_id, token_id
  FROM poly_trader_current_p...)                             2 parallel workers
```

Nearly every D-state process was Postgres on `cogni_poly` (`service_poly`, `app_poly`,
autovacuum). This is exactly the class the `data-research` skill exists to prevent —
naive scans over `poly_trader_*` — grown large enough to take the VM down.

`poly-node-app` was already **0/1 with 42 restarts on an 11-day-old pod**, its liveness
probe timing out at 3 s on a box where nothing answered in 3 s. It had been serving
nothing for days while continuing to generate the load that broke its neighbours.

## Timeline

| time     | event                                                                                 |
| -------- | ------------------------------------------------------------------------------------- |
| ~08-17   | node begins flapping (`NodeNotReady`, first of 83)                                    |
| 09:44    | production promote dispatched (task.5024). App lane succeeds; prod serves the new SHA |
| 17:52    | investigation opens: pods healthy in Loki, external 502                               |
| 18:01:14 | `[SIWE] Failed to retrieve nonce` — Derek's sign-in                                   |
| 18:01:24 | `[SIWE] Failed to retrieve nonce` — second attempt                                    |
| ~18:00   | `kubectl scale poly-node-app --replicas=0` applied (git already declared it)          |
| 18:03:30 | `[SIWE] Login success` — sign-in recovers on its own                                  |
| 18:0x    | load 63 → 30 → 19 → 12; iowait 86% → 29%; autovacuum drains                           |
| 18:1x    | all hosts 200, no active vacuum, box stable                                           |

## Root cause

**One undersized VM hosts the entire fleet with no isolation between a node's database
workload and every other node's availability.** Poly was the trigger; the architecture is
the cause. Any node that can make Postgres work hard can take the fleet down, because:

1. they share one box,
2. memory _limits_ are overcommitted to 196% (2 GB of swap makes that survivable-looking
   right up until it isn't), and
3. the health model converts slowness into total unavailability (below).

## Contributing factors

**Probe timeouts convert slow into down.** Liveness and readiness are `timeout=3s`,
`period=5s/10s`, `failure=3`. On a loaded shared box that is not a health check, it is a
tripwire: a pod that would have served a request in 4 s is instead killed and pulled from
the load balancer, which frees no memory and adds a restart to the queue.

**No isolation of the failure to its owner.** Poly's queries should degrade poly. Instead
they degraded operator, beacon and node-template, because endpoint removal is node-wide
when the _node object_ flips.

**Argo could not self-heal.** When the fix was committed, `production-poly` showed
`OutOfSync` at the correct revision — but `argocd-application-controller-0` was itself
`0/1`, starved by the same thrash. **The control plane that repairs the box was a victim
of the box.** The scale had to be applied directly (convergent with git, which already
declared `replicas: 0`).

## Symptoms that look like application bugs — do not go bug-hunting

This incident presented as at least three unrelated app defects. Each cost investigation
time or nearly did:

| symptom                                       | looks like                    | actually                                                                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"Error verifying signature"** on sign-in    | broken SIWE / auth regression | NextAuth's server-side `getCsrfToken()` self-fetch timed out under thrash → nonce `null` → generic UI error. **Exactly 2 occurrences in 14 days of prod logs, both at 18:01**, and `Login success` returned at 18:03:30 unaided. |
| node returns 502 while its pod logs look fine | edge/Caddy misconfiguration   | node object flipped `NotReady`; pod was evicted from Service endpoints. Check `kubectl get endpoints` — an **empty** endpoint list with a Running pod is this.                                                                   |
| `/readyz` returns 200 but the pod is `0/1`    | probe wiring bug              | the app answers; the _kubelet's_ probe times out at 3 s. App-level log success ≠ probe success.                                                                                                                                  |

**Diagnostic order that would have gone straight there:** `uptime` → `vmstat` (`wa`, `si/so`)
→ `kubectl describe node` (events, not conditions — `Ready=True` right now says nothing about
83 flips) → `kubectl get endpoints`.

## The real defect

Not poly's queries. **The box degraded for ten days and 83 NodeNotReady flips, and the
detection mechanism was a human failing to log in.** Every dashboard, probe and workflow
was green or silent throughout. Fix the queries and this recurs with a different driver.

## Action items

| #   | action                                                                                                                                                                                                                                                                         | owner      | item         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------ |
| 1   | **Route detection to an AI responder, not a human inbox.** Sustained `iowait`, swap-in-use, `NodeNotReady` transitions, and empty endpoints on a Running pod must open a work item and wake a dev agent that triages and mitigates. See the note below — this is the top item. | infra lane | `story.5013` |
| 2   | **Silence the existing Grafana email alerts to Derek.** They are noise going to the one human, which is precisely the wrong destination and actively trains him to ignore the channel.                                                                                         | infra lane | `story.5013` |
| 3   | Fix poly's `poly_trader_current_positions` scan cost before poly returns. Poly stays at `replicas: 0` until then; revert is one commit on `deploy/production-poly`.                                                                                                            | poly lane  | `bug.5012`   |
| 4   | Size the VM for the fleet, or move a node's database workload off the shared box.                                                                                                                                                                                              | infra lane | `bug.5065`   |
| 5   | Raise probe timeouts and add a `startupProbe`, so slowness degrades instead of evicting.                                                                                                                                                                                       | infra lane | `bug.5065`   |
| 6   | Restore the Compose/edge lane on production — `deploy-infra` currently FATALs on a missing `AUTH_SECRET`, so no infra change is shippable to prod.                                                                                                                             | infra lane | `bug.5067`   |

### Why item 1 is not "add an alert"

Derek is the only human here and **does not want alerts**. Grafana already emails him and
that mail is noise. Adding a page for sustained iowait would satisfy the letter of
"detect this" and fail the intent: the goal is that **the fleet notices and repairs itself
without spending the one human's attention.**

So the deliverable is a loop, not a notification: a detector that files a work item and
dispatches an AI developer to triage it, escalating to Derek only with a scorecard and a
single decision — exactly the shape of the mitigation performed by hand during this
incident (diagnose read-only, commit the fix to the deploy branch, verify recovery).

## What went right

- Read-only SSH diagnosis produced the root cause in ~15 minutes once it started.
- The mitigation went through git (`deploy/production-poly`), so the direct `kubectl scale`
  that broke the Argo deadlock was **convergent, not drift** — the cluster was moved to
  what git already declared.
- Recovery was verified by direct reads (load, iowait, swap, endpoints, external 200s),
  not by a workflow's colour.

## What went wrong in the response

- **Poly was taken offline without asking.** It is Derek's trading node; he discovered it
  by failing to sign in to it. It was already 0/1 and serving nothing, and the change is
  one commit to revert — but an outward-facing availability decision needed an explicit
  y/n first, and it was buried in prose instead of asked as a decision.
- **A transient 502 was reported as an outage** before retrying, against an existing note
  that says to retry 1–2 minutes first.
- **An unscoped production promote** (`nodes` left empty) hard-failed the remote-source
  cells for want of `node_source_sha` (`bug.5043`), which gated `promote-k8s`/`deploy-infra`
  for every node, so nothing deployed. Always scope `nodes` to the in-repo targets.
