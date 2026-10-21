// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/work-item-query`
 * Purpose: AI tool that lists/searches work items with filters.
 * Scope: Read-only work item listing. Does not mutate items or import LangChain.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__work_item_query`
 *   - EFFECT_TYPED: effect is `read_only`
 * Side-effects: IO (reads work items via capability)
 * Links: docs/spec/development-lifecycle.md
 * @public
 */

import { z } from "zod";

import type { WorkItemCapability } from "../capabilities/work-item";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const WorkItemQueryInputSchema = z.object({
  statuses: z
    .array(
      z.enum([
        "needs_triage",
        "needs_research",
        "needs_design",
        "needs_implement",
        "needs_closeout",
        "needs_merge",
        "done",
        "blocked",
        "cancelled",
      ])
    )
    .optional()
    .describe(
      "Filter by status. Omit for all actionable statuses. " +
        "Priority order: needs_merge > needs_closeout > needs_implement > needs_design > needs_research > needs_triage"
    ),
  types: z
    .array(z.enum(["task", "bug", "story", "spike", "subtask"]))
    .optional()
    .describe("Filter by work item type"),
  text: z
    .string()
    .optional()
    .describe("Free-text search across title and summary"),
  actor: z
    .enum(["human", "ai", "either"])
    .optional()
    .describe(
      "Eligibility filter. Pass 'ai' to see only items safe for autonomous AI handling. " +
        "Note: the Doltgres-backed store has no actor column — any value other than 'either' returns no items there, so omit it unless you need it."
    ),
  projectId: z
    .string()
    .optional()
    .describe("Filter by project ID (e.g., 'proj.agentic-interop')"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max results to return (default 20, max 50)"),
  ids: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Fetch exactly these work item ids"),
  cursor: z
    .string()
    .optional()
    .describe("Pagination cursor from a previous result's nextCursor"),
});
export type WorkItemQueryInput = z.infer<typeof WorkItemQueryInputSchema>;

const WorkItemOutputSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  status: z.string(),
  actor: z.string().optional(),
  priority: z.number().optional(),
  rank: z.number().optional(),
  summary: z.string().optional(),
  projectId: z.string().optional(),
  labels: z.array(z.string()),
  assignees: z.array(z.object({ kind: z.string(), id: z.string() })),
  branch: z.string().optional(),
  pr: z.string().optional(),
  blockedBy: z.string().optional(),
  updatedAt: z.string(),
  // Additive, optional (backward compatible) — fields a planner needs to cite
  // an exact item state and reason about scope.
  revision: z.number().optional(),
  outcome: z.string().optional(),
  estimate: z.number().optional(),
  parentId: z.string().optional(),
  specRefs: z.array(z.string()).optional(),
});

/** Max characters of `outcome` returned per item (keeps backlog pages bounded). */
export const WORK_ITEM_QUERY_OUTCOME_MAX_CHARS = 600;

function truncate(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const WorkItemQueryOutputSchema = z.object({
  items: z.array(WorkItemOutputSchema),
  count: z.number(),
  /** Present when more results exist; pass back as `cursor`. */
  nextCursor: z.string().optional(),
});
export type WorkItemQueryOutput = z.infer<typeof WorkItemQueryOutputSchema>;

export type WorkItemQueryRedacted = WorkItemQueryOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const WORK_ITEM_QUERY_NAME = "core__work_item_query" as const;

export const workItemQueryContract: ToolContract<
  typeof WORK_ITEM_QUERY_NAME,
  WorkItemQueryInput,
  WorkItemQueryOutput,
  WorkItemQueryRedacted
> = {
  name: WORK_ITEM_QUERY_NAME,
  description:
    "Query the work item backlog. Returns items matching filters sorted by " +
    "priority (status weight, then priority field, then rank). Use this to " +
    "find actionable items, check item status, or search by text.",
  effect: "read_only",
  inputSchema: WorkItemQueryInputSchema,
  outputSchema: WorkItemQueryOutputSchema,

  redact: (output: WorkItemQueryOutput): WorkItemQueryRedacted => output,
  allowlist: ["items", "count", "nextCursor"] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkItemQueryDeps {
  readonly workItemCapability: WorkItemCapability;
}

export function createWorkItemQueryImplementation(
  deps: WorkItemQueryDeps
): ToolImplementation<WorkItemQueryInput, WorkItemQueryOutput> {
  return {
    execute: async (
      input: WorkItemQueryInput
    ): Promise<WorkItemQueryOutput> => {
      const params = {
        statuses: input.statuses,
        types: input.types,
        text: input.text,
        actor: input.actor,
        projectId: input.projectId,
        limit: input.limit ?? 20,
        ...(input.ids !== undefined && { ids: input.ids }),
        ...(input.cursor !== undefined && { cursor: input.cursor }),
      };
      const page = deps.workItemCapability.queryPage
        ? await deps.workItemCapability.queryPage(params)
        : { items: await deps.workItemCapability.query(params) };
      const items = page.items;

      return {
        items: items.map((item) => ({
          id: item.id,
          type: item.type,
          title: item.title,
          status: item.status,
          actor: item.actor,
          priority: item.priority,
          rank: item.rank,
          summary: item.summary,
          projectId: item.projectId,
          labels: [...item.labels],
          assignees: item.assignees.map((a) => ({
            kind: a.kind,
            id: a.id,
          })),
          branch: item.branch,
          pr: item.pr,
          blockedBy: item.blockedBy,
          updatedAt: item.updatedAt,
          ...(item.revision !== undefined && { revision: item.revision }),
          ...(item.outcome !== undefined && {
            outcome: truncate(item.outcome, WORK_ITEM_QUERY_OUTCOME_MAX_CHARS),
          }),
          ...(item.estimate !== undefined && { estimate: item.estimate }),
          ...(item.parentId !== undefined && { parentId: item.parentId }),
          ...(item.specRefs !== undefined && {
            specRefs: [...item.specRefs],
          }),
        })),
        count: items.length,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
      };
    },
  };
}

export const workItemQueryStubImplementation: ToolImplementation<
  WorkItemQueryInput,
  WorkItemQueryOutput
> = {
  execute: async (): Promise<WorkItemQueryOutput> => {
    throw new Error("WorkItemCapability not configured.");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool
// ─────────────────────────────────────────────────────────────────────────────

export const workItemQueryBoundTool: BoundTool<
  typeof WORK_ITEM_QUERY_NAME,
  WorkItemQueryInput,
  WorkItemQueryOutput,
  WorkItemQueryRedacted
> = {
  contract: workItemQueryContract,
  implementation: workItemQueryStubImplementation,
};
