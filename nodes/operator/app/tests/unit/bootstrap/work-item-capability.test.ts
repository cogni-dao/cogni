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
 *   - P0P1_IS_NODE_ADMIN (task.5286): a priority-0/1 patch runs `privilegedPriorityGate` (the
 *     real `checkNodeAdmin` over the deterministic fake authorization adapter) BEFORE any write;
 *     deny → `authz_denied`, outage/unwired → `authz_unavailable`; priority 2+ never consults it
 * Side-effects: none
 * Links: src/bootstrap/capabilities/work-item.ts
 * @internal
 */

import { WorkItemPatchConflictError } from "@cogni/ai-tools";
import { FakeAuthorizationAdapter } from "@cogni/authorization-core";
import type {
  WorkItem,
  WorkItemCommandPort,
  WorkItemId,
  WorkItemQueryPort,
} from "@cogni/work-items";
import { WorkItemRevisionConflictError } from "@cogni/work-items/adapters/doltgres";
import { describe, expect, it, vi } from "vitest";

import {
  createWorkItemCapability,
  WorkItemPriorityAuthzError,
  WorkItemPriorityRangeError,
} from "@/bootstrap/capabilities/work-item";
import {
  checkNodeAdmin,
  isPrivilegedPriority,
} from "@/bootstrap/node-admin-gate";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const ADMIN_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

async function adminAuthz(): Promise<FakeAuthorizationAdapter> {
  const authz = new FakeAuthorizationAdapter();
  await authz.writeRelation({
    user: `user:${ADMIN_USER}`,
    relation: "admin",
    object: `node:${NODE_ID}`,
  });
  return authz;
}

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
      get: vi.fn().mockResolvedValue(item()),
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
    const store = {
      get: vi.fn().mockResolvedValue(item()),
      patch: vi.fn().mockResolvedValue(item()),
    };
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
      get: vi.fn().mockResolvedValue(item()),
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
    const store = {
      get: vi.fn().mockResolvedValue(item()),
      patch: vi.fn().mockRejectedValue(denied),
    };
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

  describe("privileged priority gate (task.5286)", () => {
    function gatedCap(gate?: () => ReturnType<typeof checkNodeAdmin>) {
      const md = markdownPorts();
      const store = {
        get: vi.fn().mockResolvedValue(item()),
        patch: vi.fn().mockResolvedValue(item({ priority: 0 })),
      };
      const cap = createWorkItemCapability({
        workItemQuery: md.query,
        workItemCommand: md.command,
        backlogWriter: { store, principalId: "actor:system" },
        ...(gate ? { privilegedPriorityGate: gate } : {}),
      });
      return { cap, store, md };
    }

    it.each([
      -1, 0, 1,
    ])("refuses priority %i for a non-admin actor before any write (authz_denied)", async (priority) => {
      const authz = await adminAuthz();
      const { cap, store, md } = gatedCap(() =>
        checkNodeAdmin(authz, { userId: OTHER_USER, nodeId: NODE_ID })
      );

      const err = await cap
        .patch({ id: "task.5282", set: { priority } })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WorkItemPriorityAuthzError);
      expect(err).toMatchObject({ errorCode: "authz_denied" });
      expect(store.patch).not.toHaveBeenCalled();
      expect(md.command.patch).not.toHaveBeenCalled();
    });

    it("lets the node admin set priority 0 and writes as the system principal", async () => {
      const authz = await adminAuthz();
      const { cap, store } = gatedCap(() =>
        checkNodeAdmin(authz, { userId: ADMIN_USER, nodeId: NODE_ID })
      );

      await cap.patch({ id: "task.5282", set: { priority: 0 } });

      expect(store.patch).toHaveBeenCalledWith(
        { id: "task.5282", set: { priority: 0 } },
        "actor:system"
      );
    });

    it("never consults the gate for priority 2+ or a priority-free patch", async () => {
      const gate = vi.fn();
      const { cap, store } = gatedCap(gate);

      await cap.patch({ id: "task.5282", set: { priority: 2 } });
      await cap.patch({ id: "task.5282", set: { rank: 3 } });

      expect(gate).not.toHaveBeenCalled();
      expect(store.patch).toHaveBeenCalledTimes(2);
    });

    it("fails closed as authz_unavailable when OpenFGA is unavailable, distinct from deny", async () => {
      const authz = new FakeAuthorizationAdapter();
      authz.unavailable({
        actorId: `user:${ADMIN_USER}`,
        action: "node.administer",
        resource: `node:${NODE_ID}`,
        context: { tenantId: NODE_ID, nodeId: NODE_ID },
      });
      const { cap, store } = gatedCap(() =>
        checkNodeAdmin(authz, { userId: ADMIN_USER, nodeId: NODE_ID })
      );

      const err = await cap
        .patch({ id: "task.5282", set: { priority: 1 } })
        .catch((e: unknown) => e);

      expect(err).toMatchObject({ errorCode: "authz_unavailable" });
      expect(store.patch).not.toHaveBeenCalled();
    });

    it.each([
      0, 1,
    ])("refuses a non-admin demoting a p%i item (from <= 1), writing nothing (story.5108)", async (from) => {
      const authz = await adminAuthz();
      const { cap, store } = gatedCap(() =>
        checkNodeAdmin(authz, { userId: OTHER_USER, nodeId: NODE_ID })
      );
      store.get.mockResolvedValue(item({ priority: from }));

      const err = await cap
        .patch({ id: "task.5282", set: { priority: 3 } })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WorkItemPriorityAuthzError);
      expect(err).toMatchObject({ errorCode: "authz_denied" });
      expect(store.patch).not.toHaveBeenCalled();
    });

    it("lets the node admin demote a p1 item, bound to the revision it read", async () => {
      const authz = await adminAuthz();
      const { cap, store } = gatedCap(() =>
        checkNodeAdmin(authz, { userId: ADMIN_USER, nodeId: NODE_ID })
      );
      store.get.mockResolvedValue(item({ priority: 1, revision: 7 }));

      await cap.patch({ id: "task.5282", set: { priority: 3 } });

      expect(store.patch).toHaveBeenCalledWith(
        { id: "task.5282", expectedRevision: 7, set: { priority: 3 } },
        "actor:system"
      );
    });

    it("refuses a stale caller revision against the revision the gate read, writing nothing", async () => {
      const authz = await adminAuthz();
      const { cap, store } = gatedCap(() =>
        checkNodeAdmin(authz, { userId: ADMIN_USER, nodeId: NODE_ID })
      );
      store.get.mockResolvedValue(item({ priority: 1, revision: 7 }));

      const err = await cap
        .patch({ id: "task.5282", expectedRevision: 6, set: { priority: 3 } })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WorkItemPatchConflictError);
      expect(err).toMatchObject({ expectedRevision: 6, currentRevision: 7 });
      expect(store.patch).not.toHaveBeenCalled();
    });

    it("respects a caller revision that matches the revision read", async () => {
      const gate = vi.fn();
      const { cap, store } = gatedCap(gate);
      store.get.mockResolvedValue(item({ priority: 3, revision: 9 }));

      await cap.patch({
        id: "task.5282",
        expectedRevision: 9,
        set: { priority: 5 },
      });

      expect(store.patch).toHaveBeenCalledWith(
        { id: "task.5282", expectedRevision: 9, set: { priority: 5 } },
        "actor:system"
      );
    });

    it("fails closed as authz_unavailable when a demotion cannot be authorized", async () => {
      const authz = new FakeAuthorizationAdapter();
      authz.unavailable({
        actorId: `user:${ADMIN_USER}`,
        action: "node.administer",
        resource: `node:${NODE_ID}`,
        context: { tenantId: NODE_ID, nodeId: NODE_ID },
      });
      const { cap, store } = gatedCap(() =>
        checkNodeAdmin(authz, { userId: ADMIN_USER, nodeId: NODE_ID })
      );
      store.get.mockResolvedValue(item({ priority: 0 }));

      const err = await cap
        .patch({ id: "task.5282", set: { priority: 3 } })
        .catch((e: unknown) => e);

      expect(err).toMatchObject({ errorCode: "authz_unavailable" });
      expect(store.patch).not.toHaveBeenCalled();
    });

    it("never gates a move between open priorities, but still binds it to the revision read", async () => {
      const gate = vi.fn();
      const { cap, store } = gatedCap(gate);
      store.get.mockResolvedValue(item({ priority: 3, revision: 9 }));

      await cap.patch({ id: "task.5282", set: { priority: 5 } });

      expect(gate).not.toHaveBeenCalled();
      expect(store.patch).toHaveBeenCalledWith(
        { id: "task.5282", expectedRevision: 9, set: { priority: 5 } },
        "actor:system"
      );
    });

    it("treats every priority <= 1 as privileged, so a negative value cannot outrank p0", () => {
      for (const p of [-1000, -1, 0, 1, 0.5])
        expect(isPrivilegedPriority(p)).toBe(true);
      for (const p of [2, 99, 100]) expect(isPrivilegedPriority(p)).toBe(false);
      expect(isPrivilegedPriority(undefined)).toBe(false);
      expect(isPrivilegedPriority(null)).toBe(false);
    });

    it("refuses an out-of-range priority (PRIORITY_RANGE) without writing, even for the admin", async () => {
      const authz = await adminAuthz();
      const { cap, store } = gatedCap(() =>
        checkNodeAdmin(authz, { userId: ADMIN_USER, nodeId: NODE_ID })
      );

      for (const priority of [-1, 100]) {
        const err = await cap
          .patch({ id: "task.5282", set: { priority } })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WorkItemPriorityRangeError);
      }
      expect(store.patch).not.toHaveBeenCalled();
    });

    it("keeps a thrown check's message in the authz_unavailable reason", async () => {
      const throwing = {
        check: async () => {
          throw new Error("openfga socket hang up");
        },
      } as unknown as Parameters<typeof checkNodeAdmin>[0];
      const gate = await checkNodeAdmin(throwing, {
        userId: ADMIN_USER,
        nodeId: NODE_ID,
      });
      expect(gate).toMatchObject({
        ok: false,
        errorCode: "authz_unavailable",
        reason: "check_threw: openfga socket hang up",
      });
    });

    it("fails closed when no invoking actor is in scope or no gate is wired", async () => {
      const authz = await adminAuthz();
      const missingActor = gatedCap(() =>
        checkNodeAdmin(authz, { userId: undefined, nodeId: NODE_ID })
      );
      const unwired = gatedCap();

      for (const { cap, store } of [missingActor, unwired]) {
        const err = await cap
          .patch({ id: "task.5282", set: { priority: 0 } })
          .catch((e: unknown) => e);
        expect(err).toMatchObject({ errorCode: "authz_unavailable" });
        expect(store.patch).not.toHaveBeenCalled();
      }
    });
  });
});
