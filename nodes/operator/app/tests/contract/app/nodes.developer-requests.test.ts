// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/nodes.developer-requests`
 * Purpose: Contract tests for the agent-facing node developer-access request endpoint.
 * Scope: Verifies POST /api/v1/nodes/[id]/developer-requests requires identity, requests for the
 *   authenticated principal only, and idempotently upserts a single pending tracking row.
 * Invariants: AUTH_REQUIRED, SELF_REQUEST_ONLY, IDEMPOTENT_REOPEN, NOT_AUTHORITY.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/nodes/[id]/developer-requests/route.ts
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";

const dbState = vi.hoisted(() => ({
  node: null as { id: string } | null,
}));
const upsert = vi.hoisted(() => ({
  values: vi.fn(),
  onConflict: vi.fn(),
}));
const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  child: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockServiceDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => (dbState.node ? [dbState.node] : []),
      }),
    }),
  }),
  insert: () => ({
    values: (v: unknown) => {
      upsert.values(v);
      return {
        onConflictDoUpdate: (c: unknown) => {
          upsert.onConflict(c);
          return Promise.resolve(undefined);
        },
      };
    },
  }),
};

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    clock: { now: () => "2026-06-09T00:00:00.000Z" },
    config: { unhandledErrorPolicy: "respond_500" },
    log: mockLogger,
  }),
  resolveServiceDb: () => mockServiceDb,
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

import * as appHandler from "@/app/api/v1/nodes/[id]/developer-requests/route";

describe("POST /api/v1/nodes/[id]/developer-requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.child.mockReturnValue(mockLogger);
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    dbState.node = { id: NODE_ID };
  });

  it("opens a pending request for the authenticated agent", async () => {
    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({
          nodeId: NODE_ID,
          agentUserId: TEST_SESSION_USER_1.id,
          scope: "flight",
          status: "pending",
        });
      },
    });

    expect(upsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: NODE_ID,
        agentUserId: TEST_SESSION_USER_1.id,
        scope: "flight",
        status: "pending",
      })
    );
    // Idempotency: the upsert reopens the single row instead of inserting a duplicate.
    expect(upsert.onConflict).toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before any write", async () => {
    mockGetSessionUser.mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(401);
      },
    });

    expect(upsert.values).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown node without writing", async () => {
    dbState.node = null;

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(404);
      },
    });

    expect(upsert.values).not.toHaveBeenCalled();
  });
});
