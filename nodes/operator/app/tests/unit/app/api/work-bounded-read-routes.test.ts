// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/work-bounded-read-routes`
 * Purpose: Prove the bounded work read routes through the real route handlers and the real facade: board shape, input bounds, typed errors (task.0056).
 * Scope: `/api/v1/work/board` and `/api/v1/work/summaries` GET with the container's Doltgres and markdown ports stubbed; no database.
 * Invariants:
 *   - BOUNDED_BOARD: one composed read for a text-free board, ≤ 20 rows per column; text boards read per column under one shared deadline.
 *   - TYPED_ERRORS: bad status, limit or cursor → 400 before any read; held native capacity → 503, never 500.
 *   - ONE_BACKEND: markdown serves a page only when Doltgres is not configured; a configured Doltgres never triggers a markdown read.
 * Side-effects: none
 * Links: src/app/api/v1/work/board/route.ts, src/app/api/v1/work/summaries/route.ts
 * @internal
 */

import { WorkItemsCapacityError } from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import { GET as boardGET } from "@/app/api/v1/work/board/route";
import { GET as summariesGET } from "@/app/api/v1/work/summaries/route";
import { getContainer } from "@/bootstrap/container";

type Handler = (context: unknown, request: Request) => Promise<Response>;

const STAMP = "2026-11-01T00:00:00.000Z";
const summary = (id: string, status: string) => ({
  id,
  title: id,
  type: "task",
  status,
  labels: [],
  createdAt: STAMP,
  updatedAt: STAMP,
});

const listSummaries = vi.fn();
const listBoardColumns = vi.fn();
const list = vi.fn();
const markdownList = vi.fn();
const ctx = {
  log: { info: vi.fn(), error: vi.fn() },
  reqId: "req-1",
  routeId: "test",
};

function get(handler: unknown, path: string): Promise<Response> {
  return (handler as Handler)(ctx, new Request(`http://localhost${path}`));
}

describe("bounded work read routes (task.0056)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSummaries.mockImplementation(async (query: { statuses?: string[] }) => {
      const status = query.statuses?.[0] ?? "needs_implement";
      return {
        items: [summary(`${status}.1`, status)],
        pageInfo: {
          endCursor: `${status}-next`,
          hasMore: true,
          rowsScanned: 21,
        },
      };
    });
    listBoardColumns.mockImplementation(
      async (_query: unknown, statuses: string[]) => ({
        queryCount: 1,
        columns: statuses.map((status) => ({
          status,
          items: [summary(`${status}.1`, status)],
          pageInfo: {
            endCursor: `${status}-next`,
            hasMore: true,
            rowsScanned: 21,
          },
        })),
      })
    );
    vi.mocked(getContainer).mockReturnValue({
      doltgresWorkItems: { listSummaries, listBoardColumns, list },
      workItemQuery: { list: markdownList, get: vi.fn() },
    } as never);
  });

  it("GET /work/board composes every visible column in ONE store read", async () => {
    const response = await get(
      boardGET,
      "/api/v1/work/board?statuses=needs_design,needs_implement&types=task"
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.columns.map((c: { status: string }) => c.status)).toEqual([
      "needs_design",
      "needs_implement",
    ]);
    expect(body.columns[0]).toMatchObject({
      state: "loaded",
      items: [{ id: "needs_design.1" }],
      pageInfo: { endCursor: "needs_design-next", hasMore: true },
    });
    expect(listBoardColumns).toHaveBeenCalledTimes(1);
    expect(listSummaries).not.toHaveBeenCalled();
    // The full-item list (and its legacy claim overlay) is never on this path.
    expect(list).not.toHaveBeenCalled();
    const [query, statuses, perColumn, options] =
      listBoardColumns.mock.calls[0] ?? [];
    expect(query).toMatchObject({ types: ["task"], limit: 20 });
    expect(query).not.toHaveProperty("cursor");
    expect(statuses).toEqual(["needs_design", "needs_implement"]);
    expect(perColumn).toBe(20);
    expect(options).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("GET /work/board with text reads columns one by one under one shared deadline", async () => {
    const response = await get(
      boardGET,
      "/api/v1/work/board?statuses=needs_design,needs_implement&text=needle"
    );
    expect(response.status).toBe(200);
    expect(listBoardColumns).not.toHaveBeenCalled();
    expect(listSummaries).toHaveBeenCalledTimes(2);
    for (const [query, options] of listSummaries.mock.calls) {
      expect(query).toMatchObject({ limit: 20, text: "needle" });
      expect(query.statuses).toHaveLength(1);
      expect(options).toMatchObject({
        deadline: expect.any(Number),
        maxScanRows: expect.any(Number),
        signal: expect.any(AbortSignal),
      });
    }
    expect(listSummaries.mock.calls[0]?.[1].deadline).toBe(
      listSummaries.mock.calls[1]?.[1].deadline
    );
  });

  it.each([
    ["an unknown status", "statuses=nope"],
    ["no statuses", "types=task"],
    ["a limit above 100", "statuses=done&limit=101"],
    ["an oversized cursor", `statuses=done&cursor=${"a".repeat(2049)}`],
  ])("GET /work/board rejects %s with 400 before any read", async (_label, search) => {
    const response = await get(boardGET, `/api/v1/work/board?${search}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid input" });
    expect(listSummaries).not.toHaveBeenCalled();
    expect(listBoardColumns).not.toHaveBeenCalled();
  });

  it("GET /work/board maps a stale cursor error to 400", async () => {
    listBoardColumns.mockRejectedValue(
      Object.assign(new Error("invalid_cursor"), { name: "InvalidCursorError" })
    );
    const response = await get(boardGET, "/api/v1/work/board?statuses=done");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_cursor" });
  });

  it("GET /work/board and /work/summaries map held native capacity to 503", async () => {
    listSummaries.mockRejectedValue(new WorkItemsCapacityError("pending"));
    listBoardColumns.mockRejectedValue(new WorkItemsCapacityError("pending"));
    const board = await get(boardGET, "/api/v1/work/board?statuses=done");
    expect(board.status).toBe(503);
    const page = await get(
      summariesGET,
      "/api/v1/work/summaries?statuses=done"
    );
    expect(page.status).toBe(503);
  });

  it("GET /work/summaries rejects limit > 100 and defaults to 25 with pageInfo", async () => {
    const tooMany = await get(summariesGET, "/api/v1/work/summaries?limit=101");
    expect(tooMany.status).toBe(400);
    expect(listSummaries).not.toHaveBeenCalled();

    const ok = await get(summariesGET, "/api/v1/work/summaries?statuses=done");
    expect(ok.status).toBe(200);
    expect(listSummaries.mock.calls[0]?.[0]).toMatchObject({ limit: 25 });
    expect(list).not.toHaveBeenCalled();
    expect(markdownList).not.toHaveBeenCalled();
    expect(await ok.json()).toMatchObject({
      items: [{ id: "done.1" }],
      pageInfo: { endCursor: "done-next", hasMore: true, rowsScanned: 21 },
    });
  });

  it("GET /work/summaries falls back to markdown only when Doltgres is not configured", async () => {
    listSummaries.mockRejectedValue(
      Object.assign(new Error("not configured"), {
        name: "DoltgresNotConfiguredError",
      })
    );
    markdownList.mockResolvedValue({
      items: [
        {
          id: "task.0001",
          type: "task",
          title: "Markdown task",
          status: "needs_implement",
          labels: [],
          assignees: [],
          externalRefs: [],
          specRefs: [],
          revision: 1,
          deployVerified: false,
          createdAt: STAMP,
          updatedAt: STAMP,
        },
      ],
    });
    const response = await get(
      summariesGET,
      "/api/v1/work/summaries?statuses=needs_implement&limit=10"
    );
    expect(response.status).toBe(200);
    expect(markdownList).toHaveBeenCalledTimes(1);
    expect(markdownList.mock.calls[0]?.[0]).toMatchObject({ limit: 10 });
    expect(await response.json()).toMatchObject({
      items: [{ id: "task.0001", title: "Markdown task" }],
      pageInfo: { endCursor: null, hasMore: false },
    });
  });
});
