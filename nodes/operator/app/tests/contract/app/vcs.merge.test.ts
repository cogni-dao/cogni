// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/vcs.merge`
 * Purpose: Contract tests for POST /api/v1/vcs/merge — node-scoped + legacy monorepo lanes.
 * Scope: Verifies auth (401), RBAC (403 deny → grant happy path), VCS-not-configured (503),
 *   node-scoped repo resolution (catalog `source_repo`) + catalog_missing hard 404 (never retargets),
 *   and merge-gate coded errors. Fake VcsCapability + FakeAuthorizationAdapter.
 * Invariants:
 *   - NODE_SCOPED_OR_LEGACY: `nodeId` selects RBAC + node repo; absent → operator node + monorepo.
 *   - RBAC_IS_THE_GATE: `node.flight` authorizes the merge.
 *   - CONTRACTS_ARE_TRUTH: 200 response matches mergeOperation.output schema.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/merge/route.ts,
 *   packages/node-contracts/src/vcs.merge.v1.contract.ts
 * @internal
 */

import { FakeAuthorizationAdapter } from "@cogni/authorization-core";
import { mergeOperation } from "@cogni/node-contracts";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OPERATOR_NODE_ID = "00000000-0000-4000-a000-0000000000aa";
const NODE_ID = "11111111-1111-4111-8111-111111111111";
const NODE_SLUG = "creative";

// Fake VcsCapability — only the two methods the merge route uses are exercised.
const fakeVcs = vi.hoisted(() => ({
  getCiStatus: vi.fn(),
  mergePr: vi.fn(),
  // Sentinel only — the route compares the container instance to the stub.
  approveWorkflowRuns: vi.fn(),
  listPrs: vi.fn(),
  createBranch: vi.fn(),
  dispatchCandidateFlight: vi.fn(),
}));

const mockResolveNodeRepo = vi.hoisted(() => vi.fn());
// Fresh adapter per test (no reset API); holder swapped in beforeEach.
const authzHolder = vi.hoisted(
  () =>
    ({ current: null }) as {
      current: InstanceType<typeof FakeAuthorizationAdapter> | null;
    }
);

// Mutable container vcs slot so a test can swap in the stub sentinel.
const stubSentinel = vi.hoisted(() => ({ __stub: true }));
const containerVcs = vi.hoisted(() => ({ current: null as unknown }));

const dbState = vi.hoisted(() => ({
  // resolveNodeRef returns { nodeId, slug } shaped rows; the route reads node.slug.
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
  createOperatorDeployPlane: () => ({ resolveNodeRepo: mockResolveNodeRepo }),
}));

vi.mock("@/bootstrap/capabilities/vcs", () => ({
  // The route compares `container.vcsCapability === stubVcsCapability`.
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
      routeId: "vcs.merge",
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

import * as appHandler from "@/app/api/v1/vcs/merge/route";

function greenCi(overrides: Record<string, unknown> = {}) {
  return {
    prNumber: 42,
    prTitle: "feat: thing",
    author: "flock-leader",
    baseBranch: "main",
    headSha: "0123456789012345678901234567890123456789",
    mergeable: true,
    reviewDecision: "APPROVED",
    labels: [],
    draft: false,
    allGreen: true,
    pending: false,
    checks: [],
    ...overrides,
  };
}

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

describe("POST /api/v1/vcs/merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authzHolder.current = new FakeAuthorizationAdapter();
    // Reset node lookup table (deny-by-default authz).
    for (const key of Object.keys(dbState.byId)) delete dbState.byId[key];
    dbState.byId[OPERATOR_NODE_ID] = {
      nodeId: OPERATOR_NODE_ID,
      slug: "operator",
    };
    dbState.byId.operator = { nodeId: OPERATOR_NODE_ID, slug: "operator" };
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
    containerVcs.current = fakeVcs;
    fakeVcs.getCiStatus.mockResolvedValue(greenCi());
    fakeVcs.mergePr.mockResolvedValue({
      merged: true,
      sha: "abc1234def",
      message: "Merged",
    });
    mockResolveNodeRepo.mockResolvedValue({
      owner: "Cogni-DAO",
      repo: NODE_SLUG,
    });
    // FakeAuthorizationAdapter denies by default; each test grants what it needs.
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
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(401);
  });

  it("returns 403 when RBAC denies node.flight (node-scoped)", async () => {
    // No grant → FakeAuthorizationAdapter denies by default.
    const res = await post({ prNumber: 42, nodeId: NODE_SLUG });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errorCode).toBe("authz_denied");
    expect(fakeVcs.mergePr).not.toHaveBeenCalled();
  });

  it("node-scoped: resolves the node repo and merges on green", async () => {
    grant(NODE_ID);
    const res = await post({ prNumber: 42, nodeId: NODE_SLUG });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mergeOperation.output.safeParse(body).success).toBe(true);
    expect(body.merged).toBe(true);
    expect(mockResolveNodeRepo).toHaveBeenCalledWith({
      parentOwner: "cogni-test-org",
      parentRepo: "cogni-monorepo",
      slug: NODE_SLUG,
    });
    // CI + merge targeted the node's OWN repo, not the monorepo.
    expect(fakeVcs.mergePr).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: NODE_SLUG,
      prNumber: 42,
      method: "squash",
    });
  });

  it("enqueues (async) when the base branch requires a merge queue — no sha, schema-valid", async () => {
    grant(NODE_ID);
    fakeVcs.mergePr.mockResolvedValue({
      merged: false,
      enqueued: true,
      message: "Pull request added to the merge queue",
    });
    const res = await post({ prNumber: 42, nodeId: NODE_SLUG });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mergeOperation.output.safeParse(body).success).toBe(true);
    expect(body.merged).toBe(false);
    expect(body.enqueued).toBe(true);
    expect(body.sha).toBeUndefined();
  });

  it("node-scoped: catalog_missing is a 404, NEVER a silent retarget to the monorepo", async () => {
    grant(NODE_ID);
    mockResolveNodeRepo.mockRejectedValue(
      Object.assign(new Error("not found"), { code: "catalog_missing" })
    );
    const res = await post({ prNumber: 42, nodeId: NODE_SLUG });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errorCode).toBe("catalog_missing");
    // An explicit nodeId must resolve to ITS OWN repo — the monorepo PR #42 is never touched.
    expect(fakeVcs.mergePr).not.toHaveBeenCalled();
  });

  it("guards the GitHub read — App-not-installed → 502 app_not_installed (not an opaque 500)", async () => {
    grant(NODE_ID);
    fakeVcs.getCiStatus.mockRejectedValueOnce(
      new Error(
        "GitHub App not installed on Cogni-DAO/node-template (HTTP 404)"
      )
    );
    const res = await post({ prNumber: 42, nodeId: NODE_SLUG });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("app_not_installed");
    expect(fakeVcs.mergePr).not.toHaveBeenCalled();
  });

  it("legacy: no nodeId → operator-node RBAC + monorepo merge", async () => {
    grant(OPERATOR_NODE_ID);
    const res = await post({ prNumber: 42 });
    expect(res.status).toBe(200);
    expect(mockResolveNodeRepo).not.toHaveBeenCalled();
    expect(fakeVcs.mergePr).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      prNumber: 42,
      method: "squash",
    });
  });

  it("returns 404 node_not_found for an unknown node", async () => {
    const res = await post({ prNumber: 42, nodeId: "ghost" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errorCode).toBe("node_not_found");
  });

  it("returns 503 when VcsCapability is the stub", async () => {
    grant(NODE_ID);
    containerVcs.current = stubSentinel;
    const res = await post({ prNumber: 42, nodeId: NODE_SLUG });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.errorCode).toBe("vcs_not_configured");
  });

  it("surfaces a merge-gate rejection (not green)", async () => {
    grant(NODE_ID);
    fakeVcs.getCiStatus.mockResolvedValue(
      greenCi({ allGreen: false, pending: true })
    );
    const res = await post({ prNumber: 42, nodeId: NODE_SLUG });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe("not_green");
    expect(fakeVcs.mergePr).not.toHaveBeenCalled();
  });

  it("classifies a GitHub merge refusal (405 → 409 merge_rejected)", async () => {
    grant(NODE_ID);
    fakeVcs.mergePr.mockResolvedValue({
      merged: false,
      status: 405,
      message: "not mergeable",
    });
    const res = await post({ prNumber: 42, nodeId: NODE_SLUG });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.errorCode).toBe("merge_rejected");
  });
});
