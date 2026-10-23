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
 *   src/app/api/v1/work/items/[id]/coordination/route.ts,
 *   src/app/api/v1/work/items/[id]/pr/route.ts, task.5007
 * @internal
 */

import { createHmac } from "node:crypto";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as requestIdentity from "@/app/_lib/auth/request-identity";
import * as claimsHandler from "@/app/api/v1/work/items/[id]/claims/route";
import * as coordinationHandler from "@/app/api/v1/work/items/[id]/coordination/route";
import * as heartbeatHandler from "@/app/api/v1/work/items/[id]/heartbeat/route";
import * as prHandler from "@/app/api/v1/work/items/[id]/pr/route";

const mocks = vi.hoisted(() => ({
  claimWorkItemAsPrincipal: vi.fn(),
  claimWorkItemSession: vi.fn(),
  heartbeatWorkItemAsPrincipal: vi.fn(),
  heartbeat: vi.fn(),
  getCurrent: vi.fn(),
  getContainer: vi.fn(),
  getRequestLoggingDependencies: vi.fn(),
  getWorkItem: vi.fn(),
  headers: vi.fn(),
  getServerSessionUser: vi.fn(),
  linkPr: vi.fn(),
  patchWorkItemAsPrincipal: vi.fn(),
}));

vi.mock("@/shared/env/server", () => ({
  serverEnv: () => ({ AUTH_SECRET: "coordination-test-secret" }),
}));
vi.mock("@/shared/config", () => ({
  getNodeId: () => "00000000-0000-4000-8000-000000000001",
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
  patchWorkItemAsPrincipal: mocks.patchWorkItemAsPrincipal,
}));
vi.mock("@/app/_facades/work/coordination.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/_facades/work/coordination.server")
  >()),
  claimWorkItemAsPrincipal: mocks.claimWorkItemAsPrincipal,
  claimWorkItemSession: mocks.claimWorkItemSession,
  heartbeatWorkItemAsPrincipal: mocks.heartbeatWorkItemAsPrincipal,
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

const AGENT_PRINCIPAL = {
  kind: "agent" as const,
  principalId: "agent:operator/00000000-0000-4000-8000-000000005264" as const,
  actorId: "00000000-0000-4000-8000-000000005264",
  credentialId: "00000000-0000-4000-8000-000000005265",
  billingAccountId: "00000000-0000-4000-8000-000000005263",
  legacyUserId: null,
  displayName: "fresh-v2",
};

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

  it("claims and heartbeats as the exact fresh-v2 principal", async () => {
    const resolveSpy = vi
      .spyOn(requestIdentity, "resolveRequestPrincipal")
      .mockResolvedValue(AGENT_PRINCIPAL);
    const agentSession = {
      ...SESSION_DTO,
      claimedByUserId: AGENT_PRINCIPAL.principalId,
      claimedByPrincipalId: AGENT_PRINCIPAL.principalId,
      claimedByDisplayName: AGENT_PRINCIPAL.displayName,
    };
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
    resolveSpy.mockRestore();
  });
  function linkPrAs(principal: typeof AGENT_PRINCIPAL) {
    vi.spyOn(requestIdentity, "resolveRequestPrincipal").mockResolvedValue(
      principal
    );
    mocks.getContainer.mockReturnValue({
      ...mocks.getRequestLoggingDependencies(),
      workItemSessions: { linkPr: mocks.linkPr, getCurrent: mocks.getCurrent },
    });
    mocks.getWorkItem.mockResolvedValue({
      id: "task.5007",
      status: "needs_implement",
    });
  }

  function agentStoredSession() {
    return {
      ...SESSION_DTO,
      id: SESSION_DTO.coordinationId,
      claimedByUserId: null,
      claimedByPrincipalId: AGENT_PRINCIPAL.principalId,
      claimedByDisplayName: AGENT_PRINCIPAL.displayName,
      claimedAt: new Date(SESSION_DTO.claimedAt),
      deadlineAt: new Date(Date.now() + 60_000),
      lastHeartbeatAt: null,
      closedAt: null,
      branch: "feat/agent",
      prNumber: 2784,
    };
  }

  async function postPr(): Promise<{ status: number; json: unknown }> {
    let status = 0;
    let json: unknown;
    await testApiHandler({
      appHandler: prHandler,
      params: { id: "task.5007" },
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          body: JSON.stringify({ branch: "feat/agent", prNumber: 2784 }),
          headers: { "content-type": "application/json" },
        });
        status = response.status;
        json = await response.json();
      },
    });
    return { status, json };
  }

  it("links a PR to a fresh-v2 agent's own claim and patches as that principal", async () => {
    linkPrAs(AGENT_PRINCIPAL);
    mocks.linkPr.mockResolvedValue(agentStoredSession());
    mocks.patchWorkItemAsPrincipal.mockResolvedValue({
      id: "task.5007",
      status: "needs_implement",
      pr: "2784",
    });

    const { status, json } = await postPr();

    expect(status).toBe(200);
    expect(json).toMatchObject({
      session: {
        claimedByPrincipalId: AGENT_PRINCIPAL.principalId,
        prNumber: 2784,
      },
    });
    expect(mocks.linkPr).toHaveBeenCalledWith({
      workItemId: "task.5007",
      claimedByPrincipalId: AGENT_PRINCIPAL.principalId,
      branch: "feat/agent",
      prNumber: 2784,
    });
    expect(mocks.patchWorkItemAsPrincipal).toHaveBeenCalledWith(
      { id: "task.5007", set: { branch: "feat/agent", pr: "2784" } },
      AGENT_PRINCIPAL.principalId
    );
  });

  it("refuses a foreign principal linking a PR to another agent's claim", async () => {
    linkPrAs({
      ...AGENT_PRINCIPAL,
      principalId: "agent:operator/00000000-0000-4000-8000-000000009999",
      actorId: "00000000-0000-4000-8000-000000009999",
    } as unknown as typeof AGENT_PRINCIPAL);
    mocks.linkPr.mockResolvedValue(null);
    mocks.getCurrent.mockResolvedValue(agentStoredSession());

    const { status } = await postPr();

    expect(status).toBe(403);
    expect(mocks.patchWorkItemAsPrincipal).not.toHaveBeenCalled();
  });

  function requireLightweightPath() {
    mocks.getContainer.mockImplementation(() => {
      throw new Error("full container must not be constructed");
    });
  }

  it("uses the real bearer resolver, wrapper and heartbeat facade without full-container or Dolt access", async () => {
    requireLightweightPath();
    const token = requestIdentity.issueAgentApiKey({
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
