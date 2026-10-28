// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-items`
 * Purpose: Unit test for work items facade — verifies DTO mapping and port delegation.
 * Scope: Mocks container and WorkItemQueryPort. Tests listWorkItems and getWorkItem.
 * Invariants: PORT_VIA_CONTAINER, CONTRACTS_ARE_TRUTH
 * Side-effects: none
 * Links: src/app/_facades/work/items.server.ts
 * @internal
 */

import {
  WorkItemDtoSchema,
  workItemsListOperation,
} from "@cogni/node-contracts";
import type { WorkItem, WorkItemQueryPort } from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the container
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(),
}));

import { getWorkItem, listWorkItems } from "@/app/_facades/work/items.server";
import { getContainer } from "@/bootstrap/container";

const mockGetContainer = vi.mocked(getContainer);

const SAMPLE_WORK_ITEM: WorkItem = {
  id: toWorkItemId("task.0001"),
  type: "task",
  title: "Sample task",
  status: "needs_implement",
  priority: 1,
  rank: 5,
  estimate: 3,
  summary: "A test summary",
  outcome: "Expected outcome",
  projectId: toWorkItemId("proj.test"),
  parentId: undefined,
  assignees: [{ kind: "user", userId: "u1" }],
  externalRefs: [{ system: "github", kind: "pr" }],
  labels: ["test", "api"],
  specRefs: ["architecture-spec"],
  branch: "feat/task-0001",
  pr: undefined,
  reviewer: undefined,
  revision: 2,
  blockedBy: undefined,
  deployVerified: false,
  claimedByRun: undefined,
  claimedAt: undefined,
  lastCommand: undefined,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
};

function createMockPort(): WorkItemQueryPort {
  return {
    list: vi.fn(),
    get: vi.fn(),
  };
}

type DoltgresMock = {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

function createDoltgresMock(): DoltgresMock {
  // Default: genuinely unconfigured Dolt uses markdown as its sole backend.
  return {
    list: vi.fn().mockRejectedValue(
      Object.assign(new Error("not configured"), {
        name: "DoltgresNotConfiguredError",
      })
    ),
    get: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
  };
}

describe("app/_facades/work/items.server", () => {
  let mockPort: ReturnType<typeof createMockPort>;
  let mockDoltgres: DoltgresMock;

  beforeEach(() => {
    vi.resetAllMocks();
    mockPort = createMockPort();
    mockDoltgres = createDoltgresMock();
    mockGetContainer.mockReturnValue({
      workItemQuery: mockPort,
      doltgresWorkItems: mockDoltgres,
    } as never);
  });

  describe("listWorkItems", () => {
    it("returns items mapped to contract-compliant DTOs", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        nextCursor: undefined,
      });

      const result = await listWorkItems({});

      expect(result.items).toHaveLength(1);
      // Verify contract compliance
      expect(() => workItemsListOperation.output.parse(result)).not.toThrow();
    });

    it("maps WorkItem fields to DTO fields correctly", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        nextCursor: undefined,
      });

      const result = await listWorkItems({});
      const dto = result.items[0];

      expect(dto).toBeDefined();
      expect(dto?.id).toBe("task.0001");
      expect(dto?.type).toBe("task");
      expect(dto?.title).toBe("Sample task");
      expect(dto?.status).toBe("needs_implement");
      expect(dto?.priority).toBe(1);
      expect(dto?.rank).toBe(5);
      expect(dto?.estimate).toBe(3);
      expect(dto?.projectId).toBe("proj.test");
      expect(dto?.assignees).toEqual([{ kind: "user", userId: "u1" }]);
      expect(dto?.labels).toEqual(["test", "api"]);
      expect(dto?.revision).toBe(2);
      expect(dto?.deployVerified).toBe(false);
      expect(dto?.createdAt).toBe("2026-01-01");
      expect(dto?.updatedAt).toBe("2026-01-02");
    });

    it("DTO passes schema validation", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        nextCursor: undefined,
      });

      const result = await listWorkItems({});
      const dto = result.items[0];
      expect(dto).toBeDefined();
      expect(() => WorkItemDtoSchema.parse(dto)).not.toThrow();
    });

    it("passes filter params to port", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined,
      });

      await listWorkItems({
        types: ["task", "bug"],
        statuses: ["needs_implement"],
        text: "search",
        projectId: "proj.test",
        limit: 50,
        sortBy: "updatedAt",
        sortDirection: "desc",
      });

      expect(mockPort.list).toHaveBeenCalledWith({
        types: ["task", "bug"],
        statuses: ["needs_implement"],
        text: "search",
        projectId: toWorkItemId("proj.test"),
        limit: 50,
        sortBy: "updatedAt",
        sortDirection: "desc",
      });
    });

    it("omits undefined filter params from port query", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined,
      });

      await listWorkItems({});

      expect(mockPort.list).toHaveBeenCalledWith({ limit: 100 });
    });

    it("keeps the default 100-row bound and continuation on markdown-only reads", async () => {
      const rows = Array.from({ length: 101 }, (_, index) => ({
        ...SAMPLE_WORK_ITEM,
        id: toWorkItemId(`task.${String(index + 1).padStart(4, "0")}`),
      }));
      vi.mocked(mockPort.list).mockImplementation(async (query) => {
        const start = query.cursor === "page-two" ? 100 : 0;
        const end = start + (query.limit ?? rows.length);
        return {
          items: rows.slice(start, end),
          ...(end < rows.length && { nextCursor: "page-two" }),
        };
      });

      const first = await listWorkItems({});
      expect(first.items).toHaveLength(100);
      expect(first.pageInfo).toEqual({ endCursor: "page-two", hasMore: true });
      const second = await listWorkItems({
        ...(first.nextCursor && { cursor: first.nextCursor }),
      });
      expect(second.items.map((item) => item.id)).toEqual(["task.0101"]);
      expect(second.pageInfo).toEqual({ endCursor: null, hasMore: false });
      expect(mockDoltgres.list).toHaveBeenNthCalledWith(1, { limit: 100 });
      expect(mockPort.list).toHaveBeenNthCalledWith(1, { limit: 100 });
      expect(mockPort.list).toHaveBeenNthCalledWith(2, {
        limit: 100,
        cursor: "page-two",
      });
    });

    it("returns empty items for empty result", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined,
      });

      const result = await listWorkItems({});
      expect(result.items).toEqual([]);
    });

    it("uses configured Dolt alone, preserving its ordered page and cursor", async () => {
      mockDoltgres.list.mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        pageInfo: { endCursor: "cursor-xyz", hasMore: true },
      });
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [{ ...SAMPLE_WORK_ITEM, id: toWorkItemId("task.0002") }],
      });

      const result = await listWorkItems({
        limit: 1,
        sortBy: "rankScore",
        sortDirection: "desc",
      });
      expect(result.items.map((item) => item.id)).toEqual(["task.0001"]);
      expect(result.pageInfo).toEqual({
        endCursor: "cursor-xyz",
        hasMore: true,
      });
      expect(result.nextCursor).toBe("cursor-xyz");
      expect(mockPort.list).not.toHaveBeenCalled();
      expect(mockDoltgres.list).toHaveBeenCalledWith({
        limit: 1,
        sortBy: "rankScore",
        sortDirection: "desc",
      });
    });

    it("preserves markdown-only pagination when Dolt is unconfigured", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [SAMPLE_WORK_ITEM],
        nextCursor: "md1-cursor",
      });
      const result = await listWorkItems({
        cursor: "md1-previous",
        sortBy: "priority",
      });
      expect(result.pageInfo).toEqual({
        endCursor: "md1-cursor",
        hasMore: true,
      });
      expect(result.nextCursor).toBe("md1-cursor");
      expect(mockPort.list).toHaveBeenCalledWith({
        cursor: "md1-previous",
        sortBy: "priority",
        limit: 100,
      });
    });

    it("does not hide a configured Dolt failure by reading markdown", async () => {
      const unavailable = new Error("native read deadline exceeded");
      mockDoltgres.list.mockRejectedValue(unavailable);
      await expect(listWorkItems({})).rejects.toBe(unavailable);
      expect(mockPort.list).not.toHaveBeenCalled();
    });

    it("returns shared evaluation rank without changing legacy rank", async () => {
      mockDoltgres.list.mockResolvedValue({
        items: [
          {
            ...SAMPLE_WORK_ITEM,
            scores: {
              goal: { v: 3 },
              time: { v: 3 },
              unblocks: { v: 3 },
              ease: { v: 3 },
              confidence: { v: 3 },
              agent: { v: 3 },
            },
          },
        ],
        pageInfo: { endCursor: null, hasMore: false },
      });
      const result = workItemsListOperation.output.parse(
        await listWorkItems({})
      );
      expect(result.items[0]).toMatchObject({ rank: 5, rankScore: 2.16 });
    });

    it("passes through nextCursor and pageInfo from doltgres", async () => {
      vi.mocked(mockPort.list).mockResolvedValue({
        items: [],
        nextCursor: undefined,
      });
      mockDoltgres.list.mockResolvedValue({
        items: [],
        pageInfo: { endCursor: "cursor-xyz", hasMore: true },
      });

      const result = await listWorkItems({});
      expect(result.pageInfo).toEqual({
        endCursor: "cursor-xyz",
        hasMore: true,
      });
      expect(result.nextCursor).toBe("cursor-xyz");
    });

    it("forwards cursor to doltgres and skips markdown source", async () => {
      mockDoltgres.list.mockResolvedValue({
        items: [],
        pageInfo: { endCursor: null, hasMore: false },
      });

      await listWorkItems({ cursor: "encoded-cursor" });

      expect(mockPort.list).not.toHaveBeenCalled();
      expect(mockDoltgres.list).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "encoded-cursor" })
      );
    });
  });

  describe("getWorkItem", () => {
    it("returns DTO for existing item", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(SAMPLE_WORK_ITEM);

      const result = await getWorkItem("task.0001");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("task.0001");
      expect(result?.title).toBe("Sample task");
      expect(() => WorkItemDtoSchema.parse(result)).not.toThrow();
    });

    it("returns null for non-existent item", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(null);

      const result = await getWorkItem("task.9999");

      expect(result).toBeNull();
    });

    it("calls port with branded WorkItemId", async () => {
      vi.mocked(mockPort.get).mockResolvedValue(null);

      await getWorkItem("task.0001");

      expect(mockPort.get).toHaveBeenCalledWith(toWorkItemId("task.0001"));
    });
  });
});
