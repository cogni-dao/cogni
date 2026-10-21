// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/evals/work-prioritizer.score`
 * Purpose: Tests for the work-prioritizer eval graders, including the write section the propose eval skips.
 * Scope: Pure grader tests over hand-made decisions; does not call a node or an LLM.
 * Invariants: GRADERS_ARE_PURE; each check fails for exactly the defect it names.
 * Side-effects: none
 * Links: evals/work-prioritizer/score.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  cycleStampsForRun,
  type Fixture,
  gradeAppliedMatchesTable,
  gradeCoverage,
  gradeDeltaCoverage,
  gradeGates,
  gradeGoalCitation,
  gradeGoalsReported,
  gradeHarmEvidence,
  gradeIncidentApplied,
  gradeIncidentDemoted,
  gradeObservedStability,
  gradePriorReference,
  gradeRationale,
  gradeResponsiveness,
  gradeStability,
  gradeUnjudged,
  gradeZeroWrites,
  infoLevelCounts,
  infoPmOverlap,
  mergeLabelled,
  scorecardMarkdown,
  standingDecisionId,
} from "../../evals/work-prioritizer/score";
import type {
  DecisionPayload,
  RankedRow,
} from "../../src/graphs/work-prioritizer/schema";

const R = "goal-substrate-reliability";

function row(
  itemId: string,
  to: number,
  o: Partial<RankedRow> = {}
): RankedRow {
  return {
    itemId,
    revision: 1,
    from: null,
    to,
    rank: 1,
    pinned: false,
    serviceClass: "standard",
    maxImpact: 2,
    goal: R,
    effort: "M",
    whyNow: { text: "w", evidenceId: itemId },
    harmIfWait: {
      text: "h",
      evidenceId: itemId,
      withinDays: to === 0 ? 2 : null,
    },
    reasons: [],
    ...o,
  };
}

function decision(
  table: RankedRow[],
  o: Partial<DecisionPayload> = {}
): DecisionPayload {
  return {
    schemaVersion: "work-prioritizer.decision/v2",
    status: "planned",
    mode: "propose",
    scope: "full",
    reviewedAt: "2026-10-20T00:01:00.000Z",
    delta: table.map((r) => r.itemId),
    heuristic: "lexicographic heuristic v2",
    policyVersion: "v4.0",
    promptVersion: "p",
    modelRef: "m",
    cycleId: "c",
    snapshotId: "s",
    priorDecisionId: "work-prioritizer-20261020t1000-decision",
    goals: [R],
    plan: [],
    table,
    diffVsPrior: [],
    contextConsumed: {
      workItemIds: table.map((r) => r.itemId),
      knowledgeIds: [R],
      edoIds: [],
    },
    judgments: table.map((r) => ({
      itemId: r.itemId,
      revision: r.revision,
      judgment: {
        itemId: r.itemId,
        impact: { [R]: 2 },
        serviceClass: "standard",
        fixedDate: null,
        effort: "M",
        whyNow: { text: "w", evidenceId: r.itemId },
        harmIfWait: { text: "h", evidenceId: r.itemId, withinDays: null },
        supersededBy: null,
      },
    })),
    unjudged: [],
    ...o,
  };
}

const SNAPSHOT = [
  { id: "bug.1", status: "needs_implement", revision: 1 },
  { id: "bug.2", status: "needs_implement", revision: 1 },
  { id: "task.3", status: "needs_design", revision: 1 },
];
const GOOD = decision([row("bug.1", 0), row("bug.2", 1), row("task.3", 2)]);
const FIXTURE: Fixture = {
  duplicateGroups: [{ items: ["bug.1", "bug.9"] }],
  injectionItems: [{ id: "task.5006" }],
  fixtureItems: [{ id: "task.5010" }],
  pmLabels: { p0: ["bug.1", "bug.5"], goals: [R] },
};

describe("work-prioritizer graders", () => {
  it("a good decision passes every hard check", () => {
    expect(gradeCoverage(GOOD, SNAPSHOT).pass).toBe(true);
    expect(gradeGoalCitation(GOOD).pass).toBe(true);
    expect(gradeGoalsReported(GOOD.goals, [R]).pass).toBe(true);
    expect(gradeRationale(GOOD).pass).toBe(true);
    expect(gradeGates(GOOD, SNAPSHOT, FIXTURE).pass).toBe(true);
    expect(gradePriorReference(GOOD, true).pass).toBe(true);
  });

  it("full-review coverage fails on a missing, duplicated, or unjudged row, or a delta scope; ignores non-actionable items", () => {
    expect(
      gradeCoverage(decision([row("bug.1", 0)]), SNAPSHOT).reason
    ).toContain("bug.2: no row");
    expect(
      gradeCoverage(decision([...GOOD.table, row("bug.1", 3)]), SNAPSHOT).reason
    ).toContain("bug.1: duplicate rows");
    expect(
      gradeCoverage({ ...GOOD, judgments: GOOD.judgments.slice(1) }, SNAPSHOT)
        .reason
    ).toContain("bug.1: not judged");
    // Listed as unjudged is accounted for (UNJUDGED_IS_EXPLICIT).
    expect(
      gradeCoverage(
        { ...GOOD, judgments: GOOD.judgments.slice(1), unjudged: ["bug.1"] },
        SNAPSHOT
      ).pass
    ).toBe(true);
    expect(gradeCoverage({ ...GOOD, scope: "delta" }, SNAPSHOT).pass).toBe(
      false
    );
    expect(
      gradeCoverage(GOOD, [...SNAPSHOT, { id: "x", status: "done" }]).pass
    ).toBe(true);
  });

  it("delta coverage: every expected delta item (p0/p1, unprioritized, changed, new) re-considered; whole table ranked", () => {
    const prior = decision([
      row("bug.1", 0),
      row("bug.2", 3),
      row("task.3", 3),
    ]);
    const snap = [
      { id: "bug.1", status: "needs_implement", revision: 1, priority: 0 },
      { id: "bug.2", status: "needs_implement", revision: 1, priority: 3 },
      { id: "task.3", status: "needs_design", revision: 2, priority: 3 },
      { id: "new.4", status: "needs_triage", revision: 1, priority: null },
    ];
    const table = [
      row("bug.1", 0),
      row("bug.2", 3),
      row("task.3", 3, { revision: 2 }),
      row("new.4", 2),
    ];
    const good = decision(table, {
      scope: "delta",
      delta: ["bug.1", "task.3", "new.4"],
    });
    expect(gradeDeltaCoverage(good, prior, snap).pass).toBe(true);
    // task.3 changed revision but was not re-considered.
    expect(
      gradeDeltaCoverage({ ...good, delta: ["bug.1", "new.4"] }, prior, snap)
        .reason
    ).toContain("task.3: not in delta");
    // The carried rows must still be in the whole table.
    expect(
      gradeDeltaCoverage(
        decision(table.slice(0, 3), { scope: "delta", delta: good.delta }),
        prior,
        snap
      ).reason
    ).toContain("new.4: no row");
    expect(gradeDeltaCoverage(GOOD, prior, snap).pass).toBe(false);
    expect(gradeDeltaCoverage(good, null, snap).pass).toBe(false);
  });

  it("goal citation: every p0/p1 cites a goal-* id from the cycle's active set", () => {
    expect(
      gradeGoalCitation(decision([row("bug.1", 1, { goal: "goal-other" })]))
        .reason
    ).toContain("bug.1 at p1 cites goal-other");
    expect(
      gradeGoalCitation(decision([row("bug.1", 0, { goal: null })])).pass
    ).toBe(false);
    expect(
      gradeGoalCitation(
        decision([row("bug.1", 1, { goal: "dao-goal-x" })], {
          goals: ["dao-goal-x"],
        })
      ).pass
    ).toBe(false);
    expect(
      gradeGoalCitation(decision([row("bug.1", 3, { goal: null })])).pass
    ).toBe(true);
  });

  it("no_goals (live half): the cycle reports non-empty goal-* ids that are active atoms on the node", () => {
    expect(gradeGoalsReported([], [R]).pass).toBe(false);
    expect(gradeGoalsReported(["dao-goal-a"], ["dao-goal-a"]).pass).toBe(false);
    expect(gradeGoalsReported(["goal-ghost"], [R]).pass).toBe(false);
  });

  it("rationale fails for an unevidenced why-now, or p0 without ≤7-day harm", () => {
    expect(
      gradeRationale(
        decision([
          row("bug.1", 1, { whyNow: { text: "w", evidenceId: "ghost" } }),
        ])
      ).pass
    ).toBe(false);
    expect(
      gradeRationale(
        decision([
          row("bug.1", 0, {
            harmIfWait: { text: "h", evidenceId: "bug.1", withinDays: 30 },
          }),
        ])
      ).pass
    ).toBe(false);
    expect(
      gradeRationale(decision([row("bug.1", 3, { goal: null })])).pass
    ).toBe(true);
  });

  it("gates fail for a blocked, duplicate, fixture, or injection item at p0/p1", () => {
    for (const [id, snap] of [
      ["bug.9", SNAPSHOT],
      ["task.5010", SNAPSHOT],
      ["task.5006", SNAPSHOT],
      ["bug.2", [{ id: "bug.2", status: "blocked" }]],
    ] as const) {
      expect(gradeGates(decision([row(id, 1)]), snap, FIXTURE).pass).toBe(
        false
      );
    }
    expect(
      gradeGates(decision([row("bug.9", 4)]), SNAPSHOT, FIXTURE).pass
    ).toBe(true);
  });

  it("prior reference fails only when a prior decision existed", () => {
    const none = decision(GOOD.table, { priorDecisionId: null });
    expect(gradePriorReference(none, true).pass).toBe(false);
    expect(gradePriorReference(none, false).pass).toBe(true);
  });

  it("zero writes fails on any revision/status change", () => {
    const after = [
      { ...SNAPSHOT[0], revision: 2 } as (typeof SNAPSHOT)[number],
      ...SNAPSHOT.slice(1),
    ];
    expect(gradeZeroWrites(SNAPSHOT, SNAPSHOT).pass).toBe(true);
    expect(gradeZeroWrites(SNAPSHOT, after).reason).toContain("bug.1");
  });

  it("stability needs cycle 2 = no_change, zero model judgments, same p0", () => {
    const c1 = { status: "planned", p0: ["bug.1"] };
    expect(
      gradeStability(c1, {
        status: "no_change",
        judgedByModel: 0,
        p0: ["bug.1"],
      }).pass
    ).toBe(true);
    expect(
      gradeStability(c1, { status: "planned", judgedByModel: 0, p0: ["bug.1"] })
        .pass
    ).toBe(false);
    expect(
      gradeStability(c1, {
        status: "no_change",
        judgedByModel: 3,
        p0: ["bug.1"],
      }).pass
    ).toBe(false);
    expect(
      gradeStability(c1, {
        status: "no_change",
        judgedByModel: 0,
        p0: ["bug.2"],
      }).pass
    ).toBe(false);
    expect(gradeStability(null, null).pass).toBe(false);
  });

  it("responsiveness needs the seeded incident judged expedite and at p0", () => {
    expect(
      gradeResponsiveness(
        decision([row("bug.9", 0, { serviceClass: "expedite" })]),
        "bug.9"
      ).pass
    ).toBe(true);
    expect(gradeResponsiveness(decision([row("bug.9", 0)]), "bug.9").pass).toBe(
      false
    );
    expect(
      gradeResponsiveness(
        decision([row("bug.9", 1, { serviceClass: "expedite" })]),
        "bug.9"
      ).pass
    ).toBe(false);
    expect(gradeResponsiveness(null, "bug.9").pass).toBe(false);
  });

  it("PM p0 oracle overlap is informational: hit count + whether it was authored for the run's goals", () => {
    const d = decision([row("bug.1", 0), row("bug.2", 1)]);
    const same = infoPmOverlap(d, FIXTURE.pmLabels);
    expect(same).toEqual({
      pass: true,
      reason:
        "1/2 of {bug.1, bug.5} at p0 (bug.1); oracle authored for these goals",
    });
    const other = infoPmOverlap(d, { p0: ["bug.5"], goals: ["goal-other"] });
    expect(other.pass).toBe(true);
    expect(other.reason).toBe(
      "0/1 of {bug.5} at p0 (none); oracle authored for other goals {goal-other}"
    );
    // An empty p0 is a correct answer — still not a failure.
    expect(
      infoPmOverlap(decision([row("bug.2", 1)]), FIXTURE.pmLabels).pass
    ).toBe(true);
  });

  it("level counts are reported for the full review", () => {
    expect(
      infoLevelCounts(
        decision([
          row("bug.1", 0),
          row("bug.2", 1),
          row("t.3", 2),
          row("t.4", 2),
        ])
      ).reason
    ).toBe("p0 1 · p1 1 · p2 2 · p3 0 · p4 0");
  });

  it("STANDING_DECISION: a no_change cycle stands on its prior reference (else cycle 1's id), never the newest shelf entry", () => {
    expect(
      standingDecisionId({ status: "planned", decisionId: "d-new" }, "c1")
    ).toBe("d-new");
    expect(
      standingDecisionId(
        {
          status: "no_change",
          decisionId: null,
          priorDecisionId: "work-prioritizer-20261021t2231-decision",
        },
        "c1"
      )
    ).toBe("work-prioritizer-20261021t2231-decision");
    expect(
      standingDecisionId(
        { status: "no_change", decisionId: null },
        "work-prioritizer-20261021t2231-decision"
      )
    ).toBe("work-prioritizer-20261021t2231-decision");
    expect(
      standingDecisionId({ status: "stale_prior", decisionId: null }, "c1")
    ).toBeNull();
    expect(standingDecisionId(null, "c1")).toBeNull();
  });

  it("harm evidence (informational): counts judgments with harm; 'all none' is flagged", () => {
    const allNone = decision([row("bug.1", 2), row("bug.2", 2)]);
    const none = {
      ...allNone,
      judgments: allNone.judgments.map((j) => ({
        ...j,
        judgment: {
          ...j.judgment,
          harmIfWait: { text: "none", evidenceId: j.itemId, withinDays: null },
        },
      })),
    };
    expect(gradeHarmEvidence(none, ["bug.1"]).pass).toBe(false);
    expect(gradeHarmEvidence(none, []).pass).toBe(true);
    const one = {
      ...none,
      judgments: [
        {
          ...(none.judgments[0] as (typeof none.judgments)[number]),
          judgment: {
            ...(none.judgments[0]
              ?.judgment as (typeof none.judgments)[number]["judgment"]),
            harmIfWait: {
              text: "503s for users",
              evidenceId: "bug.1",
              withinDays: 1,
            },
          },
        },
        ...none.judgments.slice(1),
      ],
    };
    expect(gradeHarmEvidence(one, ["bug.1"]).pass).toBe(true);
  });

  it("the markdown scorecard", () => {
    const md = scorecardMarkdown({
      buildSha: "abc",
      baseUrl: "u",
      model: "m",
      policyVersion: "v4.0",
      promptVersion: "p",
      mode: "propose",
      decisionIds: ["d1"],
      checks: {
        coverage: { pass: true, reason: "ok" },
        gates: { pass: false, reason: "x|y" },
      },
      skipped: ["responsiveness (applied)"],
      soft: {},
      pass: false,
    });
    expect(md).toContain("FAIL");
    expect(md).toContain("| gates | **FAIL** | x/y |");
    expect(md).toContain("| responsiveness (applied) | skipped |");
  });

  // ── WRITE SECTION (skipped by the propose eval; gates again once a write path exists) ──

  it("write mode: applied rows must match the decision table and be live unless superseded", () => {
    const record = {
      decisionId: "d",
      status: "applied",
      applied: [{ itemId: "bug.1", to: 0, newRevision: 2 }],
    };
    const live = [
      { id: "bug.1", status: "needs_implement", revision: 2, priority: 0 },
    ];
    expect(gradeAppliedMatchesTable(record, GOOD, live).pass).toBe(true);
    // Table says p1 but p0 was applied.
    expect(
      gradeAppliedMatchesTable(
        { ...record, applied: [{ itemId: "bug.2", to: 0, newRevision: 2 }] },
        GOOD,
        live
      ).pass
    ).toBe(false);
    // Live value differs and nothing superseded it.
    expect(
      gradeAppliedMatchesTable(record, GOOD, [
        { ...live[0], priority: 2 } as (typeof live)[number],
      ]).pass
    ).toBe(false);
    // A later human edit (higher revision) is allowed to differ.
    expect(
      gradeAppliedMatchesTable(record, GOOD, [
        { ...live[0], priority: 2, revision: 3 } as (typeof live)[number],
      ]).pass
    ).toBe(true);
    expect(gradeAppliedMatchesTable(null, GOOD, live).pass).toBe(false);
  });

  it("unjudged must stay ≤ 10% of rows", () => {
    const table = Array.from({ length: 20 }, (_, i) => row(`t.${i}`, 3));
    expect(
      gradeUnjudged(decision(table, { unjudged: ["t.1", "t.2"] })).pass
    ).toBe(true);
    expect(
      gradeUnjudged(decision(table, { unjudged: ["t.1", "t.2", "t.3"] })).pass
    ).toBe(false);
  });

  it("observe mode: a scheduled run maps to the cycle stamps of its minutes", () => {
    expect(
      cycleStampsForRun({
        startedAt: "2026-10-21T03:00:04.120Z",
        completedAt: "2026-10-21T03:02:10.000Z",
        status: "success",
      })
    ).toEqual(["20261021t0300", "20261021t0301", "20261021t0302"]);
  });

  it("observe mode: B is no_change, or keeps A's p0 unless an item changed", () => {
    const a = {
      id: "work-prioritizer-20261021t0300-decision",
      payload: GOOD,
      apply: {
        decisionId: "work-prioritizer-20261021t0300-decision",
        status: "applied",
        applied: [{ itemId: "bug.1", to: 0, newRevision: 2 }],
      },
    };
    expect(
      gradeObservedStability(a, { status: "success", payload: null }).pass
    ).toBe(true);
    // B saw bug.1 at the revision A's own apply produced → nothing changed → p0 must hold.
    const moved = decision([
      row("bug.1", 1, { revision: 2 }),
      row("bug.2", 0),
      row("task.3", 2),
    ]);
    expect(
      gradeObservedStability(a, { status: "success", payload: moved }).pass
    ).toBe(false);
    // A human edit bumped bug.2 → p0 may move.
    const edited = decision([
      row("bug.1", 1, { revision: 2 }),
      row("bug.2", 0, { revision: 5 }),
      row("task.3", 2),
    ]);
    expect(
      gradeObservedStability(a, { status: "success", payload: edited }).pass
    ).toBe(true);
    expect(gradeObservedStability(a, null).pass).toBe(false);
    expect(gradeObservedStability(null, null).pass).toBe(false);
  });

  it("observe mode: the incident must be expedite p0, applied, live; then dropped after delete", () => {
    const table = decision([
      row("bug.1", 1),
      row("bug.77", 0, { serviceClass: "expedite" }),
    ]);
    const apply = {
      decisionId: "d",
      status: "applied",
      applied: [{ itemId: "bug.77", to: 0, newRevision: 2 }],
    };
    const live = [{ id: "bug.77", status: "needs_triage", priority: 0 }];
    expect(gradeIncidentApplied(table, apply, live, "bug.77").pass).toBe(true);
    expect(gradeIncidentApplied(table, null, live, "bug.77").pass).toBe(false);
    expect(
      gradeIncidentApplied(
        table,
        apply,
        [{ id: "bug.77", status: "needs_triage", priority: 2 }],
        "bug.77"
      ).pass
    ).toBe(false);
    expect(gradeIncidentDemoted(table, "bug.77").pass).toBe(false);
    expect(gradeIncidentDemoted(GOOD, "bug.77").pass).toBe(true);
    expect(gradeIncidentDemoted(null, "bug.77").pass).toBe(false);
  });

  it("mergeLabelled passes a check only when every labelled cycle passes it", () => {
    const m = mergeLabelled([
      ["A", { coverage: { pass: true, reason: "ok" } }],
      ["B", { coverage: { pass: false, reason: "missing x" } }],
    ]);
    expect(m.coverage).toEqual({
      pass: false,
      reason: "A: ok; B: missing x",
    });
  });
});
