// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/work-item-capability`
 * Purpose: Prove `core__work_item_query`'s capability reads through the injected backlog reader (task.5282).
 * Scope: Unit test of createWorkItemCapability with fake ports. Does not touch Doltgres or markdown files.
 * Invariants:
 *   - QUERY_READS_THE_LIVE_BACKLOG: `query` lists via `backlogReader` when wired, never the markdown port
 *   - WRITES_NOT_WIDENED: transition still resolves + commands through the markdown ports only
 * Side-effects: none
 * Links: src/bootstrap/capabilities/work-item.ts
 * @internal
 */

import type {
  WorkItem,
  WorkItemCommandPort,
  WorkItemId,
  WorkItemQueryPort,
} from "@cogni/work-items";
import { describe, expect, it, vi } from "vitest";

import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "task.5282" as WorkItemId,
    type: "task",
    title: "Prioritizer",
    status: "needs_implement",
    node: "operator",
    assignees: [],
    externalRefs: [],
    actor: "either",
    labels: [],
    specRefs: ["work-items-port"],
    revision: 4,
    deployVerified: false,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    outcome: "Done when the graph runs",
    parentId: "story.5096" as WorkItemId,
    estimate: 2,
    ...overrides,
  };
}

function markdownPorts() {
  const query: WorkItemQueryPort = {
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ items: [] }),
    listRelations: vi.fn().mockResolvedValue([]),
  };
  const command = {
    transitionStatus: vi.fn(),
    patch: vi.fn(),
  } as unknown as WorkItemCommandPort;
  return { query, command };
}

describe("createWorkItemCapability", () => {
  it("lists through backlogReader (Doltgres read path) and maps enrichment fields", async () => {
    const md = markdownPorts();
    const backlogReader = {
      list: vi.fn().mockResolvedValue({
        items: [item()],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    };
    const cap = createWorkItemCapability({
      workItemQuery: md.query,
      workItemCommand: md.command,
      backlogReader,
    });

    const result = await cap.query({ statuses: ["needs_implement"], limit: 5 });

    expect(backlogReader.list).toHaveBeenCalledWith({
      statuses: ["needs_implement"],
      limit: 5,
    });
    expect(md.query.list).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        id: "task.5282",
        revision: 4,
        outcome: "Done when the graph runs",
        parentId: "story.5096",
        estimate: 2,
        specRefs: ["work-items-port"],
      }),
    ]);
  });

  it("falls back to workItemQuery when no backlogReader is wired", async () => {
    const md = markdownPorts();
    const cap = createWorkItemCapability({
      workItemQuery: md.query,
      workItemCommand: md.command,
    });
    await cap.query({});
    expect(md.query.list).toHaveBeenCalledTimes(1);
  });

  it("keeps transitions on the markdown ports (writes are not routed to the reader)", async () => {
    const md = markdownPorts();
    const backlogReader = { list: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: md.query,
      workItemCommand: md.command,
      backlogReader,
    });

    await expect(
      cap.transitionStatus({ id: "task.5282", toStatus: "done" })
    ).rejects.toThrow("Work item not found");
    expect(md.query.get).toHaveBeenCalledTimes(1);
    expect(backlogReader.list).not.toHaveBeenCalled();
    expect(md.command.transitionStatus).not.toHaveBeenCalled();
  });
});
