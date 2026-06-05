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

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NodeStatus } from "@/shared/db/nodes";

const dbState = vi.hoisted(() => ({
  current: undefined as
    | {
        id: string;
        ownerUserId: string;
        status: NodeStatus;
        failureReason: string | null;
      }
    | undefined,
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
      where: () => ({
        limit: () => (dbState.current ? [dbState.current] : []),
      }),
    }),
  }),
  update: () => ({
    set: (patch: typeof dbState.patch) => {
      dbState.patch = patch;
      return {
        where: () => ({
          returning: () => [{ ...dbState.current, ...patch }],
        }),
      };
    },
  }),
};

import { PATCH } from "@/app/api/v1/nodes/[id]/route";

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
      id: "node-1",
      ownerUserId: "user-1",
      status: "dao_pending",
      failureReason: null,
    };
    dbState.patch = undefined;
    mockGetServerSessionUser.mockReset();
    mockGetServerSessionUser.mockResolvedValue({ id: "user-1" });
  });

  it.each([
    ["published", "wallet_provisioned", "wallet_ready"],
    ["wallet_ready", "payments_configured", "payments_ready"],
    ["payments_ready", "activation_published", "active"],
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
});
