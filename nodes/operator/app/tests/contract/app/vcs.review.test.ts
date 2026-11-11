// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/vcs.review`
 * Purpose: Contract tests for POST /api/v1/vcs/review, the developer-requested PR review verb.
 * Scope: Route + real facade with mocked RBAC, deploy plane, review GitHub plane, billing and Temporal; does not call GitHub or Temporal.
 * Invariants:
 *   - REVIEW_IS_DEV_TRIGGERED / STABLE_REVIEW_ID: starts PrReviewWorkflow as pr-review:{owner}/{repo}/{pr}/{headSha}.
 *   - ONE_ACTOR_ONE_ACCOUNT: holds for the operator's own PRs (actor = payer = requestedBy = the session user
 *     and their own billing account). For a linked node (story.0038) the actor and requestedBy stay the session
 *     user, the payer is the system tenant (payerKind system_free) and no developer account is made.
 *   - LINKED_NODES (story.0038): a non-operator node answers 409 review_node_not_linked before any read until
 *     its link is connected; the free-model guard (503) and the caps (429) hold before any read too.
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
const SYSTEM_BILLING_ACCOUNT_ID = "00000000-0000-4000-b000-000000000000";
const BILLING_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

const mockGate = vi.hoisted(() => vi.fn());
const mockResolveNodeRepo = vi.hoisted(() => vi.fn());
const mockResolvePullRequest = vi.hoisted(() => vi.fn());
const mockWorkflowStart = vi.hoisted(() => vi.fn());
const mockBilling = vi.hoisted(() => vi.fn());
const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockOpenLink = vi.hoisted(() => vi.fn());
const mockIsModelFree = vi.hoisted(() => vi.fn());
const mockConsumeLinkedReview = vi.hoisted(() => vi.fn());
const mockGetSystemAccount = vi.hoisted(() => vi.fn());
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
  DEFAULT_REVIEW_MODELREF: {
    providerKey: "platform",
    modelId: "deepseek-v4-flash",
  },
}));
vi.mock("@/bootstrap/node-service-links", () => ({
  getNodeServiceLinkService: () => ({ openLink: mockOpenLink }),
}));
vi.mock("@/bootstrap/review/linked-review-caps", () => ({
  consumeLinkedReview: mockConsumeLinkedReview,
}));
vi.mock("@/shared/ai/model-catalog.server", () => ({
  isModelFree: mockIsModelFree,
}));
vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: mockBilling,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    serviceAccountService: { getBillingAccountById: mockGetSystemAccount },
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
}));
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
    mockOpenLink.mockResolvedValue({ state: "connected" });
    mockIsModelFree.mockResolvedValue(true);
    mockConsumeLinkedReview.mockReturnValue(true);
    mockGetSystemAccount.mockResolvedValue({
      id: SYSTEM_BILLING_ACCOUNT_ID,
      defaultVirtualKeyId: "vk-system",
    });
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
      payerKind: "developer",
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

  describe("a linked node (story.0038)", () => {
    beforeEach(() => {
      mockGate.mockResolvedValue({
        ok: true,
        node: { nodeId: OTHER_NODE_ID, slug: "poly" },
      });
    });

    it("409 review_node_not_linked: refused before any PR or billing read until the link is connected", async () => {
      for (const link of [
        null,
        { state: "pending" },
        { state: "needs_reenroll" },
      ]) {
        mockOpenLink.mockResolvedValue(link);
        const res = await post({ nodeId: "poly", prNumber: 7 });
        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toMatchObject({
          errorCode: "review_node_not_linked",
        });
      }
      expect(mockOpenLink).toHaveBeenCalledWith(OTHER_NODE_ID, "git-review");
      expect(mockResolvePullRequest).not.toHaveBeenCalled();
      expect(mockGetSystemAccount).not.toHaveBeenCalled();
      expect(mockWorkflowStart).not.toHaveBeenCalled();
    });

    it("403: a caller without node.flight on that node never reaches the link check", async () => {
      mockGate.mockResolvedValue({
        ok: false,
        status: 403,
        errorCode: "authz_denied",
      });
      const res = await post({ nodeId: "poly", prNumber: 7 });
      expect(res.status).toBe(403);
      expect(mockOpenLink).not.toHaveBeenCalled();
    });

    it("202: developer actor, system tenant payer (system_free), no developer billing account", async () => {
      const res = await post({ nodeId: "poly", prNumber: 7 });
      expect(res.status).toBe(202);
      expect(mockBilling).not.toHaveBeenCalled();
      expect(mockGetSystemAccount).toHaveBeenCalledOnce();
      const [, options] = mockWorkflowStart.mock.calls[0] as [
        string,
        { args: [Record<string, unknown>] },
      ];
      expect(options.args[0]).toMatchObject({
        nodeId: OPERATOR_NODE_ID,
        actorUserId: TEST_SESSION_USER_1.id,
        requestedBy: TEST_SESSION_USER_1.id,
        billingAccountId: SYSTEM_BILLING_ACCOUNT_ID,
        virtualKeyId: "vk-system",
        payerKind: "system_free",
        codeSubject: { nodeId: OTHER_NODE_ID },
      });
    });

    it("503 review_free_model_unavailable: the runtime free-model guard, before any read", async () => {
      mockIsModelFree.mockResolvedValue(false);
      const res = await post({ nodeId: "poly", prNumber: 7 });
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        errorCode: "review_free_model_unavailable",
      });
      expect(mockIsModelFree).toHaveBeenCalledWith("deepseek-v4-flash");
      expect(mockResolvePullRequest).not.toHaveBeenCalled();
      expect(mockWorkflowStart).not.toHaveBeenCalled();
    });

    it("429 review_rate_limited: the per-developer and per-node caps hold before any read", async () => {
      mockConsumeLinkedReview.mockReturnValue(false);
      const res = await post({ nodeId: "poly", prNumber: 7 });
      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toMatchObject({
        errorCode: "review_rate_limited",
      });
      expect(mockResolvePullRequest).not.toHaveBeenCalled();
      expect(mockWorkflowStart).not.toHaveBeenCalled();
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
