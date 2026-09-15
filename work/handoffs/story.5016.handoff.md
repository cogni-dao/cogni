---
id: story.5016.handoff
type: handoff
work_item_id: story.5016
status: active
created: 2026-09-15
updated: 2026-09-16
branch: agent/task5104-xcw-identity
---

# Handoff: production cutover DONE · operator healed · wizard E2E one leg short

## What is TRUE right now (verified 2026-09-16 ~00:45Z)

- **Fleet 5/5 LIVE on Akash via Crossplane, paid by the production wallet** `akash10auj…`:
  toks4 `6f5c4db8` · node-template `f39ed6f1` · beacon `5b5fb2ee` · poly `016febf3` · levelup `bebc875d`.
  `receipt_bound` strictly before `leased` held fleet-wide; exactly one ledger row per node_id;
  old account `akash12eh8…` = 0 leases, 0 orphans. Legacy controller DELETED from candidate-a AND production.
- **Operator crash class CLOSED**: pod `86bbd968b9-np7kg` has **0 restarts over 4+ h** (was dying hourly),
  reconciles-4h = 2 (was ~36+churn). Root cause: the catalog-registry "fallback" interval ran forever on an
  immutable ref (#2254, deployed). Layer-2 fast first-reconcile retry #2257 MERGED (not yet promoted).
  **bug.5164 stays open until the 24h Loki check after 2026-09-16T20:45Z** (reviewer bar: starts ~1/boot, failures ~0).
- **Reproducible-green CI proven**: promote run 34951395639 = exit 0, kex 0, verify-deploy success.
- **Wizard E2E (toks5, THROWAWAY node f66b260b)**: candidate leg PROVEN (toks5-test served `33606e83`,
  lease 1789472890074, readyz healthy, register worked). **Production leg NOT done** — see Next Actions.

## NEXT ACTIONS (ordered)

1. **#2253** (heap 768/1Gi + scheduler-worker 1 replica — insurance): OPEN, fixes pushed
   (json-patch form passes `operator-rollout-strategy.test.sh`). Re-enqueue via
   `POST /vcs/merge {prNumber:2253, nodeId:"operator"}` on green; ride the next operator promote.
2. **#2256** (task.5105 rename `lease_epoch`→`lease_generation` + toks5 `lease_generation.production: 1`):
   OPEN; last fix = spec type keeps wire name `leaseEpoch`. **Validate-before-merge**: flight PR head to
   candidate-a (operator), verify `/version`, then merge. Wire-field rename deferred to v1alpha2 — the
   catalog/resolver/docs are the caller surface (ci-cd.md **Axiom 27** documents the contract; Derek-binding:
   the name `lease_epoch` may not ship; 1-1 epoch coupling was design-REJECTED).
3. **toks5 → production** (task.5106 has the full recipe): after #2256 merges,
   `POST /deploy/promote {nodeId:f66b260b…, env:production, sourceSha:33606e83…}` → guard mints under key `:1`
   → clear legacy finalizer if it hangs → `toks5.cognidao.org` serves `33606e83` → **close the candidate slot**
   (env verb `{env:"candidate-a", present:false}`) — SPAWN ENDS AT PRODUCTION (story.5025). toks5 is a
   throwaway: full close-out is an acceptable alternate ending but leaves the wizard prod leg unproven.
4. **Promote operator once more** after #2253+#2257 land (applies layers 2-3).
5. **bug.5164 24h close** (see above) · **bug.5165** (KSM/cAdvisor observability gap — the reason this took
   3 misdiagnoses; unowned) · **bug.5166** (promote-k8s writes deploy-state before XR convergence → UI shows
   "deployed" for non-serving nodes; NOTE: Derek first reported the UI said production, then corrected to
   candidate — verify what the UI actually reads before large surgery).

## Open work items / bugs (all filed with full context)

task.5105 (rename, in flight via #2256) · task.5106 (toks5 handover) · bug.5158 (502 masking) ·
bug.5159 (transport truthfulness — fixed by #2242/#2246/#2248/#2249, closable) · bug.5160 (poly completion
path 520s) · bug.5161 (wizard Caddy twin-drift) · bug.5162 (birth omits compute_egress_cidrs) ·
bug.5164/5165/5166 (above). Knowledge: two contrib branches await Derek's hub merge (ssh-transport finding;
wallet-cutover as-built refine). Derek directive not yet built: **split the launch pack into 2 lean variants**
(fresh-spawn agent pack vs join-existing-node pack) — template lives in the operator launch-pack generator +
`node-launch-handoff` hub entry; `.claude/skills/node-wizard-scorecard` already refreshed (#2255, merged?
verify) with 8 launch-path deltas.

## Load-bearing gotchas from this run (do not relearn these)

- **Merge-verb quirks**: "mergeability is still computing" = retry ~20s; merge queue re-runs CI on the rebased
  candidate; access-request bursts 500 (bug.5113 class) — retry lands.
- **Never trust a green workflow**: verify `/version.buildSha` + XR `Ready/serving`. verify-candidate red can
  be the readiness poller lagging #2249 on the candidate control-plane ref.
- **Flight dispatches can be swallowed** by the per-target concurrency window — confirm a NEW run id within
  ~30s or re-dispatch.
- **secret-materialize false-empty era is over** (#2242) but its damage lingers: stale LiteLLM aliases
  (materialize now self-reconciles, #2249) and KV-v2 history is the recovery plane for corrupted buckets.
- **The actuator's refusals are safety, not bugs**: `allocation_unresolved`/settled-key → verify the wallet
  for orphans FIRST (Console API list with the env's actuator key from the cluster Secret), then bump
  `lease_generation`. Never hand-mutate ledger/cluster.
- **Readiness was hostage to first reconcile** — #2257 fixes; until promoted, a dying pod + slow successor
  = public 502 window; remediation = delete the not-ready pod (boot retries immediately).
- **kubectl top "% of allocatable" is NOT host pressure evidence** — two memory misdiagnoses this run;
  demand process-level evidence (V8 GC trace, restart reasons, per-source ssh signatures).
- VM ssh admission control drops handshake bursts — multiplexing (#2246) + jittered retries are in; the lib
  `scripts/ci/lib/ssh-retry.sh` carries BOTH `ci_ssh_retry` (pre-existing consumers!) and
  `cogni_ssh_transport_retry`. **Check the arsenal before writing any file there** (#2248 restored a clobber).

## This session's errors, so you don't repeat them

1. Misdiagnosed sshd resets as VM memory (twice) — refuted by app latency + two-VM evidence; real cause was
   handshake-burst admission control, then a JS-heap leak for the crashes.
2. Overwrote an existing lib file without checking (`ssh-retry.sh`) → broke every promote for ~40 min.
3. Watcher misreads: twice attached to the WRONG workflow run (grab-latest race); always match run id to
   your dispatch window and verify the run's own inputs/matrix.
4. Status matrices that said "chained/armed" while PRs were red — name reds explicitly.
5. Shipped an undocumented concept name (`lease_epoch`) into a CTO-facing decision — document + name first.
