// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/work.items.route`
 * Purpose: Route-level contract tests for GET /api/v1/work/items.
 * Scope: Verifies sort validation, cursor errors, and safe terminal events on every handler outcome.
 *   Uses next-test-api-route-handler with mocked container + session.
 * Invariants:
 *   - INVALID_CURSOR_400: garbage cursor returns 400 with `{ error: "invalid cursor" }`
 *   - AUTH_REQUIRED: 401 when no session (sanity)
 * Side-effects: none
 * Links: bug.5162, PR #1180 review finding 1,
 *   nodes/operator/app/src/app/api/v1/work/items/route.ts
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkItemsBackendNotReadyError } from "@/app/_facades/work/items.server";
import * as session from "@/app/_lib/auth/session";
import * as appHandler from "@/app/api/v1/work/items/route";
import { getContainer } from "@/bootstrap/container";
import { EVENT_NAMES } from "@/shared/observability";

vi.mock("@/bootstrap/container", () => {
  const log = {
    child: vi.fn(() => log),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-04-30T00:00:00Z")) },
      config: { unhandledErrorPolicy: "rethrow" },
      workItemQuery: {
        list: vi.fn().mockResolvedValue({ items: [] }),
        get: vi.fn(),
      },
      doltgresWorkItems: {
        // decode happens before SQL runs; this mock is only hit on the
        // happy path. For the malformed-cursor test the route returns 400
        // before reaching here.
        list: vi.fn(async (q: { cursor?: string }) => {
          if (q.cursor) {
            const { decodeCursor } = await import(
              "@cogni/work-items/adapters/doltgres"
            );
            decodeCursor(q.cursor); // throws InvalidCursorError on bad input
          }
          return {
            items: [],
            pageInfo: { endCursor: null, hasMore: false },
          };
        }),
        get: vi.fn(),
        create: vi.fn(),
        patch: vi.fn(),
      },
    })),
  };
});

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

describe("GET /api/v1/work/items — cursor error translation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
  });

  it("returns 400 with { error: 'invalid cursor' } on malformed cursor", async () => {
    await testApiHandler({
      appHandler,
      url: "/api/v1/work/items?cursor=!!!not-a-real-cursor!!!",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body).toMatchObject({
          error: "invalid cursor",
          code: "invalid_cursor",
          message: expect.stringContaining("Restart pagination"),
        });
      },
    });
  });

  it("returns 400 on cursor that decodes but has wrong shape", async () => {
    // base64url("{}") — valid JSON, missing required fields
    await testApiHandler({
      appHandler,
      url: "/api/v1/work/items?cursor=e30",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
      },
    });
  });

  it.each([
    "sortBy=arbitrary_sql",
    "sortDirection=sideways",
    "sortBy=",
    "sortDirection=",
  ])("rejects invalid sort parameters with 400: %s", async (query) => {
    await testApiHandler({
      appHandler,
      url: `/api/v1/work/items?${query}`,
      async test({ fetch }) {
        const response = await fetch({ method: "GET" });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid input" });
      },
    });
  });

  it("passes validated sorting through to the authoritative store", async () => {
    const container = getContainer();
    vi.mocked(getContainer).mockReturnValue(container);
    await testApiHandler({
      appHandler,
      url: "/api/v1/work/items?sortBy=updatedAt&sortDirection=asc&limit=2",
      async test({ fetch }) {
        const response = await fetch({ method: "GET" });
        expect(response.status).toBe(200);
        expect(container.doltgresWorkItems.list).toHaveBeenCalledWith({
          sortBy: "updatedAt",
          sortDirection: "asc",
          limit: 2,
        });
        expect(container.workItemQuery.list).not.toHaveBeenCalled();
        expect(container.log.info).toHaveBeenCalledWith(
          expect.objectContaining({
            event: EVENT_NAMES.WORK_ITEMS_LIST_COMPLETE,
            routeId: "work.items.list",
            reqId: expect.any(String),
            status: 200,
            outcome: "success",
            count: 0,
            hasMore: false,
            sortBy: "updatedAt",
            sortDirection: "asc",
          }),
          EVENT_NAMES.WORK_ITEMS_LIST_COMPLETE
        );
        expect(container.log.info).toHaveBeenCalledTimes(3);
      },
    });
  });

  it.each([
    { query: "?sortBy=invalid", status: 400, errorCode: "invalid_input" },
    { query: "?cursor=invalid", status: 400, errorCode: "invalid_cursor" },
    {
      query: "",
      status: 503,
      errorCode: "backend_unavailable",
      failure: new WorkItemsBackendNotReadyError("private backend detail"),
    },
    {
      query: "",
      status: 500,
      errorCode: "internal_error",
      failure: new Error("private backend detail"),
    },
  ])("logs one safe terminal event for $errorCode", async (sample) => {
    const container = getContainer();
    vi.mocked(getContainer).mockReturnValue(container);
    if (sample.failure) {
      vi.mocked(container.doltgresWorkItems.list).mockRejectedValueOnce(
        sample.failure
      );
    }
    await testApiHandler({
      appHandler,
      url: `/api/v1/work/items${sample.query}`,
      async test({ fetch }) {
        const response = await fetch({ method: "GET" });
        expect(response.status).toBe(sample.status);
        expect(await response.text()).not.toContain("private backend detail");
        expect(container.log.info).toHaveBeenCalledWith(
          expect.objectContaining({
            event: EVENT_NAMES.WORK_ITEMS_LIST_COMPLETE,
            reqId: expect.any(String),
            routeId: "work.items.list",
            status: sample.status,
            outcome: "error",
            errorCode: sample.errorCode,
            durationMs: expect.any(Number),
          }),
          EVENT_NAMES.WORK_ITEMS_LIST_COMPLETE
        );
        expect(container.log.info).toHaveBeenCalledTimes(3);
        expect(container.log.error).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 401 when unauthenticated (sanity)", async () => {
    vi.mocked(session.getSessionUser).mockResolvedValue(null);
    await testApiHandler({
      appHandler,
      url: "/api/v1/work/items",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(401);
      },
    });
  });
});
