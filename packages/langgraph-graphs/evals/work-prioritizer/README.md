# work-prioritizer eval (external lane, design v4 §4, propose mode)

**How to run.** This is a black-box eval of the deployed `langgraph:work-prioritizer` at one build SHA. It is not part of PR CI, because it needs a live node, a node API key, and real model calls. It is excluded from the package build, typecheck, and vitest. Run `set -a; . ./.env.cogni; set +a; EVAL_EXPECTED_SHA=<flighted sha> pnpm eval:prioritizer -- --landed-at <ISO time the flight landed> --out /tmp/prioritizer-eval.json`. The expected SHA is required and is never read from live `/version`. `EVAL_BASE_URL` defaults to `https://test.cognidao.org`.

**What it does.** It first lists the node's `goal-*` atoms on the strategy shelf (dao-goals-design); with none it exits INCONCLUSIVE, because the graph would only report `no_goals`. It then sends `PRIORITIZE` plus the operator repo-spec policy, exactly as the governance schedule does, and runs three cycles:

1. **Full review on demand.** Cycle 1 adds `"fullReview": true`, so the graph re-judges the whole backlog and files a decision.
2. **Delta, unchanged.** Cycle 2 runs 61 s later on the same backlog. It is a delta cycle that must carry every judgment, call no model, and file nothing.
3. **Delta, with a change.** Cycle 3 seeds a live incident (a new item, so it is in the delta), runs one delta cycle, and always deletes the incident.

It then waits, with the SHA guarded, until the governance schedule has run the graph at least `minScheduledCycles` times at the SHA. Each cycle's outcome comes from the `<prioritizer_report>` that the graph pushes onto its own stream; `/api/v1/ai/runs` is only a fallback. If a scheduled cycle files first, the eval cycle ends `stale_prior` and is retried once. Decisions are graded with the pure graders in `score.ts`, which are tested in `tests/evals/work-prioritizer.score.test.ts`.

**Output.** A markdown scorecard goes to stdout. `--out` writes the JSON scorecard (build SHA, model, policy and prompt versions, decision ids, per-check results); don't commit it.

**The gate.** The eval passes only if every hard check and every behavioral check passes. Exit code: 0 = PASS, 1 = FAIL, 3 = INCONCLUSIVE. INCONCLUSIVE means the node has no goal atoms yet, or the candidate's `/version.buildSha` changed mid-run because another flight evicted the SHA under test. The eval checks the SHA before and after every cycle and stops without scoring.

| check                            | kind       | passes when                                                                                                                                                                              |
| -------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| coverage (full review)           | hard       | cycle 1 is `scope: full`; every actionable item has exactly one row and a judgment (or is listed unjudged)                                                                               |
| coverage (delta)                 | hard       | cycle 3 is `scope: delta`; 100% of the independently recomputed delta (p0/p1, unprioritized, changed, new) is re-considered; table still whole                                           |
| goal citation                    | hard       | every p0/p1 row carries `goal: goal-<slug>` from the cycle's active goal set, on cycles 1 and 3                                                                                          |
| no_goals                         | hard       | the cycle reports the goal ids it ranked against: non-empty, all `goal-*`, all active atoms on the node (the zero-goal path itself is unit-tested: it ends `no_goals` and files nothing) |
| rationale                        | hard       | every p0/p1 has an evidenced why-now; a p0 also needs an evidenced harm ≤ 7 days                                                                                                         |
| gates                            | hard       | no blocked, duplicate, fixture, or injection item at p0/p1                                                                                                                               |
| prior reference                  | hard       | `priorDecisionId` is set whenever a prior decision existed                                                                                                                               |
| unjudged                         | hard       | ≤ 10% of rows are unjudged                                                                                                                                                               |
| zero writes (propose)            | hard       | no work-item revision or status changes across the eval cycles                                                                                                                           |
| stability (2 cycles)             | behavioral | cycle 2 reuses every judgment (0 model calls), ends `no_change`, and keeps the same p0                                                                                                   |
| responsiveness                   | behavioral | the seeded live incident is judged expedite and reaches p0 in cycle 3's plan                                                                                                             |
| scheduled cycles at SHA ≥ 2      | hard       | the governance schedule ran the graph successfully ≥ `minScheduledCycles` times since `--landed-at`                                                                                      |
| harm evidence (full review)      | hard       | when the PM labels any p0, at least one full-review judgment carries harm (not "none"); guards the lost-harm parse                                                                       |
| p0 overlap with PM (full review) | behavioral | when the fixture's PM p0 set is non-empty, ≥ 1 full-review p0 pick is in it (an empty p0 fails); precision vs `p0PrecisionTarget` (2/3) is reported only                                 |
| write section (5 checks)         | skipped    | listed as skipped: the graph is propose-only. Applied rows, live backlog p0, applied responsiveness, observed A→B, and demotion return with a write path                                 |

`fixture.json` labels the candidate-a seeded backlog: the duplicates, the injection item, the fixtures, and the PM p0 set. Update it with a reasoned commit when that seed changes.
