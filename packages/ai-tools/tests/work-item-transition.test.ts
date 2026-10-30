// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/work-item-transition`
 * Purpose: Unit tests for core__work_item_transition patch — optional `expectedRevision` compare-and-set (story.5096).
 * Scope: Does not hit a store; verifies capability passthrough, the non-throwing conflict result, and unchanged behavior without expectedRevision.
 * Invariants: PATCH_CAS_OPTIONAL, CONFLICT_IS_A_RESULT; output validates against WorkItemTransitionOutputSchema.
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
});

describe("core__work_item_transition patch scores (story.5111 pass-through)", () => {
  it("forwards a CAS scores patch to the capability unchanged", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });
    const scores = { goal: { v: 3 }, time: { v: 4, ev: "https://x.test/e" } };

    const out = await tool.execute({
      action: "patch",
      id: "task.5001",
      expectedRevision: 7,
      scores,
    });

    expect(cap.patch).toHaveBeenCalledWith({
      id: "task.5001",
      expectedRevision: 7,
      set: { scores },
    });
    expect(out).toMatchObject({ success: true, revision: 8 });
  });

  it("refuses a scores patch without expectedRevision or with priority; nothing reaches the capability", async () => {
    const cap = capability(async () => PATCHED);
    const tool = createWorkItemTransitionImplementation({
      workItemCapability: cap,
    });
    await expect(
      tool.execute({
        action: "patch",
        id: "task.5001",
        scores: { goal: { v: 3 } },
      })
    ).rejects.toThrow();
    await expect(
      tool.execute({
        action: "patch",
        id: "task.5001",
        expectedRevision: 7,
        priority: 0,
        scores: { goal: { v: 3 } },
      })
    ).rejects.toThrow();
    expect(cap.patch).not.toHaveBeenCalled();
  });
});
