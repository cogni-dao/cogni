// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/vcs.flight`
 * Purpose: Contract tests for POST /api/v1/vcs/flight.
 * Scope: Verifies operator-local node-ref artifact gating, dispatch, and auth.
 * Invariants:
 *   - ARTIFACT_GATE: prepareNodeRefCandidateFlight owns source/image proof before dispatch.
 *   - PARENT_PIN_IS_REVIEW_METADATA: opened parent pin PRs do not block candidate flight.
 *   - CONTRACTS_ARE_TRUTH: 202 response matches flightOperation.output schema.
 * Side-effects: none
 * Links: task.0370, nodes/operator/app/src/app/api/v1/vcs/flight/route.ts,
 *   packages/node-contracts/src/vcs.flight.v1.contract.ts
 * @internal
 */

import { flightOperation } from "@cogni/node-contracts";
import { TEST_SESSION_USER_1, TEST_SESSION_USER_2 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CandidateFlightDispatchResult,
  PreparedNodeRefCandidateFlight,
} from "@/ports";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_SHA = "0123456789012345678901234567890123456789";
const OPERATOR_NODE_ID = "22222222-2222-4222-8222-222222222222";
const CODE_PR_NUMBER = 1799;

const mockDeployPlane = vi.hoisted(() => ({
  prepareNodeRefCandidateFlight: vi.fn(),
  dispatchNodeRefCandidateFlight: vi.fn(),
  dispatchCodePrCandidateFlight: vi.fn(),
}));
// The code-PR path authorizes through the shared `resolveNodeAndAuthorize` seam (operator node,
// can_flight) — mocked directly here, mirroring the merge route's seam, so the nodeRef DB/billing
// authz scaffolding above stays untouched.
const mockResolveNodeAndAuthorize = vi.hoisted(() => vi.fn());
const authzState = vi.hoisted(() => ({
  decision: undefined as
    | undefined
    | "authz_allowed"
    | "authz_denied"
    | "authz_unavailable",
  check: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  current: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "creative",
    ownerUserId: "00000000-0000-4000-a000-000000000001",
  } as { id: string; slug: string; ownerUserId: string } | null,
}));
const billingState = vi.hoisted(() => ({
  current: { id: "billing-agent-1" } as { id: string } | null,
}));
const envState = vi.hoisted(() => ({
  current: {
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64:
      Buffer.from("private-key").toString("base64"),
    NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
    NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
  } as {
    GH_REVIEW_APP_ID?: string;
    GH_REVIEW_APP_PRIVATE_KEY_BASE64?: string;
    NODE_SUBMODULE_PARENT_OWNER?: string;
    NODE_SUBMODULE_PARENT_REPO?: string;
  },
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
  createOperatorDeployPlane: () => mockDeployPlane,
}));

vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: (input: unknown) =>
    mockResolveNodeAndAuthorize(input),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2025-01-01T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    authorization:
      authzState.decision === undefined
        ? undefined
        : {
            check: authzState.check,
          },
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
  ) =>
    handler({
      traceId: "trace-1",
      span: { setAttribute: vi.fn() },
    }),
}));

vi.mock("@/shared/config/repoSpec.server", () => ({
  getGithubRepo: () => ({ owner: "test-owner", repo: "test-repo" }),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => envState.current,
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    run: (tx: unknown) => unknown
  ) => run(mockTx),
}));

const mockTx = {
  select: (selection?: unknown) => ({
    from: () => ({
      where: () => ({
        limit: () => {
          if (selection) {
            return billingState.current ? [billingState.current] : [];
          }
          return dbState.current ? [dbState.current] : [];
        },
      }),
    }),
  }),
};

vi.mock("@/shared/observability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/shared/observability")>();
  return {
    ...actual,
    createRequestContext: () => ({
      log: mockLog,
      reqId: "req-1",
      routeId: "vcs.flight",
    }),
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    logRequestWarn: vi.fn(),
  };
});

import * as appHandler from "@/app/api/v1/vcs/flight/route";

function expectFlightRequestLog(
  level: "info" | "warn" | "error",
  fields: Record<string, unknown>
): void {
  expect(mockLog[level]).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "feature.vcs_flight.request_complete",
      reqId: "req-1",
      routeId: "vcs.flight",
      ...fields,
    }),
    "feature.vcs_flight.request_complete"
  );
}

function statusError(
  status: number,
  code: string,
  message: string
): Error & { readonly status: number; readonly code: string } {
  return Object.assign(new Error(message), { status, code });
}

function makeDispatchResult(
  message = "Flight dispatched"
): CandidateFlightDispatchResult {
  return {
    dispatched: true,
    workflowUrl:
      "https://github.com/test-owner/test-repo/actions/workflows/candidate-flight.yml",
    message,
  };
}

function makePreparedNodeRef(
  overrides: Partial<PreparedNodeRefCandidateFlight> = {}
): PreparedNodeRefCandidateFlight {
  return {
    nodeId: NODE_ID,
    slug: "creative",
    sourceSha: SOURCE_SHA,
    sourceRepo: "https://github.com/Cogni-DAO/creative.git",
    image: `ghcr.io/cogni-dao/creative:sha-${SOURCE_SHA}`,
    ...overrides,
  };
}

describe("POST /api/v1/vcs/flight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authzState.decision = undefined;
    authzState.check.mockImplementation(async () => {
      if (authzState.decision === "authz_allowed") {
        return {
          decision: "allow",
          code: "authz_allowed",
          checks: [],
        };
      }
      return {
        decision: "deny",
        code: authzState.decision ?? "authz_denied",
        checks: [],
      };
    });
    dbState.current = {
      id: NODE_ID,
      slug: "creative",
      ownerUserId: String(TEST_SESSION_USER_1.id),
    };
    billingState.current = { id: "billing-agent-1" };
    envState.current = {
      GH_REVIEW_APP_ID: "1",
      GH_REVIEW_APP_PRIVATE_KEY_BASE64:
        Buffer.from("private-key").toString("base64"),
      NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
      NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
    };
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);
    // Default: operator node resolves + grants can_flight (the allow path).
    mockResolveNodeAndAuthorize.mockResolvedValue({
      ok: true,
      node: { nodeId: OPERATOR_NODE_ID, slug: "operator" },
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodeRef: { nodeId: NODE_ID, sourceSha: SOURCE_SHA },
          }),
        });
        expect(res.status).toBe(401);
      },
    });
  });

  it("returns 202 for an already-pinned node-ref candidate flight", async () => {
    mockDeployPlane.prepareNodeRefCandidateFlight.mockResolvedValue(
      makePreparedNodeRef()
    );
    mockDeployPlane.dispatchNodeRefCandidateFlight.mockResolvedValue(
      makeDispatchResult("Candidate flight dispatched for creative@01234567.")
    );

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodeRef: { nodeId: NODE_ID, sourceSha: SOURCE_SHA },
          }),
        });
        expect(res.status).toBe(202);
        const body = await res.json();
        expect(flightOperation.output.safeParse(body).success).toBe(true);
        expect(body.nodeRef.slug).toBe("creative");
        expect(
          mockDeployPlane.prepareNodeRefCandidateFlight
        ).toHaveBeenCalledWith({
          parentOwner: "cogni-test-org",
          parentRepo: "cogni-monorepo",
          nodeId: NODE_ID,
          slug: "creative",
          sourceSha: SOURCE_SHA,
        });
        expect(
          mockDeployPlane.dispatchNodeRefCandidateFlight
        ).toHaveBeenCalledWith({
          owner: "cogni-test-org",
          repo: "cogni-monorepo",
          slug: "creative",
          sourceSha: SOURCE_SHA,
        });
        expectFlightRequestLog("info", {
          mode: "node_ref",
          outcome: "success",
          status: 202,
          nodeId: NODE_ID,
          slug: "creative",
          sourceSha8: SOURCE_SHA.slice(0, 8),
          dispatchStatus: "initiated",
        });
      },
    });
  });

  it("allows a non-owner caller when OpenFGA grants node flight", async () => {
    authzState.decision = "authz_allowed";
    dbState.current = {
      id: NODE_ID,
      slug: "creative",
      ownerUserId: String(TEST_SESSION_USER_1.id),
    };
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_2);
    mockDeployPlane.prepareNodeRefCandidateFlight.mockResolvedValue(
      makePreparedNodeRef()
    );
    mockDeployPlane.dispatchNodeRefCandidateFlight.mockResolvedValue(
      makeDispatchResult("Candidate flight dispatched for creative@01234567.")
    );

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodeRef: { nodeId: NODE_ID, sourceSha: SOURCE_SHA },
          }),
        });
        expect(res.status).toBe(202);
        expect(authzState.check).toHaveBeenCalledWith({
          actorId: `user:${TEST_SESSION_USER_2.id}`,
          action: "node.flight",
          resource: `node:${NODE_ID}`,
          context: {
            tenantId: "billing-agent-1",
            nodeId: NODE_ID,
          },
        });
        expect(
          mockDeployPlane.dispatchNodeRefCandidateFlight
        ).toHaveBeenCalledOnce();
      },
    });
  });

  it("rejects denied node flight before GitHub dispatch", async () => {
    authzState.decision = "authz_denied";
    dbState.current = {
      id: NODE_ID,
      slug: "creative",
      ownerUserId: String(TEST_SESSION_USER_1.id),
    };
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_2);

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodeRef: { nodeId: NODE_ID, sourceSha: SOURCE_SHA },
          }),
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.errorCode).toBe("authz_denied");
        expect(
          mockDeployPlane.prepareNodeRefCandidateFlight
        ).not.toHaveBeenCalled();
        expect(
          mockDeployPlane.dispatchNodeRefCandidateFlight
        ).not.toHaveBeenCalled();
        expectFlightRequestLog("warn", {
          mode: "node_ref",
          outcome: "error",
          status: 403,
          errorCode: "authz_denied",
          nodeId: NODE_ID,
          slug: "creative",
        });
      },
    });
  });

  it("rejects OpenFGA flight without creating billing state", async () => {
    authzState.decision = "authz_allowed";
    billingState.current = null;
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_2);

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodeRef: { nodeId: NODE_ID, sourceSha: SOURCE_SHA },
          }),
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.errorCode).toBe("billing_account_missing");
        expect(authzState.check).not.toHaveBeenCalled();
        expect(
          mockDeployPlane.prepareNodeRefCandidateFlight
        ).not.toHaveBeenCalled();
        expect(
          mockDeployPlane.dispatchNodeRefCandidateFlight
        ).not.toHaveBeenCalled();
      },
    });
  });

  it("returns classified node-ref preflight failures with request and adapter logs", async () => {
    mockDeployPlane.prepareNodeRefCandidateFlight.mockRejectedValue(
      statusError(422, "source_missing", "sourceSha not found")
    );

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodeRef: { nodeId: NODE_ID, sourceSha: SOURCE_SHA },
          }),
        });
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.errorCode).toBe("source_missing");
        expect(
          mockDeployPlane.dispatchNodeRefCandidateFlight
        ).not.toHaveBeenCalled();
        expect(mockLog.error).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "adapter.github_repo_write.error",
            dep: "github",
            operation: "prepare_node_ref_candidate_flight",
            reasonCode: "source_missing",
            status: 422,
            nodeId: NODE_ID,
            slug: "creative",
          }),
          "adapter.github_repo_write.error"
        );
        expectFlightRequestLog("warn", {
          mode: "node_ref",
          outcome: "error",
          status: 422,
          errorCode: "source_missing",
          nodeId: NODE_ID,
          slug: "creative",
          sourceSha8: SOURCE_SHA.slice(0, 8),
        });
      },
    });
  });

  it("fails closed when node-ref parent deployment repo config is missing", async () => {
    envState.current.NODE_SUBMODULE_PARENT_OWNER = undefined;

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodeRef: { nodeId: NODE_ID, sourceSha: SOURCE_SHA },
          }),
        });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error).toMatch(/NODE_SUBMODULE_PARENT_OWNER/);
        expect(
          mockDeployPlane.prepareNodeRefCandidateFlight
        ).not.toHaveBeenCalled();
        expectFlightRequestLog("error", {
          mode: "node_ref",
          outcome: "error",
          status: 503,
          errorCode: "node_parent_config_missing",
          nodeId: NODE_ID,
          slug: "creative",
          sourceSha8: SOURCE_SHA.slice(0, 8),
        });
      },
    });
  });

  it("dispatches node-ref candidate flight source-addressed, with no catalog pin PR", async () => {
    mockDeployPlane.prepareNodeRefCandidateFlight.mockResolvedValue(
      makePreparedNodeRef()
    );
    mockDeployPlane.dispatchNodeRefCandidateFlight.mockResolvedValue(
      makeDispatchResult("Candidate flight dispatched for creative@01234567.")
    );

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodeRef: { nodeId: NODE_ID, sourceSha: SOURCE_SHA },
          }),
        });
        expect(res.status).toBe(202);
        const body = await res.json();
        // Candidate flight is source-addressed (ONE_PROMOTION_PRIMITIVE,
        // MAIN_WRITE_IS_GOVERNANCE_ONLY): no pin PR is opened on `main`, so the
        // response carries no parent-pin provenance.
        expect(body.nodeRef.parentPrNumber).toBeUndefined();
        expect(body.nodeRef.parentHeadSha).toBeUndefined();
        expect(
          mockDeployPlane.dispatchNodeRefCandidateFlight
        ).toHaveBeenCalledWith({
          owner: "cogni-test-org",
          repo: "cogni-monorepo",
          slug: "creative",
          sourceSha: SOURCE_SHA,
        });
        expectFlightRequestLog("info", {
          mode: "node_ref",
          outcome: "success",
          status: 202,
          nodeId: NODE_ID,
          slug: "creative",
          dispatchStatus: "initiated",
        });
      },
    });
  });
});

describe("POST /api/v1/vcs/flight — codePr (operator-monorepo PR)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.current = {
      GH_REVIEW_APP_ID: "1",
      GH_REVIEW_APP_PRIVATE_KEY_BASE64:
        Buffer.from("private-key").toString("base64"),
      NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
      NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
    };
    mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_2);
    mockResolveNodeAndAuthorize.mockResolvedValue({
      ok: true,
      node: { nodeId: OPERATOR_NODE_ID, slug: "operator" },
    });
    mockDeployPlane.dispatchCodePrCandidateFlight.mockResolvedValue(
      makeDispatchResult(
        `Candidate flight dispatched for PR #${CODE_PR_NUMBER}.`
      )
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codePr: { prNumber: CODE_PR_NUMBER } }),
        });
        expect(res.status).toBe(401);
        expect(
          mockDeployPlane.dispatchCodePrCandidateFlight
        ).not.toHaveBeenCalled();
      },
    });
  });

  it("denies (403) when OpenFGA denies operator-node can_flight, before dispatch", async () => {
    mockResolveNodeAndAuthorize.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: "authz_denied",
      slug: "operator",
    });

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codePr: { prNumber: CODE_PR_NUMBER } }),
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.errorCode).toBe("authz_denied");
        // Authorized against the OPERATOR node, reusing node.flight (can_flight).
        expect(mockResolveNodeAndAuthorize).toHaveBeenCalledWith({
          id: "operator",
          userId: TEST_SESSION_USER_2.id,
          action: "node.flight",
        });
        expect(
          mockDeployPlane.dispatchCodePrCandidateFlight
        ).not.toHaveBeenCalled();
        expectFlightRequestLog("warn", {
          mode: "code_pr",
          outcome: "error",
          status: 403,
          errorCode: "authz_denied",
          prNumber: CODE_PR_NUMBER,
        });
      },
    });
  });

  it("fails closed (503) when no authority is configured", async () => {
    mockResolveNodeAndAuthorize.mockResolvedValue({
      ok: false,
      status: 503,
      errorCode: "authz_unavailable",
      slug: "operator",
    });

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codePr: { prNumber: CODE_PR_NUMBER } }),
        });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.errorCode).toBe("authz_unavailable");
        expect(
          mockDeployPlane.dispatchCodePrCandidateFlight
        ).not.toHaveBeenCalled();
      },
    });
  });

  it("grants → dispatches candidate-flight.yml with pr_number → 202", async () => {
    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codePr: { prNumber: CODE_PR_NUMBER } }),
        });
        expect(res.status).toBe(202);
        const body = await res.json();
        expect(flightOperation.output.safeParse(body).success).toBe(true);
        expect(body.codePr.prNumber).toBe(CODE_PR_NUMBER);
        expect(body.slot).toBe("candidate-a");
        // owner/repo are env-resolved (anti-spoof), never from the request body.
        expect(
          mockDeployPlane.dispatchCodePrCandidateFlight
        ).toHaveBeenCalledWith({
          owner: "cogni-test-org",
          repo: "cogni-monorepo",
          prNumber: CODE_PR_NUMBER,
        });
        expectFlightRequestLog("info", {
          mode: "code_pr",
          outcome: "success",
          status: 202,
          prNumber: CODE_PR_NUMBER,
          dispatchStatus: "initiated",
        });
      },
    });
  });

  it("returns 503 workflow_not_found when GitHub 404s the workflow", async () => {
    mockDeployPlane.dispatchCodePrCandidateFlight.mockRejectedValue(
      statusError(404, "not_found", "Not Found")
    );

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codePr: { prNumber: CODE_PR_NUMBER } }),
        });
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error).toMatch(/candidate-flight\.yml workflow not found/);
        expect(mockLog.error).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "adapter.github_repo_write.error",
            operation: "dispatch_code_pr_candidate_flight",
            reasonCode: "workflow_not_found",
            prNumber: CODE_PR_NUMBER,
          }),
          "adapter.github_repo_write.error"
        );
        expectFlightRequestLog("error", {
          mode: "code_pr",
          outcome: "error",
          status: 503,
          errorCode: "workflow_not_found",
          prNumber: CODE_PR_NUMBER,
        });
      },
    });
  });

  it("rejects a body with neither nodeRef nor codePr (validation_error)", async () => {
    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        expect(mockResolveNodeAndAuthorize).not.toHaveBeenCalled();
        expect(
          mockDeployPlane.dispatchCodePrCandidateFlight
        ).not.toHaveBeenCalled();
      },
    });
  });
});
