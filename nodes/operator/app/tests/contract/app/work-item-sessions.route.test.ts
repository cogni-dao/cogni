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

import * as requestIdentity from "@/app/_lib/auth/request-identity";
import * as session from "@/app/_lib/auth/session";
import * as claimsHandler from "@/app/api/v1/work/items/[id]/claims/route";
import * as coordinationHandler from "@/app/api/v1/work/items/[id]/coordination/route";
import * as heartbeatHandler from "@/app/api/v1/work/items/[id]/heartbeat/route";

const mocks = vi.hoisted(() => ({
  claimWorkItemAsPrincipal: vi.fn(),
  claimWorkItemSession: vi.fn(),
  getWorkItemCoordination: vi.fn(),
  heartbeatWorkItemAsPrincipal: vi.fn(),
  heartbeatWorkItemSession: vi.fn(),
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

vi.mock("@/app/_lib/auth/request-identity", () => ({
  RequestIdentityUnavailableError: class RequestIdentityUnavailableError extends Error {},
  resolveRequestPrincipal: vi.fn(),
}));

vi.mock("@/app/_facades/work/coordination.server", () => ({
  claimWorkItemAsPrincipal: mocks.claimWorkItemAsPrincipal,
  claimWorkItemSession: mocks.claimWorkItemSession,
  getWorkItemCoordination: mocks.getWorkItemCoordination,
  heartbeatWorkItemAsPrincipal: mocks.heartbeatWorkItemAsPrincipal,
  heartbeatWorkItemSession: mocks.heartbeatWorkItemSession,
}));

const HUMAN_PRINCIPAL = {
  kind: "human" as const,
  principalId: `user:operator/${TEST_SESSION_USER_1.id}`,
  userId: TEST_SESSION_USER_1.id,
  walletAddress: TEST_SESSION_USER_1.walletAddress,
  displayName: TEST_SESSION_USER_1.displayName,
  avatarColor: TEST_SESSION_USER_1.avatarColor,
};

const AGENT_PRINCIPAL = {
  kind: "agent" as const,
  principalId:
    "agent:operator/00000000-0000-4000-8000-000000005264" as const,
  actorId: "00000000-0000-4000-8000-000000005264",
  credentialId: "00000000-0000-4000-8000-000000005265",
  billingAccountId: "00000000-0000-4000-8000-000000005263",
  legacyUserId: null,
  displayName: "fresh-v2",
};

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

describe("operator work-item session routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
    vi.mocked(requestIdentity.resolveRequestPrincipal).mockResolvedValue(
      HUMAN_PRINCIPAL
    );
  });

  it("claims and heartbeats as the exact fresh-v2 principal", async () => {
    const agentSession = {
      ...SESSION_DTO,
      claimedByUserId: AGENT_PRINCIPAL.principalId,
      claimedByPrincipalId: AGENT_PRINCIPAL.principalId,
      claimedByDisplayName: AGENT_PRINCIPAL.displayName,
    };
    vi.mocked(requestIdentity.resolveRequestPrincipal).mockResolvedValue(
      AGENT_PRINCIPAL
    );
    mocks.claimWorkItemAsPrincipal.mockResolvedValue({
      claimed: true,
      conflict: false,
      session: agentSession,
      nextAction: "Continue work.",
      statusUrl: "/api/v1/work/items/task.5007/coordination",
    });
    mocks.heartbeatWorkItemAsPrincipal.mockResolvedValue({
      session: { ...agentSession, lastHeartbeatAt: "2026-05-02T12:00:00.000Z" },
      nextAction: "Continue work.",
      statusUrl: "/api/v1/work/items/task.5007/coordination",
    });

    await testApiHandler({
      appHandler: claimsHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({ lastCommand: "/implement" }),
          headers: { "content-type": "application/json" },
        });
        expect(response.status).toBe(201);
      },
    });

    expect(mocks.claimWorkItemAsPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "task.5007",
        principal: AGENT_PRINCIPAL,
      })
    );
    expect(mocks.claimWorkItemSession).not.toHaveBeenCalled();

    await testApiHandler({
      appHandler: heartbeatHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({ lastCommand: "/review-implementation" }),
          headers: { "content-type": "application/json" },
        });
        expect(response.status).toBe(200);
      },
    });

    expect(mocks.heartbeatWorkItemAsPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: "task.5007",
        principal: AGENT_PRINCIPAL,
      })
    );
    expect(mocks.heartbeatWorkItemSession).not.toHaveBeenCalled();
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
