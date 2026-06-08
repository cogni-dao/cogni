// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/nodes.developers`
 * Purpose: Contract tests for owner-gated node developer approval tuple writes.
 * Scope: Verifies POST /api/v1/nodes/[id]/developers validates ownership before OpenFGA writes.
 * Invariants: OWNER_GATING, OPENFGA_IS_AUTHORITY.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/nodes/[id]/developers/route.ts
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_USER_ID = "22222222-2222-4222-8222-222222222222";

const authz = vi.hoisted(() => ({
  writeRelation: vi.fn(),
  deleteRelation: vi.fn(),
}));
const dbState = vi.hoisted(() => ({
  ownerNode: null as { id: string } | null,
  agentUser: null as { id: string } | null,
}));
const mockGetServerSessionUser = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  child: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

function rowsFrom<T>(rows: T[]): {
  from(): { where(): { limit(): T[] } };
} {
  return {
    from: () => ({
      where: () => ({
        limit: () => rows,
      }),
    }),
  };
}

const mockAppDb = {
  select: () => rowsFrom(dbState.ownerNode ? [dbState.ownerNode] : []),
};
const mockServiceDb = {
  select: () => rowsFrom(dbState.agentUser ? [dbState.agentUser] : []),
};

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    authorization: authz,
    clock: { now: () => "2026-06-08T00:00:00.000Z" },
    config: { unhandledErrorPolicy: "respond_500" },
    log: mockLogger,
  }),
  resolveAppDb: () => mockAppDb,
  resolveServiceDb: () => mockServiceDb,
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: () => mockGetServerSessionUser(),
}));

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    run: (tx: unknown) => unknown
  ) => run(mockAppDb),
}));

import * as appHandler from "@/app/api/v1/nodes/[id]/developers/route";

describe("POST /api/v1/nodes/[id]/developers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.child.mockReturnValue(mockLogger);
    mockGetServerSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    authz.writeRelation.mockResolvedValue({
      decision: "success",
      code: "authz_write_success",
    });
    authz.deleteRelation.mockResolvedValue({
      decision: "success",
      code: "authz_write_success",
    });
    dbState.ownerNode = { id: NODE_ID };
    dbState.agentUser = { id: AGENT_USER_ID };
  });

  it("approves a registered agent user as node developer", async () => {
    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          nodeId: NODE_ID,
          agentUserId: AGENT_USER_ID,
          decision: "approve",
        });
      },
    });

    expect(authz.writeRelation).toHaveBeenCalledWith({
      user: `user:${AGENT_USER_ID}`,
      relation: "developer",
      object: `node:${NODE_ID}`,
    });
    expect(authz.deleteRelation).not.toHaveBeenCalled();
  });

  it("rejects by removing the node developer tuple", async () => {
    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "reject",
          }),
        });
        expect(res.status).toBe(200);
      },
    });

    expect(authz.deleteRelation).toHaveBeenCalledWith({
      user: `user:${AGENT_USER_ID}`,
      relation: "developer",
      object: `node:${NODE_ID}`,
    });
    expect(authz.writeRelation).not.toHaveBeenCalled();
  });

  it("does not write OpenFGA when the caller is not node owner", async () => {
    dbState.ownerNode = null;

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentUserId: AGENT_USER_ID,
            decision: "approve",
          }),
        });
        expect(res.status).toBe(404);
      },
    });

    expect(authz.writeRelation).not.toHaveBeenCalled();
    expect(authz.deleteRelation).not.toHaveBeenCalled();
  });
});
