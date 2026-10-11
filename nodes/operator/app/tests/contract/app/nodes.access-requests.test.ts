// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/nodes.access-requests`
 * Purpose: Contract tests for the agent-facing node access-request endpoint.
 * Scope: Verifies POST /api/v1/nodes/[id]/access-requests requires identity, requests for the
 *   authenticated principal only, preserves already-effective OpenFGA authority, and upserts a
 *   pending tracking row only on a real deny.
 * Invariants: AUTH_REQUIRED, SELF_REQUEST_ONLY, OPENFGA_IS_AUTHORITY, IDEMPOTENT_WHEN_GRANTED.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/nodes/[id]/access-requests/route.ts
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";

const upsert = vi.hoisted(() => ({
  values: vi.fn(),
  onConflict: vi.fn(),
}));
const mockAuthorize = vi.hoisted(() => vi.fn());
const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  child: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockServiceDb = {
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

vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: (input: unknown) => mockAuthorize(input),
}));

import * as appHandler from "@/app/api/v1/nodes/[id]/access-requests/route";

describe("POST /api/v1/nodes/[id]/access-requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.child.mockReturnValue(mockLogger);
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    mockAuthorize.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: "authz_denied",
      nodeId: NODE_ID,
      slug: "operator",
    });
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
          role: "developer",
          status: "pending",
        });
      },
    });

    expect(upsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: NODE_ID,
        agentUserId: TEST_SESSION_USER_1.id,
        role: "developer",
        status: "pending",
      })
    );
    // Idempotency: the upsert reopens the single row instead of inserting a duplicate.
    expect(upsert.onConflict).toHaveBeenCalled();
  });

  it("persists the agent's self-declared githubLogin on the request", async () => {
    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: "developer",
            githubLogin: "flock-leader",
          }),
        });
        expect(res.status).toBe(201);
      },
    });

    expect(upsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUserId: TEST_SESSION_USER_1.id,
        githubLogin: "flock-leader",
      })
    );
  });

  it("returns approved without reopening a request when OpenFGA already allows the role", async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      node: { nodeId: NODE_ID, slug: "operator" },
    });

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "developer" }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          nodeId: NODE_ID,
          agentUserId: TEST_SESSION_USER_1.id,
          role: "developer",
          status: "approved",
        });
      },
    });

    expect(upsert.values).not.toHaveBeenCalled();
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
    mockAuthorize.mockResolvedValue({
      ok: false,
      status: 404,
      errorCode: "node_not_found",
    });

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

  it("fails closed without reopening a request when authorization is unavailable", async () => {
    mockAuthorize.mockResolvedValue({
      ok: false,
      status: 503,
      errorCode: "authz_unavailable",
      nodeId: NODE_ID,
      slug: "operator",
    });

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: "authorization unavailable",
          errorCode: "authz_unavailable",
        });
      },
    });

    expect(upsert.values).not.toHaveBeenCalled();
  });
});
