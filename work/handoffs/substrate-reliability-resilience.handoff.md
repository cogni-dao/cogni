---
id: substrate-reliability-resilience.handoff
type: handoff
work_item_id: ""
status: active
created: 2026-10-13
updated: 2026-10-13
branch: derekg1729/bug-5459-serve-alert
last_commit: adae111bd1
---

# Handoff: Design sustained substrate reliability and noisy-neighbor isolation

## Mission

New mission: own the engineering design—not implementation—for Cogni's sustained substrate reliability promise. Turn the 2026-10-13 fleet outage into a small, standard, enforceable architecture in which every node builds its mission rather than its plumbing, expensive nodes fail alone, and operators plus node developers can see actionable health. Start by creating and claiming one operator story for this design; treat `bug.5442` as incident evidence, not as permission to code. The CEO explicitly requires design review before any further reliability implementation.

## Goal

- Produce one CEO-reviewable architecture decision that restores a credible substrate guarantee with the minimum bespoke engineering.
- Define measurable admission, throttling, isolation, scaling, and database-graduation thresholds; distinguish emergency capacity from durable isolation.
- Produce a Pareto-ordered next 1–2 stories, each with a live E2E acceptance test across all 13 candidate-a, preview, and production endpoints.

## Start By Reading

- Operator cognition: <https://cognidao.org/knowledge/operator-agent-orientation>
- North-star substrate model: <https://cognidao.org/knowledge/node-baas-substrate-model>
- Existing fleet control loop: <https://cognidao.org/knowledge/fleet-reliability-reconcile-guide>
- Shared-control-plane failure pattern: <https://cognidao.org/knowledge/control-plane-self-starvation>
- Postgres evidence contract: <https://cognidao.org/knowledge/postgres-crash-observability>
- Incident taxonomy: <https://cognidao.org/knowledge/prod-oom-misdiagnosis-taxonomy>
- Active incident: <https://cognidao.org/work/items/bug.5442>
- Manual recovery ledger: <https://github.com/cogni-dao/cogni/pull/2719#issuecomment-6154522374>
- Candidate recovery ledger: <https://github.com/cogni-dao/cogni/pull/2719#issuecomment-6154601421>
- Poly bounded-query change: <https://github.com/cogni-dao/poly/pull/230>
- Durable recovery-guide draft: <https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-f06c70b4>

## Current State

- The 2026-10-13 outage was a shared production storage incident: Poly produced about 99% of Postgres reads; host load reached 103, I/O PSI full `avg10` reached 51.42, and a Postgres checkpoint took 184.854 seconds. Postgres, Temporal, workers, operator, and knowledge access stalled together.
- Production is one shared VM and disk for Postgres, Temporal Postgres, Redis, Doltgres, and other control-plane services. A logical database or role on that same disk is tenancy, not resource isolation.
- Emergency containment revoked Poly database logins, terminated only Poly sessions, and installed a source-specific production firewall fence. Ten non-Poly endpoints recovered to HTTP 200. These are reversible manual controls and are recorded in the recovery ledger.
- Poly candidate-a generation 40 was terminally spent. Recovery PR [#2723](https://github.com/cogni-dao/cogni/pull/2723) advances only candidate-a to generation 41; CI is green and it is first in the protected merge queue. The current incident owner is restoring Poly sequentially and will stop before reliability engineering.
- Poly PR [#230](https://github.com/cogni-dao/poly/pull/230) bounds its own query. That creates headroom but is not the platform guarantee: the operator must enforce safety even when node code is buggy or adversarial.
- Existing node-internal health and the Grafana fleet dashboard are useful signals, but they do not yet constitute admission control, automatic noisy-neighbor containment, or a directly consumable operator/node-developer product surface.
- No database rows, volumes, workloads, or logs were deleted during containment. Do not remove the active Poly fences until the incident owner has validated each environment and recorded rollback.

## Design / Implementation Target

1. Define the smallest standard control stack that can reject or throttle a node before shared Postgres, storage, Temporal, or the control plane loses SLO; explicitly compare managed/native primitives with bespoke controllers.
2. Define objective graduation thresholds for (a) increasing shared production VM/storage resources and (b) moving one node to its own database or substrate cell. Repeated neighbor impact must be a hard isolation trigger; more hardware alone must not be presented as isolation.
3. Preserve the product boundary: v0 may use Grafana for fleet operations, but v1 health, budgets, incidents, and remediation state must be available in the operator app and to node developers through authenticated node-scoped APIs.

## Next Actions / Risks

- [ ] Create and claim one operator story; persist the approved design-only Goal and Done when before researching solutions.
- [ ] Reconstruct a timestamped incident envelope from direct host/Kubernetes/Postgres/Temporal evidence and the recovery ledgers; separate measured facts from inference.
- [ ] Inventory the 13-slot health matrix and every current control: app readiness, node-internal health, fleet probes, database roles/timeouts, firewall fences, alerts, and missing automatic actions.
- [ ] Research authoritative Neon, Supabase, Vercel, PostgreSQL, PgBouncer, and cloud-block-storage patterns; prefer standard admission, workload isolation, and managed-service primitives.
- [ ] Produce a decision matrix for shared-pool limits, dedicated database, and dedicated substrate cell, including cost, blast radius, operator burden, migration reversibility, and failure containment.
- [ ] Set numeric trigger policies using measured demand and headroom: steady-state, peak, checkpoint latency, I/O PSI/latency, disk utilization, connection pressure, and any neighbor SLO breach.
- [ ] Define the automatic circuit-breaker state machine: observe → warn → throttle/reject → isolate → cautiously re-admit, with audit trail and no cardinality explosion.
- [ ] Define the canonical health contract behind Grafana, operator UI, and node-scoped API so all surfaces read one truth rather than duplicate logic.
- [ ] Pareto-rank the next 1–2 stories by fleet-risk reduction per engineering day, with before/after live proofs and rollback.
- [ ] Present the architecture and explicit non-goals to the CEO; do not implement until approved.
- Risk: scaling CPU/RAM/disk can buy recovery margin but can also hide an unchanged shared-fate architecture.
- Risk: Postgres role limits and query timeouts do not bound aggregate disk reads, write amplification, checkpoints, or Temporal's separate Postgres workload.
- Risk: per-node logical databases on one Postgres instance/disk do not stop storage noisy neighbors.
- Risk: app-side self-limiting is defense in depth, never the substrate enforcement boundary.
- Risk: redesign must not interfere with the live incident owner's fences, generation-41 recovery, or sequential re-admission.

## Pointers

| File / Resource                                            | Why it matters                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `infra/catalog/poly.yaml`                                  | Candidate lease generation and placement source of truth; do not edit during design. |
| `infra/grafana/alerts/fleet-capacity.alerts.yaml`          | Current fleet alert contract and evidence of what monitoring can/cannot guarantee.   |
| `tests/ci-invariants/grafana-fleet-alerts.spec.ts`         | Current alert invariant coverage.                                                    |
| `nodes/operator/app/src/app/api/v1/vcs/merge/route.ts`     | Example of operator-enforced policy and auditable privileged action.                 |
| [PR #2719](https://github.com/cogni-dao/cogni/pull/2719)   | Fleet serve alert plus complete manual incident comments.                            |
| [PR #2723](https://github.com/cogni-dao/cogni/pull/2723)   | Minimal candidate lease recovery; not the reliability architecture.                  |
| [Poly PR #230](https://github.com/cogni-dao/poly/pull/230) | Workload-side bounded-query mitigation; defense in depth only.                       |
| <https://cognidao.org/knowledge/shared-postgres-isolation> | Intended durable recovery guide if/when the open contribution is reviewed.           |
