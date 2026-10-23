// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/work-item-capability`
 * Purpose: Prove `core__work_item_query`'s capability reads through the injected backlog reader (task.5282).
 * Scope: Unit test of createWorkItemCapability with fake ports. Does not touch Doltgres or markdown files.
 * Invariants:
 *   - QUERY_READS_THE_LIVE_BACKLOG: `query` lists via `backlogReader` when wired, never the markdown port
 *   - WRITES_NOT_WIDENED: transition still resolves + commands through the markdown ports only
 *   - PATCH_ON_THE_LIVE_BACKLOG / PATCH_CAS_PASSTHROUGH (story.5096): `patch` writes through the
 *     Doltgres `backlogWriter` as its principal, forwards `expectedRevision`, and turns the store's
 *     `WorkItemRevisionConflictError` into the ai-tools `WorkItemPatchConflictError`
 *   - NO_PRIORITY_GUARD (task.5306): a priority-0/1 patch writes through like any other priority;
 *     there is no bespoke node-admin gate on it
 * Side-effects: none
 * Links: src/bootstrap/capabilities/work-item.ts
 * @internal
 */

import { WorkItemPatchConflictError } from "@cogni/shared-ai-tools";
import type {
  WorkItem,
  WorkItemCommandPort,
  WorkItemId,
  WorkItemQueryPort,
} from "@cogni/work-items";
import { WorkItemRevisionConflictError } from "@cogni/work-items/adapters/doltgres";
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

  it("patches through the Doltgres backlogWriter as its principal, forwarding expectedRevision", async () => {
    const md = markdownPorts();
    const store = {
      patch: vi
        .fn()
        .mockResolvedValue(item({ priority: 2, rank: 2, revision: 5 })),
    };
    const cap = createWorkItemCapability({
      workItemQuery: md.query,
      workItemCommand: md.command,
      backlogWriter: { store, principalId: "actor:system" },
    });

    const result = await cap.patch({
      id: "task.5282",
      expectedRevision: 4,
      set: { priority: 2, rank: 2 },
    });

    expect(store.patch).toHaveBeenCalledWith(
      { id: "task.5282", expectedRevision: 4, set: { priority: 2, rank: 2 } },
      "actor:system"
    );
    expect(result).toMatchObject({ priority: 2, rank: 2, revision: 5 });
    expect(md.query.get).not.toHaveBeenCalled();
    expect(md.command.patch).not.toHaveBeenCalled();
  });

  it("sends an unconditioned patch when expectedRevision is absent", async () => {
    const md = markdownPorts();
    const store = { patch: vi.fn().mockResolvedValue(item()) };
    const cap = createWorkItemCapability({
      workItemQuery: md.query,
      workItemCommand: md.command,
      backlogWriter: { store, principalId: "actor:system" },
    });

    await cap.patch({ id: "task.5282", set: { labels: ["x"] } });

    expect(store.patch).toHaveBeenCalledWith(
      { id: "task.5282", set: { labels: ["x"] } },
      "actor:system"
    );
  });

  it("maps the store's revision conflict to WorkItemPatchConflictError", async () => {
    const md = markdownPorts();
    const store = {
      patch: vi
        .fn()
        .mockRejectedValue(
          new WorkItemRevisionConflictError("task.5282", 4, 6)
        ),
    };
    const cap = createWorkItemCapability({
      workItemQuery: md.query,
      workItemCommand: md.command,
      backlogWriter: { store, principalId: "actor:system" },
    });

    const err = await cap
      .patch({ id: "task.5282", expectedRevision: 4, set: { priority: 2 } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkItemPatchConflictError);
    expect(err).toMatchObject({
      id: "task.5282",
      expectedRevision: 4,
      currentRevision: 6,
    });
  });

  it("rethrows any other store failure unchanged", async () => {
    const md = markdownPorts();
    const denied = Object.assign(new Error("not authorized"), {
      name: "WorkItemAuthorizationError",
    });
    const store = { patch: vi.fn().mockRejectedValue(denied) };
    const cap = createWorkItemCapability({
      workItemQuery: md.query,
      workItemCommand: md.command,
      backlogWriter: { store, principalId: "actor:system" },
    });

    await expect(
      cap.patch({ id: "task.5282", set: { summary: "x" } })
    ).rejects.toBe(denied);
  });

  it("refuses expectedRevision without a backlogWriter (markdown has no caller CAS)", async () => {
    const md = markdownPorts();
    const cap = createWorkItemCapability({
      workItemQuery: md.query,
      workItemCommand: md.command,
    });

    await expect(
      cap.patch({ id: "task.5282", expectedRevision: 4, set: { priority: 2 } })
    ).rejects.toThrow("requires the Doltgres backlog writer");
    expect(md.command.patch).not.toHaveBeenCalled();
  });

  it.each([
    0, 1,
  ])("writes priority %i with no node-admin gate (task.5306)", async (priority) => {
    const md = markdownPorts();
    const store = { patch: vi.fn().mockResolvedValue(item({ priority })) };
    const cap = createWorkItemCapability({
      workItemQuery: md.query,
      workItemCommand: md.command,
      backlogWriter: { store, principalId: "actor:system" },
    });

    const result = await cap.patch({ id: "task.5282", set: { priority } });

    expect(store.patch).toHaveBeenCalledWith(
      { id: "task.5282", set: { priority } },
      "actor:system"
    );
    expect(result.id).toBe("task.5282");
  });
});

describe("shared evaluation capability adoption", () => {
  it("returns the package rank and forwards a score-only CAS patch unchanged", async () => {
    const { query, command } = markdownPorts();
    const scores = {
      goal: { v: 3 },
      time: { v: 3 },
      unblocks: { v: 3 },
      ease: { v: 2 },
      confidence: { v: 5, ev: "https://example.com/proof" },
      agent: { v: 3 },
    };
    const scored = item({ scores, priority: 2, estimate: 7, revision: 5 });
    const store = { patch: vi.fn().mockResolvedValue(scored) };
    const capability = createWorkItemCapability({
      workItemQuery: query,
      workItemCommand: command,
      backlogWriter: { store, principalId: "actor:test" },
    });
    const result = await capability.patch({
      id: scored.id,
      expectedRevision: 4,
      set: { scores },
    });
    expect(store.patch).toHaveBeenCalledWith(
      { id: scored.id, expectedRevision: 4, set: { scores } },
      "actor:test"
    );
    expect(result).toMatchObject({
      scores,
      rankScore: 1.8,
      priority: 2,
      estimate: 7,
      revision: 5,
    });
  });
});
