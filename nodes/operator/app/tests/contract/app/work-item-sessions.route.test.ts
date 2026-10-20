// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/work-item-sessions.route`
 * Purpose: Route-level contract tests for operator work-item session endpoints.
 * Scope: Verifies dynamic params, request validation, facade delegation, and
 *   real bearer auth, wrapper and PG-backed facades, with provider leaves injected.
 * Invariants: AUTH_REQUIRED, CONTRACTS_ARE_TRUTH, OPERATOR_COORDINATION_LOCAL.
 * Side-effects: none
 * Links: src/app/api/v1/work/items/[id]/claims/route.ts,
 *   src/app/api/v1/work/items/[id]/coordination/route.ts, task.5007
 * @internal
 */

import { createHmac } from "node:crypto";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import * as claimsHandler from "@/app/api/v1/work/items/[id]/claims/route";
import * as coordinationHandler from "@/app/api/v1/work/items/[id]/coordination/route";
import * as heartbeatHandler from "@/app/api/v1/work/items/[id]/heartbeat/route";

const mocks = vi.hoisted(() => ({
  claimWorkItemSession: vi.fn(),
  heartbeat: vi.fn(),
  getCurrent: vi.fn(),
  getContainer: vi.fn(),
  getRequestLoggingDependencies: vi.fn(),
  getWorkItem: vi.fn(),
  headers: vi.fn(),
  getServerSessionUser: vi.fn(),
}));

vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ AUTH_SECRET: "coordination-test-secret" }),
}));
vi.mock("next/headers", () => ({ headers: () => mocks.headers() }));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: () => mocks.getServerSessionUser(),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: mocks.getContainer,
  getRequestLoggingDependencies: mocks.getRequestLoggingDependencies,
  getWorkItemSessionPort: () => ({
    heartbeat: mocks.heartbeat,
    getCurrent: mocks.getCurrent,
  }),
}));
vi.mock("@/app/_facades/work/items.server", () => ({
  getWorkItem: mocks.getWorkItem,
  patchWorkItem: vi.fn(),
}));
vi.mock("@/app/_facades/work/coordination.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/_facades/work/coordination.server")
  >()),
  claimWorkItemSession: mocks.claimWorkItemSession,
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

describe("operator work-item session routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const log = {
      child: vi.fn(() => log),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const deps = {
      log,
      clock: { now: () => new Date() },
      config: { unhandledErrorPolicy: "rethrow" },
    };
    mocks.getContainer.mockReturnValue(deps);
    mocks.getRequestLoggingDependencies.mockReturnValue(deps);
    mocks.headers.mockResolvedValue(new Headers());
    mocks.getServerSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    mocks.getWorkItem.mockRejectedValue(new Error("Dolt must not be called"));
    const stored = {
      ...SESSION_DTO,
      id: SESSION_DTO.coordinationId,
      claimedAt: new Date(SESSION_DTO.claimedAt),
      deadlineAt: new Date(Date.now() + 60_000),
      lastHeartbeatAt: null,
      closedAt: null,
    };
    mocks.heartbeat.mockResolvedValue(stored);
    mocks.getCurrent.mockResolvedValue(stored);
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
    mocks.getContainer.mockImplementation(() => {
      throw new Error("full container must not be constructed");
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
  function requireLightweightPath() {
    mocks.getContainer.mockImplementation(() => {
      throw new Error("full container must not be constructed");
    });
  }

  it("uses the real bearer resolver, wrapper and heartbeat facade without full-container or Dolt access", async () => {
    requireLightweightPath();
    const token = issueAgentApiKey({
      userId: TEST_SESSION_USER_1.id,
      displayName: null,
    });
    mocks.headers.mockResolvedValue(
      new Headers({ authorization: `Bearer ${token}` })
    );
    await testApiHandler({
      appHandler: heartbeatHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ ttlSeconds: 120 }),
        });
        expect(res.status).toBe(200);
        expect((await res.json()).session.coordinationId).toBe(
          SESSION_DTO.coordinationId
        );
      },
    });
    expect(mocks.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ claimedByUserId: TEST_SESSION_USER_1.id })
    );
    expect(mocks.getServerSessionUser).not.toHaveBeenCalled();
    expect(mocks.getContainer).not.toHaveBeenCalled();
    expect(mocks.getWorkItem).not.toHaveBeenCalled();
  });

  it("preserves v1 validation before PostgreSQL mutation on the lightweight route", async () => {
    requireLightweightPath();
    await testApiHandler({
      appHandler: heartbeatHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ttlSeconds: 10 }),
        });
        expect(res.status).toBe(400);
      },
    });
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.getContainer).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "expired",
    "invalid",
  ])("retains real %s authentication rejection without constructing providers", async (kind) => {
    requireLightweightPath();
    const payload = Buffer.from(
      JSON.stringify({ sub: TEST_SESSION_USER_1.id, iat: 1, exp: 2 })
    ).toString("base64url");
    const signature = createHmac("sha256", "coordination-test-secret")
      .update(payload)
      .digest("base64url");
    const token =
      kind === "expired"
        ? `cogni_ag_sk_v1_${payload}.${signature}`
        : "invalid-token";
    mocks.headers.mockResolvedValue(
      new Headers(
        kind === "missing" ? {} : { authorization: `Bearer ${token}` }
      )
    );
    mocks.getServerSessionUser.mockResolvedValue(null);
    await testApiHandler({
      appHandler: heartbeatHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toContain("Bearer");
      },
    });
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.getContainer).not.toHaveBeenCalled();
    if (kind !== "missing")
      expect(mocks.getServerSessionUser).not.toHaveBeenCalled();
  });

  it.each([
    404, 403,
  ])("preserves heartbeat error status %s using only PostgreSQL", async (status) => {
    requireLightweightPath();
    mocks.heartbeat.mockResolvedValue(null);
    mocks.getCurrent.mockResolvedValue(
      status === 404 ? null : { claimedByUserId: "another-user" }
    );
    await testApiHandler({
      appHandler: heartbeatHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        expect(
          (
            await fetch({
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          ).status
        ).toBe(status);
      },
    });
    expect(mocks.getContainer).not.toHaveBeenCalled();
    expect(mocks.getWorkItem).not.toHaveBeenCalled();
  });
  it("preserves production error policy for PostgreSQL failure without constructing providers", async () => {
    requireLightweightPath();
    const deps = mocks.getRequestLoggingDependencies();
    mocks.getRequestLoggingDependencies.mockReturnValue({
      ...deps,
      config: { unhandledErrorPolicy: "respond_500" },
    });
    mocks.heartbeat.mockRejectedValue(new Error("PostgreSQL unavailable"));
    await testApiHandler({
      appHandler: heartbeatHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(res.status).toBe(500);
      },
    });
    expect(mocks.getContainer).not.toHaveBeenCalled();
    expect(mocks.getWorkItem).not.toHaveBeenCalled();
  });
});
