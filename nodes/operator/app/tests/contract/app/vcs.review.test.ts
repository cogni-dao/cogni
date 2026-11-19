// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/vcs.review`
 * Purpose: Contract tests for POST /api/v1/vcs/review, the developer-requested PR review verb.
 * Scope: Route + real facade with mocked RBAC, deploy plane, review GitHub plane, billing and Temporal; does not call GitHub or Temporal.
 * Invariants:
 *   - REVIEW_IS_DEV_TRIGGERED / STABLE_REVIEW_ID: starts PrReviewWorkflow as pr-review:{owner}/{repo}/{pr}/{headSha}.
 *   - ONE_ACTOR_ONE_ACCOUNT: actor = payer = requestedBy = the session user and their own billing account.
 *   - SUBJECT_IS_SELF_OR_LISTED (task.5448): a node that is not a listed link target is refused with 422
 *     review_node_unsupported before any read; a listed node needs the signer and reader (typed 503s before dispatch).
 *   - CONTRACTS_ARE_TRUTH: 202 matches reviewOperation.output.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/review/route.ts,
 *   packages/node-contracts/src/vcs.review.v1.contract.ts, story.5102
 * @internal
 */

import { reviewOperation } from "@cogni/node-contracts";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OPERATOR_NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const OTHER_NODE_ID = "22222222-2222-4222-8222-222222222222";
const BILLING_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

const mockFindLinkTarget = vi.hoisted(() => vi.fn());
const mockSigner = vi.hoisted(() => vi.fn());
/** The transport factory the shared package would export; `undefined` = the package has none. */
const mockTransportFactory = vi.hoisted(() => vi.fn());
const readerWith = (extra: Record<string, unknown>) => ({
  originOf: () => "https://node-template-test.cognidao.org",
  get: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
  ...extra,
});
const mockGate = vi.hoisted(() => vi.fn());
const mockResolveNodeRepo = vi.hoisted(() => vi.fn());
const mockResolvePullRequest = vi.hoisted(() => vi.fn());
const mockWorkflowStart = vi.hoisted(() => vi.fn());
const mockBilling = vi.hoisted(() => vi.fn());
const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: mockGate,
}));
vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane: () => ({ resolveNodeRepo: mockResolveNodeRepo }),
}));
vi.mock("@/bootstrap/review/resolve-review-route", () => ({
  createReviewGithubPlane: () => ({
    resolvePullRequest: mockResolvePullRequest,
  }),
}));
vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: mockBilling,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
  }),
  getTemporalWorkflowClient: async () => ({
    client: { start: mockWorkflowStart },
    taskQueue: "operator-queue",
  }),
  resolveAiAdapterDeps: () => ({ accountService: {} }),
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
vi.mock("@/shared/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/config")>()),
  getNodeId: () => OPERATOR_NODE_ID,
  findServiceLinkTarget: (nodeId: string) => mockFindLinkTarget(nodeId),
}));
vi.mock("@/bootstrap/review/git-review-signer", () => ({
  getGitReviewSigner: () => mockSigner(),
}));
// The REAL registry over a per-test factory: the route's gate is `available(target)`, which builds the reader.
vi.mock("@/bootstrap/review/remote-knowledge", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/bootstrap/review/remote-knowledge")
    >();
  return {
    ...actual,
    getRemoteReaderRegistry: () =>
      actual.createRemoteReaderRegistry({
        factory: mockTransportFactory() as never,
        authorizationHeader: async () => "Bearer test",
        log: { info: vi.fn(), warn: vi.fn() },
      }),
  };
});
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
    NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
  }),
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
      routeId: "vcs.review",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

import * as appHandler from "@/app/api/v1/vcs/review/route";

async function post(body: unknown): Promise<Response> {
  let response: Response | undefined;
  await testApiHandler({
    appHandler,
    async test({ fetch }) {
      response = await fetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  });
  if (!response) throw new Error("no response");
  return response;
}

describe("POST /api/v1/vcs/review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    mockGate.mockResolvedValue({
      ok: true,
      node: { nodeId: OPERATOR_NODE_ID, slug: "operator" },
    });
    mockResolveNodeRepo.mockResolvedValue({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
    });
    mockResolvePullRequest.mockResolvedValue({
      installationId: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      state: "open",
    });
    mockBilling.mockResolvedValue({
      id: BILLING_ACCOUNT_ID,
      defaultVirtualKeyId: "vk-developer",
    });
    mockWorkflowStart.mockResolvedValue(undefined);
    mockFindLinkTarget.mockReturnValue(undefined);
    mockSigner.mockResolvedValue({ ok: true, signer: {} });
    // A transport WITH index, as a release that supports reviews of linked nodes would build.
    mockTransportFactory.mockReturnValue(() => readerWith({ index: vi.fn() }));
  });

  it("202: starts the stable-id workflow with actor = payer = requestedBy = session user", async () => {
    const res = await post({ nodeId: "operator", prNumber: 165 });
    expect(res.status).toBe(202);
    const body = reviewOperation.output.parse(await res.json());
    const workflowId = `pr-review:cogni-test-org/cogni-monorepo/165/${HEAD_SHA}`;
    expect(body).toEqual({
      workflowId,
      headSha: HEAD_SHA,
      requestId: expect.any(String),
    });

    expect(mockGate).toHaveBeenCalledWith({
      id: "operator",
      userId: TEST_SESSION_USER_1.id,
      action: "node.flight",
    });
    expect(mockBilling).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ userId: TEST_SESSION_USER_1.id })
    );
    expect(mockWorkflowStart).toHaveBeenCalledOnce();
    const [workflowType, options] = mockWorkflowStart.mock.calls[0] as [
      string,
      {
        workflowId: string;
        taskQueue: string;
        args: [Record<string, unknown>];
      },
    ];
    expect(workflowType).toBe("PrReviewWorkflow");
    expect(options.workflowId).toBe(workflowId);
    expect(options.args[0]).toEqual({
      nodeId: OPERATOR_NODE_ID,
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      prNumber: 165,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      installationId: 42,
      actorUserId: TEST_SESSION_USER_1.id,
      billingAccountId: BILLING_ACCOUNT_ID,
      virtualKeyId: "vk-developer",
      requestId: body.requestId,
      requestedBy: TEST_SESSION_USER_1.id,
      codeSubject: {
        nodeId: OPERATOR_NODE_ID,
        owner: "cogni-test-org",
        repo: "cogni-monorepo",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
    });
  });

  it("401: refuses an unauthenticated caller before any authz or read", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await post({ nodeId: "operator", prNumber: 165 });
    expect(res.status).toBe(401);
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockResolvePullRequest).not.toHaveBeenCalled();
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("400: rejects an invalid body before any authz", async () => {
    const res = await post({ nodeId: "operator", prNumber: "165" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: "validation_error",
    });
    expect(mockGate).not.toHaveBeenCalled();
  });

  it.each([
    [403, "authz_denied"],
    [503, "authz_unavailable"],
    [404, "node_not_found"],
  ] as const)("%s: maps the RBAC failure %s and starts nothing", async (status, errorCode) => {
    mockGate.mockResolvedValue({ ok: false, status, errorCode });
    const res = await post({ nodeId: "operator", prNumber: 165 });
    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toMatchObject({ errorCode });
    expect(mockResolvePullRequest).not.toHaveBeenCalled();
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("422: refuses a node that is not a listed link target before any repo or PR read", async () => {
    mockGate.mockResolvedValue({
      ok: true,
      node: { nodeId: OTHER_NODE_ID, slug: "poly" },
    });
    const res = await post({ nodeId: "poly", prNumber: 7 });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: "review_node_unsupported",
    });
    expect(mockResolveNodeRepo).not.toHaveBeenCalled();
    expect(mockResolvePullRequest).not.toHaveBeenCalled();
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  describe("a listed link target (task.5448)", () => {
    beforeEach(() => {
      mockGate.mockResolvedValue({
        ok: true,
        node: { nodeId: OTHER_NODE_ID, slug: "node-template" },
      });
      mockFindLinkTarget.mockImplementation((nodeId: string) =>
        nodeId === OTHER_NODE_ID
          ? {
              alias: "node-template",
              nodeId: OTHER_NODE_ID,
              origin: "https://node-template-test.cognidao.org",
            }
          : undefined
      );
      mockResolveNodeRepo.mockResolvedValue({
        owner: "cogni-dao",
        repo: "node-template",
      });
    });

    it("202: starts the review with the operator as host node and the listed node as code subject", async () => {
      const res = await post({ nodeId: "node-template", prNumber: 7 });
      expect(res.status).toBe(202);
      const [, options] = mockWorkflowStart.mock.calls[0] as [
        string,
        { args: [Record<string, unknown>] },
      ];
      expect(options.args[0]).toMatchObject({
        nodeId: OPERATOR_NODE_ID,
        owner: "cogni-dao",
        repo: "node-template",
        codeSubject: {
          nodeId: OTHER_NODE_ID,
          owner: "cogni-dao",
          repo: "node-template",
          baseSha: BASE_SHA,
          headSha: HEAD_SHA,
        },
      });
    });

    it("503 review_signer_unavailable: a missing seed refuses the review before dispatch", async () => {
      mockSigner.mockResolvedValue({ ok: false, reason: "seed_missing" });
      const res = await post({ nodeId: "node-template", prNumber: 7 });
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        errorCode: "review_signer_unavailable",
      });
      expect(mockResolveNodeRepo).not.toHaveBeenCalled();
      expect(mockResolvePullRequest).not.toHaveBeenCalled();
      expect(mockWorkflowStart).not.toHaveBeenCalled();
    });

    it("503 review_remote_reader_unavailable: the shared package has no transport factory", async () => {
      mockTransportFactory.mockReturnValue(undefined);
      const res = await post({ nodeId: "node-template", prNumber: 7 });
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        errorCode: "review_remote_reader_unavailable",
      });
      expect(mockResolveNodeRepo).not.toHaveBeenCalled();
      expect(mockWorkflowStart).not.toHaveBeenCalled();
    });

    it("503 review_remote_reader_unavailable: a factory whose reader has NO index (ai-tools 0.15 through 0.17)", async () => {
      mockTransportFactory.mockReturnValue(() => readerWith({}));
      const res = await post({ nodeId: "node-template", prNumber: 7 });
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        errorCode: "review_remote_reader_unavailable",
      });
      expect(mockResolveNodeRepo).not.toHaveBeenCalled();
      expect(mockWorkflowStart).not.toHaveBeenCalled();
    });

    it("the operator's own review never needs the signer or the reader", async () => {
      mockGate.mockResolvedValue({
        ok: true,
        node: { nodeId: OPERATOR_NODE_ID, slug: "operator" },
      });
      mockSigner.mockResolvedValue({ ok: false, reason: "seed_missing" });
      mockTransportFactory.mockReturnValue(undefined);
      mockResolveNodeRepo.mockResolvedValue({
        owner: "cogni-test-org",
        repo: "cogni-monorepo",
      });
      const res = await post({ nodeId: "operator", prNumber: 165 });
      expect(res.status).toBe(202);
      expect(mockSigner).not.toHaveBeenCalled();
    });
  });

  it("409 review_running: a review of the same head is already running", async () => {
    mockWorkflowStart.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        "already started",
        `pr-review:cogni-test-org/cogni-monorepo/165/${HEAD_SHA}`,
        "PrReviewWorkflow"
      )
    );
    const res = await post({ nodeId: "operator", prNumber: 165 });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: "review_running",
      headSha: HEAD_SHA,
    });
  });

  it("409 pr_not_open: a closed PR is not reviewed", async () => {
    mockResolvePullRequest.mockResolvedValue({
      installationId: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      state: "closed",
    });
    const res = await post({ nodeId: "operator", prNumber: 165 });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: "pr_not_open",
    });
    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });
});
