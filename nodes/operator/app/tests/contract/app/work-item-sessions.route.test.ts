// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/work-item-sessions.route`
 * Purpose: Route-level contract tests for operator work-item session endpoints.
 * Scope: Verifies dynamic params, request validation, facade delegation, and
 *   response contract parsing with mocked auth/container/facade.
 * Invariants: AUTH_REQUIRED, CONTRACTS_ARE_TRUTH, OPERATOR_COORDINATION_LOCAL.
 * Side-effects: none
 * Links: src/app/api/v1/work/items/[id]/claims/route.ts,
 *   src/app/api/v1/work/items/[id]/coordination/route.ts, task.5007
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "@/app/_lib/auth/session";
import * as claimsHandler from "@/app/api/v1/work/items/[id]/claims/route";
import * as coordinationHandler from "@/app/api/v1/work/items/[id]/coordination/route";

const mocks = vi.hoisted(() => ({
  claimWorkItemSession: vi.fn(),
  getWorkItemCoordination: vi.fn(),
}));

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
      clock: { now: vi.fn(() => new Date("2026-05-02T12:00:00Z")) },
      config: { unhandledErrorPolicy: "rethrow" },
    })),
  };
});

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

vi.mock("@/app/_facades/work/coordination.server", () => ({
  claimWorkItemSession: mocks.claimWorkItemSession,
  getWorkItemCoordination: mocks.getWorkItemCoordination,
}));

const SESSION_DTO = {
  coordinationId: "00000000-0000-4000-8000-000000005007",
  workItemId: "task.5007",
  status: "active",
  claimedByUserId: TEST_SESSION_USER_1.id,
  claimedByDisplayName: null,
  claimedAt: "2026-05-02T11:55:00.000Z",
  lastHeartbeatAt: null,
  deadlineAt: "2026-05-02T12:30:00.000Z",
  closedAt: null,
  lastCommand: "/implement",
  branch: null,
  prNumber: null,
  repoFullName: null,
} as const;

describe("operator work-item session routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
  });

  it("validates claim request bodies before calling the facade", async () => {
    await testApiHandler({
      appHandler: claimsHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          body: JSON.stringify({ ttlSeconds: 10 }),
          headers: { "content-type": "application/json" },
        });

        expect(res.status).toBe(400);
        expect(mocks.claimWorkItemSession).not.toHaveBeenCalled();
      },
    });
  });

  it("claims a work item session through the route contract", async () => {
    mocks.claimWorkItemSession.mockResolvedValue({
      claimed: true,
      conflict: false,
      session: SESSION_DTO,
      nextAction: "Continue /implement for task.5007.",
      statusUrl: "/api/v1/work/items/task.5007/coordination",
    });

    await testApiHandler({
      appHandler: claimsHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          body: JSON.stringify({
            ttlSeconds: 120,
            lastCommand: "/implement",
          }),
          headers: { "content-type": "application/json" },
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body).toMatchObject({
          claimed: true,
          conflict: false,
          session: { workItemId: "task.5007" },
        });
        expect(mocks.claimWorkItemSession).toHaveBeenCalledWith(
          expect.objectContaining({
            workItemId: "task.5007",
            body: { ttlSeconds: 120, lastCommand: "/implement" },
            sessionUser: TEST_SESSION_USER_1,
            statusUrl: "/api/v1/work/items/task.5007/coordination",
          })
        );
      },
    });
  });

  it("reads coordination state through the route contract", async () => {
    mocks.getWorkItemCoordination.mockResolvedValue({
      workItemId: "task.5007",
      session: SESSION_DTO,
      nextAction: "Continue /implement for task.5007.",
      statusUrl: "/api/v1/work/items/task.5007/coordination",
    });

    await testApiHandler({
      appHandler: coordinationHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
          workItemId: "task.5007",
          session: { coordinationId: SESSION_DTO.coordinationId },
        });
      },
    });
  });
});
