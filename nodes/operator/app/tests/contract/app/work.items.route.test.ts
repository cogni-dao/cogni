// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/work.items.route`
 * Purpose: Route-level contract tests for GET /api/v1/work/items.
 * Scope: Verifies error translation — malformed cursor → 400 (not generic 500) —
 *   and the opt-in lean list projection.
 *   Uses next-test-api-route-handler with mocked container + session.
 * Invariants:
 *   - INVALID_CURSOR_400: garbage cursor returns 400 with `{ error: "invalid cursor" }`
 *   - AUTH_REQUIRED: 401 when no session (sanity)
 *   - LEAN_VIEW_OPT_IN: `view=lean` omits summary/outcome; default keeps them;
 *     an unknown view is a 400
 * Side-effects: none
 * Links: bug.5162, bug.5509, PR #1180 review finding 1,
 *   nodes/operator/app/src/app/api/v1/work/items/route.ts
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "@/app/_lib/auth/session";
import * as appHandler from "@/app/api/v1/work/items/route";
import { getContainer } from "@/bootstrap/container";

vi.mock("@/bootstrap/container", () => {
  const log = {
    child: vi.fn(() => log),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  const container = {
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
  };
  return { getContainer: vi.fn(() => container) };
});

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

describe("GET /api/v1/work/items — cursor error translation", () => {
  beforeEach(() => {
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
        expect(body).toEqual({ error: "invalid cursor" });
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

describe("GET /api/v1/work/items — lean view (bug.5509)", () => {
  const STORED_ITEM = {
    id: "task.5001",
    type: "task",
    title: "Lean list item",
    status: "needs_implement",
    summary: "long-form summary body",
    outcome: "long-form outcome body",
    node: "operator",
    assignees: [],
    externalRefs: [],
    actor: "either",
    labels: ["ui"],
    specRefs: [],
    revision: 1,
    deployVerified: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
  };

  beforeEach(() => {
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
  });

  function storeReturnsOneItem() {
    const { doltgresWorkItems } = vi.mocked(getContainer)();
    vi.mocked(doltgresWorkItems.list).mockResolvedValueOnce({
      items: [STORED_ITEM],
      pageInfo: { endCursor: null, hasMore: false },
    } as never);
  }

  async function getItems(url: string) {
    let status = 0;
    let body: { items?: Array<Record<string, unknown>> } = {};
    await testApiHandler({
      appHandler,
      url,
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        status = res.status;
        body = await res.json();
      },
    });
    return { status, body };
  }

  it("omits summary and outcome when view=lean", async () => {
    storeReturnsOneItem();
    const { status, body } = await getItems("/api/v1/work/items?view=lean");
    expect(status).toBe(200);
    expect(body.items?.[0]).toMatchObject({
      id: "task.5001",
      title: "Lean list item",
      labels: ["ui"],
    });
    expect(body.items?.[0]).not.toHaveProperty("summary");
    expect(body.items?.[0]).not.toHaveProperty("outcome");
  });

  it("keeps summary and outcome by default for API and agent callers", async () => {
    storeReturnsOneItem();
    const { status, body } = await getItems("/api/v1/work/items");
    expect(status).toBe(200);
    expect(body.items?.[0]).toMatchObject({
      summary: "long-form summary body",
      outcome: "long-form outcome body",
    });
  });

  it("returns 400 for an unknown view", async () => {
    const { status } = await getItems("/api/v1/work/items?view=bogus");
    expect(status).toBe(400);
  });
});
