// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/goal-list`
 * Purpose: core__goal_list reads only KnowledgeCapability.listActiveGoals and never counts or caps goals.
 * Scope: Tool contract + implementation over a fake capability. Does not touch a store or the network.
 * Invariants: ONE_GOAL_LIST, NO_GOAL_CAP.
 * Side-effects: none
 * Links: src/tools/goal-list.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import type { KnowledgeCapability } from "../src/capabilities/knowledge";
import {
  createGoalListImplementation,
  goalListContract,
} from "../src/tools/goal-list";

const unused = () => {
  throw new Error("not used");
};
const capability = (
  listActiveGoals?: KnowledgeCapability["listActiveGoals"]
): KnowledgeCapability => ({
  search: unused,
  list: unused,
  get: unused,
  write: unused,
  ...(listActiveGoals ? { listActiveGoals } : {}),
});

describe("core__goal_list", () => {
  it("is a read-only node.collaborate tool returning id, title, evaluateAt, content", async () => {
    expect(goalListContract).toMatchObject({
      name: "core__goal_list",
      effect: "read_only",
      requires: "node.collaborate",
    });
    const tool = createGoalListImplementation({
      knowledgeCapability: capability(async () => [
        {
          id: "goal-a",
          title: "Goal: a",
          content: "KPI x",
          evaluateAt: "2026-12-31T00:00:00.000Z",
        },
      ]),
    });
    const out = await tool.execute({});
    expect(goalListContract.outputSchema.parse(out)).toEqual({
      goals: [
        {
          id: "goal-a",
          title: "Goal: a",
          evaluateAt: "2026-12-31T00:00:00.000Z",
          content: "KPI x",
        },
      ],
    });
  });

  it("NO_GOAL_CAP: returns every goal the reader lists; a reader failure is a plain tool error", async () => {
    const many = ["a", "b", "c", "d", "e"].map((x) => ({
      id: `goal-${x}`,
      title: `Goal: ${x}`,
      content: "c",
      evaluateAt: null,
    }));
    const tool = createGoalListImplementation({
      knowledgeCapability: capability(async () => many),
    });
    expect((await tool.execute({})).goals).toHaveLength(5);
    const failing = createGoalListImplementation({
      knowledgeCapability: capability(async () => {
        throw new Error("doltgres busy");
      }),
    });
    await expect(failing.execute({})).rejects.toThrow("doltgres busy");
  });

  it("reports goals unavailable when the node has no goal reader", async () => {
    const tool = createGoalListImplementation({
      knowledgeCapability: capability(),
    });
    await expect(tool.execute({})).rejects.toThrow("goals_unavailable");
  });
});
