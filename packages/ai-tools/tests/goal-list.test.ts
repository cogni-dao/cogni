// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/goal-list`
 * Purpose: core__goal_list reads only KnowledgeCapability.listActiveGoals and types the MAX_THREE_GOALS error.
 * Scope: Tool contract + implementation over a fake capability. Does not touch a store or the network.
 * Invariants: ONE_GOAL_LIST, MAX_THREE_GOALS_IS_AN_ERROR.
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

  it("maps the store's TOO_MANY_ACTIVE_GOALS to a typed too_many_active_goals error", async () => {
    const tooMany = Object.assign(
      new Error("4 active DAO goals exceed the max of 3"),
      {
        code: "TOO_MANY_ACTIVE_GOALS",
      }
    );
    const tool = createGoalListImplementation({
      knowledgeCapability: capability(async () => {
        throw tooMany;
      }),
    });
    await expect(tool.execute({})).rejects.toThrow(
      "too_many_active_goals: 4 active DAO goals exceed the max of 3"
    );
  });

  it("reports goals unavailable when the node has no goal reader", async () => {
    const tool = createGoalListImplementation({
      knowledgeCapability: capability(),
    });
    await expect(tool.execute({})).rejects.toThrow("goals_unavailable");
  });
});
