// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/vcs.run-ci`
 * Purpose: Contract tests for POST /api/v1/vcs/run-ci (node-scoped).
 * Scope: Verifies auth (401), RBAC (403 deny → grant happy path), VCS-not-configured (503),
 *   node repo resolution from catalog `source_repo`, and 404 on catalog_missing.
 * Invariants:
 *   - RBAC_IS_THE_GATE: `node.flight` on the named node authorizes the approval.
 *   - NO_REPO_FROM_AGENT: owner/repo resolved from the node's catalog `source_repo`.
 *   - CONTRACTS_ARE_TRUTH: 200 response matches runCiOperation.output schema.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/run-ci/route.ts,
 *   packages/node-contracts/src/vcs.run-ci.v1.contract.ts
 * @internal
 */

import { FakeAuthorizationAdapter } from "@cogni/authorization-core";
import { runCiOperation } from "@cogni/node-contracts";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const NODE_SLUG = "creative";

const fakeVcs = vi.hoisted(() => ({
  approveWorkflowRuns: vi.fn(),
  getCiStatus: vi.fn(),
  mergePr: vi.fn(),
  listPrs: vi.fn(),
  createBranch: vi.fn(),
  dispatchCandidateFlight: vi.fn(),
}));

const mockResolveNodeRepo = vi.hoisted(() => vi.fn());
const mockDispatchPrBuild = vi.hoisted(() => vi.fn());
const authzHolder = vi.hoisted(
  () =>
    ({ current: null }) as {
      current: InstanceType<typeof FakeAuthorizationAdapter> | null;
    }
);
const stubSentinel = vi.hoisted(() => ({ __stub: true }));
const containerVcs = vi.hoisted(() => ({ current: null as unknown }));

const dbState = vi.hoisted(() => ({
  byId: {} as Record<string, { nodeId: string; slug: string }>,
}));

const envState = vi.hoisted(() => ({
  current: {
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64:
      Buffer.from("private-key").toString("base64"),
    NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
    NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
  } as Record<string, string | undefined>,
}));

const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => ({
    resolveNodeRepo: mockResolveNodeRepo,
    dispatchPrBuild: mockDispatchPrBuild,
  }),
}));

vi.mock("@/bootstrap/capabilities/vcs", () => ({
  stubVcsCapability: stubSentinel,
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    authorization: authzHolder.current,
    vcsCapability: containerVcs.current,
  }),
  resolveServiceDb: () => ({}),
}));

vi.mock("@/features/nodes/node-lookup", () => ({
  resolveNodeRef: (_db: unknown, id: string) => dbState.byId[id] ?? null,
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

vi.mock("@/shared/observability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/observability")>();
  return {
    ...actual,
    createRequestContext: () => ({
      log: mockLog,
      reqId: "req-1",
      routeId: "vcs.runCi",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

vi.mock("@/shared/env", () => ({
  serverEnv: () => envState.current,
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

import * as appHandler from "@/app/api/v1/vcs/run-ci/route";

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

describe("POST /api/v1/vcs/run-ci", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authzHolder.current = new FakeAuthorizationAdapter();
    containerVcs.current = fakeVcs;
    for (const key of Object.keys(dbState.byId)) delete dbState.byId[key];
    dbState.byId[NODE_ID] = { nodeId: NODE_ID, slug: NODE_SLUG };
    dbState.byId[NODE_SLUG] = { nodeId: NODE_ID, slug: NODE_SLUG };
    envState.current = {
      GH_REVIEW_APP_ID: "1",
      GH_REVIEW_APP_PRIVATE_KEY_BASE64:
        Buffer.from("private-key").toString("base64"),
      NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
      NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
    };
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    mockResolveNodeRepo.mockResolvedValue({
      owner: "Cogni-DAO",
      repo: NODE_SLUG,
    });
    fakeVcs.approveWorkflowRuns.mockResolvedValue({
      approved: 2,
      prNumber: 7,
      headSha: "0123456789012345678901234567890123456789",
      headRepo: "flock-leader/cogni",
      runIds: [101, 102],
      message: "Approved 2 workflow run(s) for PR #7 @ 01234567.",
    });
    mockDispatchPrBuild.mockResolvedValue({
      dispatched: true,
      workflowUrl: "https://github.com/Cogni-DAO/cogni/actions",
      message: "Trusted build dispatched.",
    });
  });

  function grant(nodeId: string): void {
    authzHolder.current?.allow({
      actorId: `user:${TEST_SESSION_USER_1.id}`,
      action: "node.flight",
      resource: `node:${nodeId}`,
      context: { tenantId: nodeId, nodeId },
    });
  }

  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await post({ nodeId: NODE_SLUG, prNumber: 7 });
    expect(res.status).toBe(401);
  });

  it("returns 403 when RBAC denies node.flight (deny-by-default)", async () => {
    const res = await post({ nodeId: NODE_SLUG, prNumber: 7 });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errorCode).toBe("authz_denied");
    expect(fakeVcs.approveWorkflowRuns).not.toHaveBeenCalled();
  });

  it("returns 404 node_not_found for an unknown node", async () => {
    const res = await post({ nodeId: "ghost", prNumber: 7 });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errorCode).toBe("node_not_found");
  });

  it("happy path: resolves the node repo and approves held runs", async () => {
    grant(NODE_ID);
    const res = await post({ nodeId: NODE_SLUG, prNumber: 7 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(runCiOperation.output.safeParse(body).success).toBe(true);
    expect(body.approved).toBe(2);
    expect(body.runIds).toEqual([101, 102]);
    expect(mockResolveNodeRepo).toHaveBeenCalledWith({
      parentOwner: "cogni-test-org",
      parentRepo: "cogni-monorepo",
      slug: NODE_SLUG,
    });
    expect(fakeVcs.approveWorkflowRuns).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: NODE_SLUG,
      prNumber: 7,
    });
    // run-ci's build half: the operator dispatches the trusted pr-build of the
    // approved head so a flightable sha-<headSha> image exists.
    expect(mockDispatchPrBuild).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: NODE_SLUG,
      headRepo: "flock-leader/cogni",
      headSha: "0123456789012345678901234567890123456789",
      prNumber: 7,
    });
  });

  it("operator monorepo lane: catalog_missing for the operator node falls back to NODE_SUBMODULE_PARENT", async () => {
    dbState.byId.operator = { nodeId: NODE_ID, slug: "operator" };
    grant(NODE_ID);
    mockResolveNodeRepo.mockRejectedValue(
      Object.assign(new Error("not found"), { code: "catalog_missing" })
    );
    const res = await post({ nodeId: "operator", prNumber: 7 });
    expect(res.status).toBe(200);
    expect(fakeVcs.approveWorkflowRuns).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      prNumber: 7,
    });
    expect(mockDispatchPrBuild).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      headRepo: "flock-leader/cogni",
      headSha: "0123456789012345678901234567890123456789",
      prNumber: 7,
    });
  });

  it("returns 503 when VcsCapability is the stub", async () => {
    grant(NODE_ID);
    containerVcs.current = stubSentinel;
    const res = await post({ nodeId: NODE_SLUG, prNumber: 7 });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.errorCode).toBe("vcs_not_configured");
  });

  it("returns 404 catalog_missing when the node has no catalog row", async () => {
    grant(NODE_ID);
    mockResolveNodeRepo.mockRejectedValue(
      Object.assign(new Error("not found"), { code: "catalog_missing" })
    );
    const res = await post({ nodeId: NODE_SLUG, prNumber: 7 });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errorCode).toBe("catalog_missing");
    expect(fakeVcs.approveWorkflowRuns).not.toHaveBeenCalled();
  });
});
