// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/work-item-transition`
 * Purpose: Unit tests for core__work_item_transition patch — optional `expectedRevision` compare-and-set (story.5096) and `scores` pass-through (story.5111).
 * Scope: Does not hit a store; verifies capability passthrough, the non-throwing conflict result, unchanged behavior without expectedRevision, and that a store scores rejection reaches the agent as a tool error.
 * Invariants: PATCH_CAS_OPTIONAL, CONFLICT_IS_A_RESULT, SCORES_PASS_THROUGH; output validates against WorkItemTransitionOutputSchema.
 * Side-effects: none
 * Links: src/tools/work-item-transition.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  type WorkItemCapability,
  type WorkItemInfo,
  WorkItemPatchConflictError,
} from "../src/capabilities/work-item";
import {
  createWorkItemTransitionImplementation,
  WorkItemTransitionInputSchema,
  WorkItemTransitionOutputSchema,
} from "../src/tools/work-item-transition";

const PATCHED: WorkItemInfo = {
  id: "task.5001",
  type: "task",
  title: "A task",
  status: "needs_implement",
  priority: 1,
  rank: 4,
  labels: [],
  assignees: [],
  updatedAt: "2026-10-21T00:00:00.000Z",
  revision: 8,
};

function capability(patch: WorkItemCapability["patch"]): WorkItemCapability {
  return {
    query: vi.fn(),
    transitionStatus: vi.fn(),
    patch: vi.fn(patch),
  };
}

describe("core__work_item_transition patch", () => {
  it("accepts expectedRevision + rank in the input schema", () => {
    const parsed = WorkItemTransitionInputSchema.safeParse({
      action: "patch",
      id: "task.5001",
      priority: 1,
      rank: 4,
      expectedRevision: 7,
    });
    expect(parsed.success).toBe(true);
    expect(
      WorkItemTransitionInputSchema.safeParse({
        action: "patch",
        id: "task.5001",
        priority: 1,
        expectedRevision: -1,
      }).success
    ).toBe(false);
  });

  it("forwards expectedRevision and rank to the capability and reports the new revision", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    const out = await tool.execute({
      action: "patch",
      id: "task.5001",
      priority: 1,
      rank: 4,
      expectedRevision: 7,
    });

    expect(cap.patch).toHaveBeenCalledWith({
      id: "task.5001",
      expectedRevision: 7,
      set: { priority: 1, rank: 4 },
    });
    expect(out).toMatchObject({ success: true, action: "patch", revision: 8 });
    expect(WorkItemTransitionOutputSchema.safeParse(out).success).toBe(true);
  });

  it("omits expectedRevision when absent (unconditioned patch, unchanged)", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await tool.execute({ action: "patch", id: "task.5001", priority: 2 });

    expect(cap.patch).toHaveBeenCalledWith({
      id: "task.5001",
      set: { priority: 2 },
    });
  });

  it("maps a lost compare-and-set to a non-throwing revision_conflict result", async () => {
    const cap = capability(async () => {
      throw new WorkItemPatchConflictError("task.5001", 7, 9);
    });
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    const out = await tool.execute({
      action: "patch",
      id: "task.5001",
      priority: 1,
      expectedRevision: 7,
    });

    expect(out).toMatchObject({
      success: false,
      action: "patch",
      id: "task.5001",
      code: "revision_conflict",
      currentRevision: 9,
    });
    expect(WorkItemTransitionOutputSchema.safeParse(out).success).toBe(true);
  });

  it("still throws on any other capability failure", async () => {
    const cap = capability(async () => {
      throw new Error("not authorized");
    });
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await expect(
      tool.execute({
        action: "patch",
        id: "task.5001",
        priority: 1,
        expectedRevision: 7,
      })
    ).rejects.toThrow("not authorized");
  });

  it("rejects expectedRevision on a status transition", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await expect(
      tool.execute({
        action: "transition",
        id: "task.5001",
        toStatus: "done",
        expectedRevision: 7,
      })
    ).rejects.toThrow("only supported for action 'patch'");
    expect(cap.transitionStatus).not.toHaveBeenCalled();
  });

  it("forwards scores unchanged to the capability (validation is the store's)", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });
    const scores = {
      goal: { v: 5, ev: "https://cognidao.org/work/items/story.5111" },
      time: { v: 2 },
      ease: { v: 9 },
    };

    const out = await tool.execute({
      action: "patch",
      id: "task.5001",
      scores,
      expectedRevision: 7,
    });

    expect(cap.patch).toHaveBeenCalledWith({
      id: "task.5001",
      expectedRevision: 7,
      set: { scores },
    });
    expect(out.success).toBe(true);
    expect(out.message).toContain("scores");
  });

  it("forwards scores: null so the store clears them", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await tool.execute({ action: "patch", id: "task.5001", scores: null });

    expect(cap.patch).toHaveBeenCalledWith({
      id: "task.5001",
      set: { scores: null },
    });
  });

  it("checks scores shape only: v must be an integer, bounds are the store's", () => {
    const parse = (scores: unknown) =>
      WorkItemTransitionInputSchema.safeParse({
        action: "patch",
        id: "task.5001",
        scores,
      }).success;
    expect(parse({ goal: { v: 7 } })).toBe(true);
    expect(parse({ goal: { v: 4.5 } })).toBe(false);
    expect(parse({ goal: { ev: "https://cognidao.org" } })).toBe(false);
  });

  it("surfaces a store scores rejection (HTTP 400 class) as a tool error naming the axis", async () => {
    // Mirrors @cogni/work-items WorkItemScoresInvalidError, thrown by the adapter's
    // parseWorkItemScores before any SQL (ai-tools does not import the store package).
    class WorkItemScoresInvalidError extends Error {
      readonly code = "work_item_scores_invalid" as const;
      constructor(
        readonly issues: readonly {
          code: string;
          path: readonly string[];
          message: string;
        }[]
      ) {
        super(
          `Invalid work-item scores: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        );
        this.name = "WorkItemScoresInvalidError";
      }
    }
    const cap = capability(async () => {
      throw new WorkItemScoresInvalidError([
        {
          code: "evidence_required",
          path: ["goal"],
          message: "a score of 4 or 5 needs ev",
        },
      ]);
    });
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });

    await expect(
      tool.execute({
        action: "patch",
        id: "task.5001",
        scores: { goal: { v: 5 } },
      })
    ).rejects.toThrow(
      "Invalid work-item scores: goal: a score of 4 or 5 needs ev"
    );
  });
});
