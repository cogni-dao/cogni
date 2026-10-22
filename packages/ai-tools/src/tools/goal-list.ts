// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/goal-list`
 * Purpose: AI tool that lists the node's approved DAO goals (dao-goals-design) — the one goal reader every AI loop uses.
 * Scope: Read-only over `KnowledgeCapability.listActiveGoals`. Does not search knowledge text or import any node or store package.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__goal_list`
 *   - EFFECT_TYPED: effect is `read_only`; `requires: "node.collaborate"`
 *   - ONE_GOAL_LIST: goals come only from the capability's `listActiveGoals()` (merged `goal-*`, not deprecated)
 *   - NO_GOAL_CAP: the tool never counts or truncates goals; a reader failure is a tool error
 * Side-effects: IO (reads goals via capability)
 * Links: https://cognidao.org/knowledge/dao-goals-design, task.5287, story.5096
 * @public
 */

import { z } from "zod";

import type { KnowledgeCapability } from "../capabilities/knowledge";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

export const GoalListInputSchema = z.object({}).strict();
export type GoalListInput = z.infer<typeof GoalListInputSchema>;

export const GoalListOutputSchema = z.object({
  goals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      evaluateAt: z.string().nullable(),
      content: z.string(),
    })
  ),
});
export type GoalListOutput = z.infer<typeof GoalListOutputSchema>;

export const GOAL_LIST_NAME = "core__goal_list" as const;

export const goalListContract: ToolContract<
  typeof GOAL_LIST_NAME,
  GoalListInput,
  GoalListOutput,
  GoalListOutput
> = {
  name: GOAL_LIST_NAME,
  description:
    "List the node's approved DAO goals: id, title, deadline, and statement with KPI and target.",
  effect: "read_only",
  requires: "node.collaborate",
  inputSchema: GoalListInputSchema,
  outputSchema: GoalListOutputSchema,
  redact: (output) => output,
  allowlist: ["goals"] as const,
};

export interface GoalListDeps {
  readonly knowledgeCapability: KnowledgeCapability;
}

export function createGoalListImplementation(
  deps: GoalListDeps
): ToolImplementation<GoalListInput, GoalListOutput> {
  return {
    execute: async () => {
      const list = deps.knowledgeCapability.listActiveGoals;
      if (!list)
        throw new Error("goals_unavailable: no goal reader on this node");
      const goals = await list.call(deps.knowledgeCapability);
      return {
        goals: goals.map(({ id, title, evaluateAt, content }) => ({
          id,
          title,
          evaluateAt,
          content,
        })),
      };
    },
  };
}

export const goalListStubImplementation: ToolImplementation<
  GoalListInput,
  GoalListOutput
> = {
  execute: async () => {
    throw new Error("goals_unavailable: KnowledgeCapability not configured.");
  },
};

export const goalListBoundTool: BoundTool<
  typeof GOAL_LIST_NAME,
  GoalListInput,
  GoalListOutput,
  GoalListOutput
> = {
  contract: goalListContract,
  implementation: goalListStubImplementation,
};
