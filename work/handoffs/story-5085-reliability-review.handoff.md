---
id: story-5085-reliability-review.handoff
type: handoff
work_item_id: "story.5085"
status: active
created: 2026-10-15
branch: derekg1729/bug-5459-serve-alert
---

# Handoff: independent reviewer/synthesizer for story.5085 (substrate reliability + Poly restoration)

## Mission

You are the CEO's independent reviewer and synthesizer for story.5085. You do NOT implement; a separate dev-manager session (its ledger lives in task.5247/story.5085 outcomes) runs implementation. Your jobs: verify every claim against live ground truth before relaying it, review designs/PRs against the merged canon, keep the CEO's time cost near zero (he reads ONLY the Bottom line), and hand him tiny copy/paste messages — he relays to devs himself. Do not post CEO directives to PRs; the CEO explicitly withdrew that channel after I over-used it.

## The CEO's trust is damaged. Causes, so you don't repeat them

1. I flagged PR #2724 (bug.5299, DB residency guards) as required alignment early, then failed to track it; it sat unmerged while the 5085 team rebuilt residency checks in parallel. The CEO caught the duplication, not me.
2. I endorsed the design's Cherry-VM cell without surfacing the cost/strategy conflict (Cherry ≈ 10x Akash) until the CEO objected. Decision since: cells ship as Akash workloads (spike.5006 proved: crash-safe, 93s cross-provider restore).
3. My ETAs ("2–4h") kept slipping; the implementation heads churned 10+ times.
4. I posted a CEO "stop order" to a PR; the CEO ordered it purged (done). Comms rule now: talk to the CEO; he relays.

## DO NOT TRUST, VERIFY — the open question that triggered this handoff

The CEO rejects my "merge #2724 first" recommendation on trust grounds. Your first task: independently answer **"is PR #2724 safe and correct to merge now?"** Specifically: (a) does it conflict with merged #2730's rewrite of `scripts/ci/reconcile-node-substrate.sh`? (b) does its residency model derive from the catalog `database:` tier declarations (one SSOT) or a parallel source? (c) is its base stale? (d) does the 5085 lane's duplicated residency logic get deleted in favor of it? Deliver a verdict with file-level evidence, not an opinion.

## Verified ground truth at handoff (re-verify ALL of it; nothing here is current by default)

- PR #2730 (state-cell toolbox) MERGED 2026-10-14T21:34Z at head 94239ca0, after a solo 🟢 /validate-candidate PASS at that exact SHA. Candidate-a /version still served 94239ca0 at my last read; no later flight had landed.
- PR #2729 (containment + reliability status) OPEN; heads churn rapidly; task.5247's outcome ledger is the authoritative sequence of exact heads, CI results, and flight failures. Latest known blockers: flight/image repairs, ESO secret for Prometheus in private actuators, candidate capacity.
- Poly production: /readyz 503 (fenced since the 2026-10-13 incident). Restoration = dedicated Akash DB cell + fenced cutover + genuine human re-admission (CEO's own click; agents may never capture/replay his session).
- Residency finding (real): `scripts/ci/lib/lane-db-residency.sh` records that poly/candidate-a and red/candidate-a databases are physically PRODUCTION-host-resident; any candidate hostile replay must refuse prod-resident targets. PR #2724 guards exactly this class.
- CEO vetoes in force: NO candidate-a replacement or second candidate VM; NO new Cherry VMs; NO full-20GB restore on candidate (representative fixture on the Akash cell; the only full-size restore is the real fenced prod cutover); NO node-specific code (NODE_IDENTITY_IS_DATA_NOT_CODE); laptop-run control-plane mutations are an anti-pattern (task.5254).

## Canon + decisions already ruled (recorded, re-verifiable)

- Merged hub entries: `noisy-neighbor-database-architecture` (with my review amendments + CEO-approved recovery refinement: scoped recovery probes, human-only readmit, 10-minute recontain bound), `noisy-neighbor-reliability-visual`, `shared-substrate-tenancy-standard`, `shared-substrate-profile-visual`.
- Open hub inboxes awaiting CEO merge: `contrib-flock-leader-conductor-d59ddc7e` (hosting economics: bounded free tier, heavy nodes pay cost×margin, meter-and-accrue v0), `contrib-flock-leader-conductor-54851edd` (ONE_COMPUTE_ESTABLISHMENT_PLANE + coupling visual), `contrib-flock-leader-conductor-6b555902` (containment refinement).
- Work items I filed: task.5248 (cells converge onto compute plane + env_manager RBAC cell verbs), task.5254 (operatorize Grafana tofu reconcile), story.5088 (metering/billing), story.5089 (dead-node purge, far-off), spike.5006 (DONE-ish: Akash state GO).
- My poly RBAC requests (developer, env_manager, secrets_manager, production_promoter) are pending CEO approval; after `developer` approval the agent must self-accept the GitHub invite.

## Where everything lives

- Story gate ledger: https://cognidao.org/work/items/story.5085 · tasks: task.5246, task.5247, task.5248, task.5254, spike.5006, bug.5299
- PRs: https://github.com/cogni-dao/cogni/pull/2730 (merged) · /pull/2729 (active) · /pull/2724 (residency, OPEN — your first verdict)
- My review records: work/reviews/story-5085-*.md + substrate-tenancy-standard.design-review.md (this branch)
- Dev collaboration channel: .context/cto-reliability/ (recovery-policy-decision.md holds the approved readmit protocol + my conditions)
- Watch verbs: /version.buildSha is the only deploy truth; gh pr checks --watch for CI; validate-candidate scorecard is the merge gate.
