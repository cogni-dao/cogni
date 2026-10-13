# Independent review — contrib-flock-leader-conductor-c3c279b0

**Subject:** [Structural database isolation contains noisy neighbors](https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-c3c279b0) (entries `noisy-neighbor-database-architecture` + `noisy-neighbor-reliability-visual`, 8 citations)
**Parent:** [story.5085](https://cognidao.org/work/items/story.5085) · tasks 5246/5247 · incident [bug.5442](https://cognidao.org/work/items/bug.5442)
**Reviewer:** flock-leader (independent session; no involvement in authoring the design)
**Date:** 2026-10-13

## Verdict

**APPROVE the direction; amend the entry on 5 points before merge.** The core decision — two-tier state substrate with instance/host/volume isolation as the enforcement boundary and sticky graduation — is exactly what the top-0.1% platforms converged on. None of the amendments change the decision; they close over-claims and unspecified actuators that would otherwise bite during task.5246/5247.

## Industry comparison (the "would Supabase/Neon/Vercel do this?" test)

| Platform           | Their answer to noisy neighbors                                                                                                                                                                                                             | Matches this design?                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supabase**       | Never shares Postgres at all: [every project gets a dedicated Postgres instance in an isolated environment](https://supabase.com/docs/guides/platform/compute-and-disk); larger tiers get dedicated vCPU                                    | ✅ the silo tier is their default; Cogni's shared tier is the pragmatic MVP addition                                                                                |
| **Neon**           | [Per-tenant isolated compute; storage is shared only because they built a purpose-built multi-tenant Rust storage engine](https://neon.com/blog/noisy-neighbor-multitenant) with sharding and per-tenant QoS                                | ✅ the design correctly refuses to build that storage layer bespoke — vanilla Postgres has no per-tenant I/O QoS, so instance isolation is the only honest boundary |
| **AWS SaaS canon** | [Silo / pool / bridge tiered isolation](https://docs.aws.amazon.com/whitepapers/latest/multi-tenant-saas-storage-strategies/multitenancy-on-rds.html): pool small tenants with strict budgets, silo outliers, make graduation policy-driven | ✅ this is textbook tiered isolation with a hard graduation trigger                                                                                                 |
| **Vercel**         | Doesn't run tenant Postgres itself — delegates to Neon/partners; stateless compute isolated per-deployment                                                                                                                                  | ✅ analogous: app lane on Akash stays stateless; state moves to a dedicated cell                                                                                    |

The incident evidence seals the key claim: Poly produced ~99% of shared reads **while already under** `CONNECTION LIMIT 8`, 2s statement timeout, temp-file caps, and read-only mode. Postgres role budgets provably do not bound aggregate disk I/O, shared-buffer/WAL write amplification, or checkpoint pressure. Anyone proposing "tune the role limits harder" instead of isolation is proposing the thing that just failed. The entry's "Why workload throttling is insufficient" section is correct and well-evidenced.

## Mission / north-star alignment

- **"Every node builds its mission, not its plumbing"** ✅ — Poly's own bounded-query PR #230 is correctly demoted to defense-in-depth; the platform owns enforcement (`PLATFORM_ENFORCEMENT_NOT_NODE_COOPERATION` matches [node-baas-substrate-model](https://cognidao.org/knowledge/node-baas-substrate-model) ownership rule 4: shared infrastructure enforces budgets).
- **"Expensive nodes fail alone"** ✅ — the proof protocol literally asserts "Poly may fail alone, the fleet must not notice."
- **OSS-sovereign, no cloud-vendor custody** ✅ — Postgres, pgbench, Prometheus/Grafana, Pino/Loki; a self-hosted VM cell rather than Neon/RDS respects the standing red line (OpenBao-not-KMS precedent). Managed Postgres would be less ops burden but violates the sovereignty constraint; the entry should not relitigate this, and doesn't.
- **"Grafana/UI are projections, not sources of truth"** ✅ — `ReliabilityStatusV1` + shared recording rules + fail-closed missing data is the right one-truth shape, and directly addresses the known prod observability gap (bug.5165: every prod crash is SSH-and-guess).
- **Keeping state OFF Akash** ✅ and under-argued — poly's lease-generation churn (gen 39→40→41 in the same catalog file) is the proof that Akash leases are the wrong home for a Postgres volume. The entry should say this in one sentence; it's the strongest justification for the Cherry VM choice.

## Strengths worth keeping verbatim

1. Sticky graduation + "emergency capacity growth never cancels a satisfied trigger" — kills the classic failure mode of buying a bigger VM and declaring the problem solved.
2. The proof deliberately **bypasses** app throttles with a direct read role — correct falsification discipline; proves the platform boundary, not node cooperation.
3. Fenced cutover with no dual-write, read-only source through the rollback window, checksum comparison — standard, safe, boring. Good.
4. Low-cardinality invariant (incident/replay IDs in logs, never metric labels) — respects the known fleet cardinality constraint.
5. No bespoke fleet-wide circuit breaker — native Postgres ceilings + structural isolation is the minimum-bespoke answer the handoff asked for.

## Findings (ranked)

### F1 — The control plane still shares fate with the shared tier (amend: scope the invariant, name the residual risk)

`CONTROL_PLANE_OUTSIDE_NODE_FAILURE_DOMAIN` is only true **with respect to Poly**. Operator Postgres, Temporal persistence, Doltgres, Redis, and every small-node database remain on one VM and one disk — the exact shared-fate topology that [control-plane-self-starvation](https://cognidao.org/knowledge/control-plane-self-starvation) documents (including the 2026-09-24 shared-Postgres crash domain where one backend death took out operator readiness, OpenFGA, LiteLLM, and every node DB — a _non-Poly_ cause). Supabase/Neon/every platform put control-plane state in its own failure domain; Temporal's own production guidance is dedicated persistence. A shared-tier node or Doltgres itself can still stall the control plane tomorrow and no Poly cell helps.
**Ask:** rename/scope the invariant (e.g. `CONTROL_PLANE_OUTSIDE_GRADUATED_NODE_FAILURE_DOMAIN`) and add one line naming control-plane persistence as the standing next graduation candidate with the same trigger policy. Don't expand scope now — just stop the invariant from over-claiming.

### F2 — The shared-tier critical actuator is unspecified (amend: name who fences)

"A shared node that reaches critical **is fenced** and graduated" — passive voice hides the actuator. Native role ceilings reject _connections and statements_; nothing described automatically fences a tenant whose I/O dominates within its caps (today's exact failure shape). The handoff explicitly asked for the observe→warn→throttle→isolate→re-admit state machine; the entry defines thresholds and states but not the transition mechanism. Without it, the next noisy shared tenant is another 3am manual fence.
**Ask:** one sentence declaring v1 enforcement honestly — e.g. "critical pages a human; fencing is one audited operator action (revoke role logins + firewall fence, the proven 2026-10-13 runbook); automation of that action is explicitly deferred" — or commit it to task.5247's scope. Either is fine; silence is not.

### F3 — The proof validates the silo, not the pool (amend: add one shared-tier policy test)

The pgbench replay proves a dedicated cell can't hurt neighbors — largely true by construction once host/process/volume are separate. What the fleet actually relies on day-to-day after Poly graduates is the **shared-tier** warn/critical/fence policy, and nothing in the proof protocol exercises it. Relatedly, admission (15 min at 2× seven-day p95 rate) tests _rate_, not _shape_: Poly would have passed admission and still shipped the read-amplifying query later. That's acceptable — graduation exists precisely because admission can't prevent regressions — but the entry shouldn't imply otherwise, and "seven-day p95" is undefined for a newly admitted node.
**Ask:** add proof step: run a bounded hostile workload under a throwaway shared-tier role on candidate-a and verify warning/critical signals fire and the fence runbook contains it. Cheap, and it tests the half of the policy the fleet will actually live on.

### F4 — Cutover depends on a DSN-rotation path that doesn't exist yet (amend: sequence it in task.5246)

"Rotate only Poly's DSNs through the existing secret plane" assumes a rotation capability the fleet is known to lack: secret materialization is create-if-absent with no rotation path for substrate DB credentials, and the standing ESO/OpenBao constraint is that deploy-infra must not alter DB passwords. task.5246 must build audited DSN rotation **before** the cutover step, and the entry/task should say so explicitly rather than discover it mid-cutover.

### F5 — The design contradicts a committed spec non-goal (amend: ride a spec edit with task.5246)

[docs/spec/multi-node-tenancy.md](https://github.com/cogni-dao/cogni/blob/derekg1729/bug-5459-serve-alert/docs/spec/multi-node-tenancy.md) lists as an explicit **Non-Goal**: "Per-node Postgres servers (V1 uses per-node databases on a shared server)", and [docs/spec/databases.md](https://github.com/cogni-dao/cogni/blob/derekg1729/bug-5459-serve-alert/docs/spec/databases.md) defines DB*PER_NODE as "its own database on a shared Postgres server." The dedicated-cell decision deliberately supersedes that — correctly — but per the north-star source-of-truth boundary, git owns executable invariants, so leaving the spec non-goal intact creates a direct contradiction between hub canon and repo spec. The design otherwise composes cleanly with both specs: `DB_PER_NODE_REMAINS_DATA_BOUNDARY` preserves the no-tenancy-columns boundary, and DSN rotation reuses the existing `DATABASE_URL`/`DATABASE_SERVICE_URL` two-role contract unchanged.
**Ask:** task.5246 includes a one-line amendment to both specs (shared server → shared server \_or* operator-managed dedicated cell, tier declared in catalog).

### F6 — Minor (no amendment required, note for implementation)

- **Cell ops burden:** backup cadence, disk-growth/disk-full policy, and Postgres patching ownership for dedicated cells appear only implicitly (backup check inside re-admission). Each graduated tenant adds a VM to operate — fine at n=1, but it's the real cost axis the handoff's decision matrix asked for; cost is asserted, not quantified.
- **Thresholds are plausible but unvalidated** (PSI 10/20%, conns 60/75%, 25/40% share). Correctly labeled "Versioned policy v1"; recalibrate from recorded incident data after the first quarter rather than debating them now.
- **Self-review verdict inside the entry** ("Verdict: APPROVE") conflates author and reviewer; after this review lands, the embedded verdict should point at the independent review rather than self-certify.
- **Pooler:** no PgBouncer/Supavisor in front of the shared tier. Defensible — connections were not the failure mode, I/O was — but worth one line acknowledging the omission is deliberate.

## What I reviewed

Contribution diff (both entries + 8 citation edges, via `/api/v1/knowledge/contributions/.../diff`), [story.5085](https://cognidao.org/work/items/story.5085) and tasks 5246/5247, [node-baas-substrate-model](https://cognidao.org/knowledge/node-baas-substrate-model), [control-plane-self-starvation](https://cognidao.org/knowledge/control-plane-self-starvation), the substrate-reliability handoff (workspace file `work/handoffs/substrate-reliability-resilience.handoff.md`), [infra/catalog/poly.yaml](https://github.com/cogni-dao/cogni/blob/6a61a61dd3/infra/catalog/poly.yaml) (lease-generation churn evidence), [docs/spec/databases.md](https://github.com/cogni-dao/cogni/blob/derekg1729/bug-5459-serve-alert/docs/spec/databases.md) + [docs/spec/multi-node-tenancy.md](https://github.com/cogni-dao/cogni/blob/derekg1729/bug-5459-serve-alert/docs/spec/multi-node-tenancy.md) (story.5085 specRefs), and external: [Neon on noisy neighbors](https://neon.com/blog/noisy-neighbor-multitenant), [Neon architecture decisions](https://neon.com/blog/architecture-decisions-in-neon), [Supabase compute & disk](https://supabase.com/docs/guides/platform/compute-and-disk), [Supabase architecture](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/getting-started/architecture.mdx), [AWS multi-tenant SaaS storage strategies](https://docs.aws.amazon.com/whitepapers/latest/multi-tenant-saas-storage-strategies/multitenancy-on-rds.html).
