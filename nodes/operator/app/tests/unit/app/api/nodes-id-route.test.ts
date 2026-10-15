// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-id-route`
 * Purpose: Unit coverage for PATCH /api/v1/nodes/[id] wizard event parsing.
 * Scope: Mocks auth + DB leaves; exercises the real route schema and node state machine.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/route.ts, src/features/nodes/state-machine.ts
 * @public
 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NodeStatus } from "@/shared/db/nodes";

const dbState = vi.hoisted(() => ({
  current: undefined as
    | {
        id: string;
        slug: string;
        ownerUserId: string;
        status: NodeStatus;
        failureReason: string | null;
      }
    | undefined,
  reads: [] as { sql: string; params: unknown[] }[],
  writes: [] as { sql: string; params: unknown[] }[],
  patch: undefined as
    | { status?: NodeStatus; failureReason?: string | null }
    | undefined,
}));

const mockGetServerSessionUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    mockGetServerSessionUser(...args),
}));

vi.mock("@/bootstrap/container", () => ({
  resolveAppDb: () => ({}),
}));

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    run: (tx: unknown) => unknown
  ) => run(mockTx),
}));

const mockTx = {
  select: () => ({
    from: () => ({
      where: (condition: SQL) => {
        dbState.reads.push(new PgDialect().sqlToQuery(condition));
        return { limit: () => (dbState.current ? [dbState.current] : []) };
      },
    }),
  }),
  update: () => ({
    set: (patch: typeof dbState.patch) => {
      dbState.patch = patch;
      return {
        where: (condition: SQL) => {
          dbState.writes.push(new PgDialect().sqlToQuery(condition));
          return { returning: () => [{ ...dbState.current, ...patch }] };
        },
      };
    },
  }),
};

import { GET, PATCH } from "@/app/api/v1/nodes/[id]/route";

const NODE_ID = "11111111-1111-4111-8111-111111111111";

function patchRequest(eventType: string): Request {
  return new Request("https://test.local/api/v1/nodes/node-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: { type: eventType } }),
  });
}

describe("PATCH /api/v1/nodes/[id]", () => {
  beforeEach(() => {
    dbState.current = {
      id: NODE_ID,
      slug: "red",
      ownerUserId: "user-1",
      status: "dao_pending",
      failureReason: null,
    };
    dbState.patch = undefined;
    dbState.reads = [];
    dbState.writes = [];
    mockGetServerSessionUser.mockReset();
    mockGetServerSessionUser.mockResolvedValue({ id: "user-1" });
  });

  it.each([
    NODE_ID,
    "red",
  ])("reads %s with the owner predicate intact", async (id) => {
    const response = await GET(
      new Request(`https://test.local/api/v1/nodes/${id}`),
      {
        params: Promise.resolve({ id }),
      }
    );

    expect(response.status).toBe(200);
    expect((await response.json()).node.id).toBe(NODE_ID);
    expect(dbState.reads[0]?.params).toContain(id);
    expect(dbState.reads[0]?.params).toContain("user-1");
    expect(dbState.reads[0]?.sql).toContain('"nodes"."owner_user_id"');
    if (id === "red") {
      expect(dbState.reads[0]?.sql).toContain('"nodes"."slug"');
      expect(dbState.reads[0]?.sql).not.toContain('"nodes"."id"');
    }
  });

  it.each([
    NODE_ID,
    "red",
  ])("updates %s using the resolved UUID", async (id) => {
    if (dbState.current) dbState.current.status = "published";
    const response = await PATCH(patchRequest("wallet_provisioned"), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).node.id).toBe(NODE_ID);
    expect(dbState.writes[0]?.params).toEqual([NODE_ID, "user-1"]);
    expect(dbState.writes[0]?.sql).toContain('"nodes"."id"');
    if (id === "red")
      expect(dbState.reads[0]?.sql).not.toContain('"nodes"."id"');
  });

  it("returns 404 for an unknown reference without writing", async () => {
    dbState.current = undefined;
    const response = await PATCH(patchRequest("wallet_provisioned"), {
      params: Promise.resolve({ id: "unknown" }),
    });
    expect(response.status).toBe(404);
    expect(dbState.writes).toEqual([]);
  });

  it("rejects unauthenticated slug reads before database access", async () => {
    mockGetServerSessionUser.mockResolvedValue(null);
    const response = await GET(
      new Request("https://test.local/api/v1/nodes/red"),
      {
        params: Promise.resolve({ id: "red" }),
      }
    );
    expect(response.status).toBe(401);
    expect(dbState.reads).toEqual([]);
  });

  it.each([
    ["published", "wallet_provisioned", "wallet_ready"],
  ] as const)("accepts %s + %s and advances to %s", async (currentStatus, eventType, nextStatus) => {
    if (dbState.current) dbState.current.status = currentStatus;

    const response = await PATCH(patchRequest(eventType), {
      params: Promise.resolve({ id: "node-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(dbState.patch?.status).toBe(nextStatus);
    expect(body.node.status).toBe(nextStatus);
  });

  it.each([
    "payments_configured",
    "activation_published",
  ] as const)("rejects browser-declared %s readiness events", async (eventType) => {
    if (dbState.current) dbState.current.status = "wallet_ready";

    const response = await PATCH(patchRequest(eventType), {
      params: Promise.resolve({ id: "node-1" }),
    });

    expect(response.status).toBe(400);
    expect(dbState.patch).toBeUndefined();
  });
});
