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
  log: {
    child: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/bootstrap/container", () => {
  mocks.log.child.mockReturnValue(mocks.log);
  return {
    getContainer: vi.fn(() => ({
      log: mocks.log,
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
} as const;

function workItemTerminalEvents(): Record<string, unknown>[] {
  return mocks.log.info.mock.calls
    .map(([fields]) => fields)
    .filter(
      (fields): fields is Record<string, unknown> =>
        typeof fields === "object" &&
        fields !== null &&
        (fields as { event?: unknown }).event ===
          "feature.work_item_session.complete"
    );
}

function requestLogCount(): number {
  return (
    mocks.log.info.mock.calls.length +
    mocks.log.warn.mock.calls.length +
    mocks.log.error.mock.calls.length
  );
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("operator work-item session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      claimKind: "reclaimed",
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
        expect(workItemTerminalEvents()).toEqual([
          expect.objectContaining({
            operation: "claim",
            outcome: "success",
            status: 201,
            result: "claimed",
            claimKind: "reclaimed",
          }),
        ]);
        expect(requestLogCount()).toBe(3);
      },
    });
  });

  it("emits one terminal event for a handled claim failure", async () => {
    mocks.claimWorkItemSession.mockRejectedValue(
      namedError("CoordinationWorkItemNotFoundError")
    );

    await testApiHandler({
      appHandler: claimsHandler,
      params: { id: "task.missing" },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          body: JSON.stringify({ ttlSeconds: 120 }),
          headers: { "content-type": "application/json" },
        });

        expect(res.status).toBe(404);
        expect(workItemTerminalEvents()).toEqual([
          expect.objectContaining({
            operation: "claim",
            outcome: "error",
            status: 404,
            errorCode: "work_item_not_found",
          }),
        ]);
        expect(requestLogCount()).toBe(3);
      },
    });
  });

  it("emits only the error terminal when claim output validation fails", async () => {
    mocks.claimWorkItemSession.mockResolvedValue({
      claimed: true,
      conflict: false,
      claimKind: "fresh",
      session: { workItemId: "task.5007" },
      nextAction: "Continue /implement for task.5007.",
      statusUrl: "/api/v1/work/items/task.5007/coordination",
    });

    await testApiHandler({
      appHandler: claimsHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          body: JSON.stringify({ ttlSeconds: 120 }),
          headers: { "content-type": "application/json" },
        });

        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toEqual({
          error: "Internal server error",
        });
        expect(workItemTerminalEvents()).toEqual([
          expect.objectContaining({
            operation: "claim",
            outcome: "error",
            status: 500,
            errorCode: "internal_error",
          }),
        ]);
        expect(requestLogCount()).toBe(3);
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
