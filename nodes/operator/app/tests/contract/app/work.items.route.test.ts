// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/work.items.route`
 * Purpose: Route-level contract tests for GET /api/v1/work/items.
 * Scope: Verifies error translation — malformed cursor → 400 (not generic 500).
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

import * as session from "@/app/_lib/auth/session";
import * as appHandler from "@/app/api/v1/work/items/route";

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
