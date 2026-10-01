---
id: bug.5293.handoff
type: handoff
work_item_id: bug.5293
status: active
created: 2026-10-01
updated: 2026-10-01
branch: derekg1729/bug5293-handoff
last_commit: ace47fd958
---

# Handoff: restore Poly production and prove its database substrate

## Mission

Pickup: own the incident end to end. Poly must serve the merged load-bounding fix again,
and its required Postgres, Doltgres, Redis, and Temporal persistence paths must be proven
healthy from the public service inward. A green PR, workflow, or Crossplane condition is
not completion.

## Goal

**One-hour recovery target:** Poly serves merged main SHA
`9033a16208bb234dd8fc04666bc3b9fc336b64f5`, `/readyz` returns 200, the old prune DELETE
retry-storm is absent, the allocation ledger emits no `ledger_unavailable`, and Postgres
adds zero exit-2 events for 15 minutes and then one hour.

**Full substrate closure:** emergency production settings are reverted; Doltgres has its
expected live schema plus committed migration history; Redis and Temporal connectivity are
proven; remaining wedged node Requests are released gradually only after the ledger is
stable. Tomorrow's final Postgres gate is rolling exit-2 `<=9/24h`.

Production proof:

- `https://poly.cognidao.org/version` has `buildSha=9033a162...`.
- `https://poly.cognidao.org/readyz` returns 200.
- Loki has no new Postgres exit-2, actuator `ledger_unavailable`, or repeating Poly prune
  DELETE during the observation windows.
- Live substrate checks prove Doltgres schema/`dolt_log`, Redis, and Temporal; do not infer
  health from containers or zero log lines.

## Start By Reading

- This handoff and the
  [prior handoff](archive/bug.5293/2026-10-01T22-24-36.md).
- `.context/bug5293-production-writes.md` — exact live-write ledger and rollbacks.
- `.context/bug5293-baseline.md` — measurement contract and incident chronology.
- [database-expert](../../../.agents/skills/database-expert/SKILL.md) and
  [promote](../../../.agents/skills/promote/SKILL.md).
- Hub entries `akash-prod-lease-recovery`, `control-plane-self-starvation`, and
  `prod-oom-misdiagnosis-taxonomy`.
- [Poly catalog row](../../../infra/catalog/poly.yaml) and
  [PR #2548](https://github.com/cogni-dao/cogni/pull/2548).
- [Poly #99](https://github.com/cogni-dao/poly/pull/99) — merged load-bound fix.

## Current State

| Item                       | Fact                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Poly public                | DOWN: `/version=eed16dc0`; `/readyz` times out/000                                                                                                                                          |
| Accepted Poly release      | main SHA `9033a162...`; XR already contains its valid bundle/artifact digest                                                                                                                |
| Rejected SHA               | PR head `670939a3...` has a real candidate-tested image but promote rejects it with HTTP 409 `non_forward_promotion` because it is not on main                                              |
| Lease                      | production generation 20 hit `BootDeadlineClosed`; its settled idempotency key is spent and cannot be replayed                                                                              |
| Recovery PR                | #2548 head `ace47fd958`; changes only `lease_generation.production: 20 -> 21` plus handoff docs; remote CI was still running when stopped                                                   |
| Postgres durable fix       | `/dev/shm=1GiB` live; container healthy; this fixed the shm maintenance cliff but did not explain every exit-2                                                                              |
| Current temporary DB state | `service_poly CONNECTION LIMIT 1`; `service_poly_candidate_a=-1`; `max_parallel_workers_per_gather=2` (default restored)                                                                    |
| Why cap remains            | uncapping immediately restarted the old `DELETE FROM poly_trader_position_snapshots ... EXISTS` query; it was terminated and the known bridge cap restored                                  |
| Request mutation           | removed `external-create-pending` and set `cogni.io/reconcile-nudge` on Request `...-489bd369b815`; inspection showed it is the composition `dns-record` Request, not a fresh compute lease |
| Pre-cutover signal         | zero Postgres exit-2 and zero actuator `ledger_unavailable` in the 15-minute window checked around 22:17Z                                                                                   |
| Active processes           | none; the GitHub check watcher was stopped                                                                                                                                                  |

Live writes performed during this pickup:

1. Restored both roles to `-1` and reset query parallelism to default 2.
2. The old Poly DELETE immediately returned, so `service_poly` was deliberately restored to
   limit 1 and that DELETE backend was terminated. Candidate-a remains `-1`; parallelism
   remains default 2.
3. No ANALYZE, new GUC, index, schema, or data mutation was performed.

## Design / Implementation Target

1. Merge generation-21 only through the operator merge endpoint. Do not use personal
   `gh merge` or hand-edit a deploy branch.
2. Promote Poly main SHA `9033a162...` through `POST /api/v1/deploy/promote`; never retry
   non-main `670939a3...`.
3. Keep the one-connection bridge while CI/auction is idle. During gen-21 boot, terminate
   stale old-build sessions, restore `service_poly CONNECTION LIMIT -1`, and verify the
   effective role setting. The new app cannot serve under a one-connection cap.
4. Trust public `/version` and `/readyz`, not the latched XR `phase=Failed` or a green
   workflow. Generation 21 must create a new lease and observe `9033a162...`.
5. Hold the production-tuning freeze: no ANALYZE, GUC experiments, new indexes, VM resize,
   or theory-driven writes. If exit-2 persists after #99, capture the first dying backend's
   PID/signal/core evidence before proposing a global change.
6. Prove Doltgres migration step, expected tables, migration tracking, and `dolt_log`;
   prove Redis and Temporal connectivity. Silence is blindness, not health.
7. Release other wedged nodes one at a time only after the allocation ledger is stable.
8. Preserve the north star: shared Postgres is metered and bounded, then measured outliers
   graduate; emergency manual caps are not the lasting design.

## Next Actions / Risks

- [ ] Inspect PR #2548 remote checks; do not run local `check` or `check:fast` on the
      resource-constrained device.
- [ ] When green, request merge with `POST /api/v1/vcs/merge {nodeId:"operator",prNumber:2548}`
      and wait for the merge queue to finish.
- [ ] Confirm main contains `lease_generation.production: 21`.
- [ ] Promote Poly source SHA `9033a16208bb234dd8fc04666bc3b9fc336b64f5` through the
      operator API and arm a remote monitor.
- [ ] Observe a fresh gen-21 resource/DSEQ; then remove the service-role cap as part of boot,
      not minutes beforehand.
- [ ] Prove `/version`, `/readyz`, ledger, prune-query absence, and 15m/1h crash windows.
- [ ] Prove Doltgres/Redis/Temporal substrate before claiming the whole node healthy.
- [ ] Update `bug.5293` outcome with facts; keep the rolling 24h gate open until tomorrow.

Risks: Akash may produce no acceptable FI/NL/PT bid; gen-21 may boot but fail egress or
migrations; uncapping too early restarts the old DELETE storm; XR failure state can remain
latched even while public function recovers; exit-2 has not been mechanically attributed.
