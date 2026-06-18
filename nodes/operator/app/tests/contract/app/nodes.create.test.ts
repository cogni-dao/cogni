// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/nodes.create`
 * Purpose: Contract tests for node creation seeding the owner→admin OpenFGA tuple.
 * Scope: Verifies POST /api/v1/nodes writes `user:<owner> admin node:<id>` after insert, that the
 *   seed is best-effort where no store exists, and that a seed failure does not fail creation.
 * Invariants: OPENFGA_IS_AUTHORITY, OWNER_GATING.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/nodes/route.ts, story.5009, docs/spec/rbac.md
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const SLUG = "test-node";
const CHAIN_ID = 8453;

const authz = vi.hoisted(() => ({
  writeRelation: vi.fn(),
}));
const container = vi.hoisted(() => ({
  authorization: undefined as { writeRelation: unknown } | undefined,
}));
const dbState = vi.hoisted(() => ({
  insertedNode: null as { id: string; slug: string } | null,
  existingNode: null as { id: string; slug: string } | null,
}));
const mockGetServerSessionUser = vi.hoisted(() => vi.fn());

const mockTx = {
  insert: () => ({
    values: () => ({
      onConflictDoNothing: () => ({
        returning: () => (dbState.insertedNode ? [dbState.insertedNode] : []),
      }),
    }),
  }),
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => (dbState.existingNode ? [dbState.existingNode] : []),
        orderBy: () => ({ limit: () => [] }),
      }),
    }),
  }),
};

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => container,
  resolveAppDb: () => ({}),
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: () => mockGetServerSessionUser(),
}));

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    run: (tx: unknown) => unknown
  ) => run(mockTx),
}));

import * as appHandler from "@/app/api/v1/nodes/route";

async function postCreate(): Promise<{ status: number; body: unknown }> {
  let captured: { status: number; body: unknown } = { status: 0, body: null };
  await testApiHandler({
    appHandler,
    async test({ fetch }) {
      const res = await fetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: SLUG, chainId: CHAIN_ID }),
      });
      captured = { status: res.status, body: await res.json() };
    },
  });
  return captured;
}

describe("POST /api/v1/nodes (admin tuple seed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    authz.writeRelation.mockResolvedValue({
      decision: "success",
      code: "authz_write_success",
    });
    container.authorization = authz;
    dbState.insertedNode = { id: NODE_ID, slug: SLUG };
    dbState.existingNode = null;
  });

  it("seeds the owner→admin tuple on create (stores-enabled env)", async () => {
    const res = await postCreate();
    expect(res.status).toBe(201);

    expect(authz.writeRelation).toHaveBeenCalledWith({
      user: `user:${TEST_SESSION_USER_1.id}`,
      relation: "admin",
      object: `node:${NODE_ID}`,
    });
  });

  it("creates the node without a tuple where no OpenFGA store exists", async () => {
    container.authorization = undefined;

    const res = await postCreate();
    expect(res.status).toBe(201);
    expect(authz.writeRelation).not.toHaveBeenCalled();
  });

  it("still returns 201 when the tuple seed fails (best-effort)", async () => {
    authz.writeRelation.mockResolvedValue({
      decision: "failure",
      code: "authz_write_unavailable",
    });

    const res = await postCreate();
    expect(res.status).toBe(201);
    expect(authz.writeRelation).toHaveBeenCalledOnce();
  });

  it("does not seed a tuple when the slug is already taken (409)", async () => {
    dbState.insertedNode = null;
    dbState.existingNode = { id: NODE_ID, slug: SLUG };

    const res = await postCreate();
    expect(res.status).toBe(409);
    expect(authz.writeRelation).not.toHaveBeenCalled();
  });
});
