// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/evals/cogni-coverage-grader`
 * Purpose: Lock the systematic-knowledge-gathering metric, incl. the grader counterexample
 *   as a FAILING control.
 * Scope: Pure unit test over the coverage-grader. Does NOT run the graph, call tools, or hit the network.
 * Invariants:
 *   - FAILING_CONTROL: the grader counterexample must score fail, so a silent pass can never regress in.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/bug.5542
 */
import { describe, expect, it } from "vitest";
import {
  gradeCoverage,
  type ToolEvent,
} from "../../evals/cogni/coverage-grader";

/** A run that fully reads every plane and cites what it read. */
const fullCoverageEvents: ToolEvent[] = [
  { name: "core__goal_list", ok: true },
  {
    name: "core__knowledge_read",
    ok: true,
    fullBody: true,
    id: "mission-loop-roadmap",
  },
  { name: "core__knowledge_contribution_read", ok: true },
  { name: "core__work_item_query", ok: true },
  { name: "core__work_item_read", ok: true, fullBody: true, id: "task.5367" },
  { name: "core__node_code_list", ok: true },
  {
    name: "core__node_code_read",
    ok: true,
    fullBody: true,
    id: "repo@sha:cogni.ts",
  },
];

describe("cogni coverage grader — systematic knowledge gathering", () => {
  it("PASSES a run that full-reads all five planes and grounds its citations", () => {
    const g = gradeCoverage(fullCoverageEvents, {
      status: "proposed",
      items: [{ sourceIds: ["task.5367"] }],
    });
    expect(g.grade).toBe("pass");
    expect(g.coverage).toBe(1);
    expect(g.grounding).toBe(1);
    expect(g.planesMissed).toEqual([]);
  });

  // The reviewer's counterexample: empty search, zero work-item reads, repeated ids,
  // blank next actions earned five perfect scores under the old grader. It MUST NOT pass.
  it("FAILS the grader counterexample (empty search, zero reads, repeated ids)", () => {
    const g = gradeCoverage([{ name: "core__knowledge_search", ok: true }], {
      status: "proposed",
      items: [
        { sourceIds: ["task.1"] },
        { sourceIds: ["task.1"] },
        { sourceIds: ["task.1"] },
      ],
    });
    expect(g.grade).not.toBe("pass");
    expect(g.grade).toBe("fail");
    expect(g.coverage).toBe(0);
    expect(g.grounding).toBe(0);
    expect(g.citedUnread).toContain("task.1");
  });

  it("FAILS a shallow run that skips a plane (git unread)", () => {
    const g = gradeCoverage(
      fullCoverageEvents.filter((e) => !e.name.startsWith("core__node_code")),
      { status: "proposed", items: [{ sourceIds: ["task.5367"] }] }
    );
    expect(g.grade).toBe("fail");
    expect(g.coverage).toBeCloseTo(0.8);
    expect(g.planesMissed).toEqual(["git"]);
  });

  it("FAILS when a cited source was only listed/searched, never full-read", () => {
    const g = gradeCoverage(fullCoverageEvents, {
      status: "proposed",
      items: [{ sourceIds: ["task.9999"] }], // never full-read
    });
    expect(g.grade).toBe("fail");
    expect(g.grounding).toBe(0);
    expect(g.citedUnread).toEqual(["task.9999"]);
  });

  it("is UNSCORABLE for an errored/empty run, never a silent pass", () => {
    expect(gradeCoverage([], { status: "proposed", items: [] }).grade).toBe(
      "unscorable"
    );
    expect(
      gradeCoverage(fullCoverageEvents, { status: "incomplete", items: [] })
        .grade
    ).toBe("unscorable");
  });
});
