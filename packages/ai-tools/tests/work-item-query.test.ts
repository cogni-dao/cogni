// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/work-item-query`
 * Purpose: Unit tests for the core__work_item_query output contract (task.5282 enrichment).
 * Scope: Does not hit a store; verifies additive optional fields flow through, outcome truncation, and back-compat.
 * Invariants: read_only effect; output validates against WorkItemQueryOutputSchema.
 * Side-effects: none
 * Links: src/tools/work-item-query.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import type {
  WorkItemCapability,
  WorkItemInfo,
} from "../src/capabilities/work-item";
import {
  createWorkItemQueryImplementation,
  WORK_ITEM_QUERY_OUTCOME_MAX_CHARS,
  WorkItemQueryOutputSchema,
  workItemQueryContract,
} from "../src/tools/work-item-query";

function capabilityReturning(
  items: readonly WorkItemInfo[]
): WorkItemCapability {
  return {
    query: vi.fn().mockResolvedValue(items),
    transitionStatus: vi.fn(),
    patch: vi.fn(),
  };
}

const BASE: WorkItemInfo = {
  id: "task.5001",
  type: "task",
  title: "A task",
  status: "needs_implement",
  labels: [],
  assignees: [],
  updatedAt: "2026-10-19T00:00:00.000Z",
};

describe("core__work_item_query", () => {
  it("stays read_only", () => {
    expect(workItemQueryContract.effect).toBe("read_only");
  });

  it("passes enrichment fields through and truncates outcome", async () => {
    const longOutcome = "x".repeat(WORK_ITEM_QUERY_OUTCOME_MAX_CHARS + 50);
    const cap = capabilityReturning([
      {
        ...BASE,
        revision: 7,
        outcome: longOutcome,
        estimate: 3,
        parentId: "story.5096",
        specRefs: ["knowledge:work-items-port"],
      },
    ]);
    const impl = createWorkItemQueryImplementation({ workItemCapability: cap });
    const out = await impl.execute({ statuses: ["needs_implement"] });

    expect(WorkItemQueryOutputSchema.parse(out)).toEqual(out);
    const [item] = out.items;
    expect(item?.revision).toBe(7);
    expect(item?.estimate).toBe(3);
    expect(item?.parentId).toBe("story.5096");
    expect(item?.specRefs).toEqual(["knowledge:work-items-port"]);
    expect(item?.outcome?.length).toBe(WORK_ITEM_QUERY_OUTCOME_MAX_CHARS + 1);
    expect(item?.outcome?.endsWith("…")).toBe(true);
  });

  it("is backward compatible when the store has no enrichment fields", async () => {
    const cap = capabilityReturning([BASE]);
    const impl = createWorkItemQueryImplementation({ workItemCapability: cap });
    const out = await impl.execute({});

    expect(WorkItemQueryOutputSchema.parse(out)).toEqual(out);
    expect(out.items[0]).not.toHaveProperty("revision");
    expect(out.items[0]).not.toHaveProperty("outcome");
    expect(out.count).toBe(1);
  });

  it("does not forward an actor filter the caller omitted", async () => {
    const cap = capabilityReturning([]);
    const impl = createWorkItemQueryImplementation({ workItemCapability: cap });
    await impl.execute({ statuses: ["needs_triage"], limit: 5 });

    expect(cap.query).toHaveBeenCalledWith(
      expect.objectContaining({ actor: undefined, limit: 5 })
    );
  });
});
