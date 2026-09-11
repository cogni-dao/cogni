// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/deploy.infra-reconcile`
 * Purpose: Contract tests for the operator-mediated production infrastructure lever.
 * Scope: Auth, strict input, operator-node scope, billing/RBAC gates, and dispatch failures.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: every deny path performs zero deploy-plane calls.
 *   - CALLER_CANNOT_SELECT_SOURCE: SHA, ref, workflow, and infra mode are not API inputs.
 *   - SHARED_INFRA_OPERATOR_ONLY: a promoter for another node cannot reconcile the shared VM.
 * Side-effects: none
 * Links: story.5027, src/app/api/v1/deploy/infra-reconcile/route.ts
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_SHA = "0123456789012345678901234567890123456789";

const mockDeployPlane = vi.hoisted(() => ({
  reconcileNodeInfra: vi.fn(),
}));
const authzState = vi.hoisted(() => ({
  decision: undefined as
    | undefined
    | "authz_allowed"
    | "authz_denied"
    | "authz_unavailable",
  check: vi.fn(),
}));
const dbState = vi.hoisted(() => ({
  node: {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "operator",
  } as { id: string; slug: string } | null,
  billing: { id: "billing-1" } as { id: string } | null,
  call: 0,
}));
const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const mockTx = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          const first = dbState.call === 0;
          dbState.call += 1;
          if (first) return dbState.node ? [dbState.node] : [];
          return dbState.billing ? [dbState.billing] : [];
        },
      }),
    }),
  }),
};

vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => mockDeployPlane,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2026-09-11T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    authorization:
      authzState.decision === undefined
        ? undefined
        : { check: authzState.check },
  }),
  resolveServiceDb: () => mockTx,
}));
vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attrs: Record<string, string>,
    handler: (ctx: {
      traceId: string;
      span: { setAttribute: () => void };
    }) => Promise<unknown>
  ) => handler({ traceId: "trace-1", span: { setAttribute: vi.fn() } }),
}));
vi.mock("@/shared/config/repoSpec.server", () => ({
  getGithubRepo: () => ({ owner: "test-owner", repo: "test-repo" }),
}));
vi.mock("@/shared/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));
vi.mock("@/shared/observability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/observability")>();
  return {
    ...actual,
    createRequestContext: () => ({
      log: mockLog,
      reqId: "req-1",
      routeId: "deploy.infra_reconcile",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

import * as appHandler from "@/app/api/v1/deploy/infra-reconcile/route";

async function post(body: unknown): Promise<Response> {
  let res!: Response;
  await testApiHandler({
    appHandler,
    async test({ fetch }) {
      res = await fetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  });
  return res;
}

describe("POST /api/v1/deploy/infra-reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.node = { id: NODE_ID, slug: "operator" };
    dbState.billing = { id: "billing-1" };
    dbState.call = 0;
    authzState.decision = "authz_allowed";
    authzState.check.mockImplementation(async () => ({
      decision: authzState.decision === "authz_allowed" ? "allow" : "deny",
      code:
        authzState.decision === "authz_unavailable"
          ? "authz_unavailable"
          : authzState.decision === "authz_denied"
            ? "authz_denied"
            : "authz_allowed",
    }));
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    mockDeployPlane.reconcileNodeInfra.mockResolvedValue({
      status: "dispatched",
      env: "production",
      sourceSha: SOURCE_SHA,
      sourceAddressing: "in_repo",
      workflowUrl: "https://github.com/test-owner/test-repo/actions",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(401);
    expect(mockDeployPlane.reconcileNodeInfra).not.toHaveBeenCalled();
  });

  it.each([
    { nodeId: NODE_ID, env: "preview" },
    { nodeId: NODE_ID, env: "production", sourceSha: SOURCE_SHA },
    { nodeId: NODE_ID, env: "production", workflow: "anything.yml" },
    { nodeId: NODE_ID, env: "production", deployInfraMode: "full" },
  ])("returns 400 for non-contract input %#", async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(mockDeployPlane.reconcileNodeInfra).not.toHaveBeenCalled();
  });

  it("returns 404 when the node does not exist", async () => {
    dbState.node = null;
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "node_not_found" });
    expect(mockDeployPlane.reconcileNodeInfra).not.toHaveBeenCalled();
  });

  it("rejects a non-operator node before billing or authz", async () => {
    dbState.node = { id: NODE_ID, slug: "beacon" };
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "infra_reconcile_operator_only",
    });
    expect(authzState.check).not.toHaveBeenCalled();
    expect(mockDeployPlane.reconcileNodeInfra).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller has no billing account", async () => {
    dbState.billing = null;
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "billing_account_missing" });
    expect(mockDeployPlane.reconcileNodeInfra).not.toHaveBeenCalled();
  });

  it("returns 503 when authorization is unavailable", async () => {
    authzState.decision = undefined;
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
    expect(mockDeployPlane.reconcileNodeInfra).not.toHaveBeenCalled();
  });

  it("returns 403 on authz denial and performs no side effect", async () => {
    authzState.decision = "authz_denied";
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "authz_denied" });
    expect(mockDeployPlane.reconcileNodeInfra).not.toHaveBeenCalled();
  });

  it("checks the exact production-promoter tuple, then dispatches", async () => {
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(200);
    expect(authzState.check).toHaveBeenCalledWith({
      actorId: `user:${TEST_SESSION_USER_1.id}`,
      action: "node.promote_production",
      resource: `node:${NODE_ID}`,
      context: { tenantId: "billing-1", nodeId: NODE_ID },
    });
    expect(mockDeployPlane.reconcileNodeInfra).toHaveBeenCalledWith({
      env: "production",
      parentOwner: "test-owner",
      parentRepo: "test-repo",
      slug: "operator",
    });
  });

  it("returns typed 502 when the App dispatch fails", async () => {
    mockDeployPlane.reconcileNodeInfra.mockRejectedValue(
      new Error("GitHub App dispatch denied")
    );
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "dispatch_failed",
      message: "GitHub App dispatch denied",
    });
  });
});
