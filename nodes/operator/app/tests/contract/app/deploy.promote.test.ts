// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/deploy.promote`
 * Purpose: Contract tests for POST /api/v1/deploy/promote (RBAC-gated production promote).
 * Scope: Auth, input validation, node/billing lookup, the `node.promote_production` gate, and
 *   graceful dispatch-failure handling.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: authz denied ⇒ no dispatch.
 *   - PRODUCTION_ONLY_V0: only env=production is accepted.
 *   - DISPATCH_FAILURE_IS_TYPED: a thrown dispatch returns 502 dispatch_failed, never a raw 500.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/deploy/promote/route.ts, docs/spec/rbac.md
 * @internal
 */

import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "22222222-2222-4222-8222-222222222222";

const mockDeployPlane = vi.hoisted(() => ({
  dispatchNodePromote: vi.fn(),
  promoteNode: vi.fn(),
}));
const authzState = vi.hoisted(() => ({
  decision: undefined as
    | undefined
    | "authz_allowed"
    | "authz_denied"
    | "authz_unavailable",
  check: vi.fn(),
}));
// The route reads `nodes` then `billingAccounts` — distinguish by call order.
// Inline the id literal: vi.hoisted runs before module-scope consts initialize.
const dbState = vi.hoisted(() => ({
  node: { id: "22222222-2222-4222-8222-222222222222", slug: "sigh" } as {
    id: string;
    slug: string;
  } | null,
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
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
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
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({}),
}));
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
      routeId: "deploy.promote",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

import * as appHandler from "@/app/api/v1/deploy/promote/route";

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

describe("POST /api/v1/deploy/promote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.node = { id: NODE_ID, slug: "sigh" };
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
    mockDeployPlane.dispatchNodePromote.mockResolvedValue({
      dispatched: true,
      workflowUrl: "https://github.com/test-owner/test-repo/actions",
      message: "Promote dispatched: sigh → production.",
    });
    mockDeployPlane.promoteNode.mockResolvedValue({
      status: "dispatched",
      env: "production",
      sourceSha: "0123456789012345678901234567890123456789",
      sourceAddressing: "remote_source",
      workflowUrl: "https://github.com/test-owner/test-repo/actions",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(401);
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-production env (PRODUCTION_ONLY_V0)", async () => {
    const res = await post({ nodeId: NODE_ID, env: "preview" });
    expect(res.status).toBe(400);
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
  });

  it("returns 404 when the node does not exist", async () => {
    dbState.node = null;
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "node_not_found" });
  });

  it("returns 403 when the caller has no billing account", async () => {
    dbState.billing = null;
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "billing_account_missing" });
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
  });

  it("returns 403 authz_denied and does NOT dispatch (deny-by-default)", async () => {
    authzState.decision = "authz_denied";
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "authz_denied" });
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
  });

  it("returns 200 and dispatches the raw catalog-pin path when no sourceSha (preview-forward mode)", async () => {
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(200);
    expect(mockDeployPlane.dispatchNodePromote).toHaveBeenCalledWith(
      expect.objectContaining({ env: "production", slug: "sigh" })
    );
    expect(mockDeployPlane.promoteNode).not.toHaveBeenCalled();
  });

  it("routes to the SOURCE-ADDRESSED path (promoteNode, env=production) when a sourceSha is supplied (ONE_PROMOTION_PRIMITIVE)", async () => {
    const sourceSha = "0123456789012345678901234567890123456789";
    const res = await post({ nodeId: NODE_ID, env: "production", sourceSha });
    expect(res.status).toBe(200);
    expect(mockDeployPlane.promoteNode).toHaveBeenCalledWith(
      expect.objectContaining({
        env: "production",
        parentOwner: "test-owner",
        parentRepo: "test-repo",
        slug: "sigh",
        sourceSha,
      })
    );
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
  });

  it("returns typed 502 dispatch_failed when dispatch throws (not a raw 500)", async () => {
    mockDeployPlane.dispatchNodePromote.mockRejectedValue(
      new Error("GitHub App not installed on owner/repo (HTTP 404).")
    );
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("dispatch_failed");
    expect(body.message).toContain("not installed");
  });
});
