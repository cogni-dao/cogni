// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/deploy.promote`
 * Purpose: Contract tests for POST /api/v1/deploy/promote (RBAC-gated manual promote, preview + production).
 * Scope: Auth, input validation, node/billing lookup, the per-env authz gates
 *   (`node.promote_production` for production, `node.manage_envs` for preview — story.5039), and
 *   graceful dispatch-failure handling.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: authz denied ⇒ no dispatch.
 *   - PREVIEW_IS_MANUAL_TOO: env=preview is accepted, gated on `node.manage_envs`; production keeps
 *     `node.promote_production` unchanged; any other env is 400.
 *   - DISPATCH_FAILURE_IS_TYPED: a thrown dispatch returns 502 dispatch_failed, never a raw 500.
 *   - ENV_SCOPED_PARENT: every dispatch uses `NODE_SUBMODULE_PARENT_OWNER/REPO`; no production
 *     repo hardcode can leak into a test operator.
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
  promoteNodeFromPreview: vi.fn(),
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
const envState = vi.hoisted(() => ({
  NODE_SUBMODULE_PARENT_OWNER: "test-owner" as string | undefined,
  NODE_SUBMODULE_PARENT_REPO: "test-repo" as string | undefined,
}));
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
vi.mock("@/shared/env", () => ({
  serverEnv: () => envState,
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
    envState.NODE_SUBMODULE_PARENT_OWNER = "test-owner";
    envState.NODE_SUBMODULE_PARENT_REPO = "test-repo";
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
    mockDeployPlane.promoteNodeFromPreview.mockResolvedValue({
      dispatched: true,
      workflowUrl: "https://github.com/test-owner/test-repo/actions",
      message: "Promote dispatched: sigh → production.",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(401);
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
  });

  it("returns 400 for an env outside preview/production", async () => {
    const res = await post({ nodeId: NODE_ID, env: "candidate-a" });
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

  it("returns 503 when the environment-scoped deployment parent is missing", async () => {
    envState.NODE_SUBMODULE_PARENT_REPO = undefined;
    const res = await post({ nodeId: NODE_ID, env: "preview" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "promote_target_not_configured",
    });
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
    expect(mockDeployPlane.promoteNode).not.toHaveBeenCalled();
    expect(mockDeployPlane.promoteNodeFromPreview).not.toHaveBeenCalled();
  });

  it("returns 200 and dispatches the guarded preview-forward path when no sourceSha", async () => {
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(200);
    expect(mockDeployPlane.promoteNodeFromPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        parentOwner: "test-owner",
        parentRepo: "test-repo",
        slug: "sigh",
        allowRollback: false,
      })
    );
    expect(mockDeployPlane.promoteNode).not.toHaveBeenCalled();
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
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
        allowRollback: false,
      })
    );
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
  });

  it("production stays gated on node.promote_production (unchanged)", async () => {
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(200);
    expect(authzState.check).toHaveBeenCalledWith(
      expect.objectContaining({ action: "node.promote_production" })
    );
  });

  it("accepts env=preview gated on node.manage_envs and routes the SOURCE-ADDRESSED path (story.5039)", async () => {
    const sourceSha = "0123456789012345678901234567890123456789";
    const res = await post({ nodeId: NODE_ID, env: "preview", sourceSha });
    expect(res.status).toBe(200);
    expect(authzState.check).toHaveBeenCalledWith(
      expect.objectContaining({ action: "node.manage_envs" })
    );
    expect(mockDeployPlane.promoteNode).toHaveBeenCalledWith(
      expect.objectContaining({
        env: "preview",
        parentOwner: "test-owner",
        parentRepo: "test-repo",
        slug: "sigh",
        sourceSha,
        allowRollback: false,
      })
    );
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
  });

  it("preserves the manual catalog-pin preview path when sourceSha is omitted", async () => {
    const res = await post({ nodeId: NODE_ID, env: "preview" });
    expect(res.status).toBe(200);
    expect(mockDeployPlane.dispatchNodePromote).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      env: "preview",
      slug: "sigh",
    });
    expect(mockDeployPlane.promoteNodeFromPreview).not.toHaveBeenCalled();
  });

  it("returns 403 authz_denied for preview when node.manage_envs is denied and does NOT dispatch", async () => {
    authzState.decision = "authz_denied";
    const res = await post({ nodeId: NODE_ID, env: "preview" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "authz_denied" });
    expect(authzState.check).toHaveBeenCalledWith(
      expect.objectContaining({ action: "node.manage_envs" })
    );
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
    expect(mockDeployPlane.promoteNode).not.toHaveBeenCalled();
  });

  it("returns 503 authz_unavailable for preview (fail-closed) and does NOT dispatch", async () => {
    authzState.decision = "authz_unavailable";
    const res = await post({ nodeId: NODE_ID, env: "preview" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
    expect(mockDeployPlane.promoteNode).not.toHaveBeenCalled();
  });

  it("returns typed 502 dispatch_failed when dispatch throws (not a raw 500)", async () => {
    mockDeployPlane.promoteNodeFromPreview.mockRejectedValue(
      new Error("GitHub App not installed on owner/repo (HTTP 404).")
    );
    const res = await post({ nodeId: NODE_ID, env: "production" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("dispatch_failed");
    expect(body.message).toContain("not installed");
  });

  it("passes an explicit rollback override only after the normal RBAC gate", async () => {
    const sourceSha = "0123456789012345678901234567890123456789";
    const res = await post({
      nodeId: NODE_ID,
      env: "production",
      sourceSha,
      allowRollback: true,
    });
    expect(res.status).toBe(200);
    expect(authzState.check).toHaveBeenCalledWith(
      expect.objectContaining({ action: "node.promote_production" })
    );
    expect(mockDeployPlane.promoteNode).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSha, allowRollback: true })
    );
  });

  it("returns typed 409 non_forward_promotion without falling through to dispatch", async () => {
    mockDeployPlane.promoteNode.mockRejectedValue(
      Object.assign(new Error("target is not on main"), {
        code: "non_forward_promotion",
        status: 409,
      })
    );
    const res = await post({
      nodeId: NODE_ID,
      env: "production",
      sourceSha: "0123456789012345678901234567890123456789",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "non_forward_promotion",
      message: "target is not on main",
    });
    expect(mockDeployPlane.dispatchNodePromote).not.toHaveBeenCalled();
    expect(mockDeployPlane.promoteNodeFromPreview).not.toHaveBeenCalled();
  });
});
