// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/internal/operator-change/recover` (test)
 * Purpose: Pin scheduler auth and semantic-vs-retryable recovery error mapping.
 * Scope: Mocked facade only; no GitHub, Temporal, or database IO.
 * Side-effects: none
 * Links: route.ts, task.5188
 * @internal
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recoverOperatorChange = vi.fn();
const createOperatorDeployPlane = vi.fn(() => ({ kind: "test-deploy" }));
const schedulerToken = "scheduler-token-at-least-32-characters";

vi.mock("@/app/_facades/deploy/operator-change-recovery.server", () => ({
  recoverOperatorChange,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ vcsCapability: { kind: "test-vcs" } }),
}));
vi.mock("@/bootstrap/capabilities/operator-deploy-plane", () => ({
  createOperatorDeployPlane,
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ SCHEDULER_API_TOKEN: schedulerToken }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request) =>
      handler(
        { log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
        request
      ),
}));

const validRequest = {
  owner: "cogni-test-org",
  repo: "blue",
  prNumber: 68,
  signedBaseSha: "b".repeat(40),
  losingHeadSha: "a".repeat(40),
  intent: {
    operation: "deployment.declare",
    node: "blue",
    recoveryRootSha: "a".repeat(40),
    recoveryDepth: 0,
  },
};

const registerRequest = {
  ...validRequest,
  intent: {
    operation: "node.register",
    node: "blue",
    nodeId: "11111111-1111-4111-8111-111111111111",
    sourceRepo: "https://github.com/cogni-test-org/blue.git",
    sourceSha: "c".repeat(40),
    ownerWallet: `0x${"1".repeat(40)}`,
    recoveryRootSha: "a".repeat(40),
    recoveryDepth: 0,
  },
};

async function post(
  input: { readonly authorization?: string; readonly body?: unknown } = {}
): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request(
      "https://operator.example/api/internal/operator-change/recover",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.authorization
            ? { authorization: input.authorization }
            : {}),
        },
        body: JSON.stringify(input.body ?? validRequest),
      }
    ) as NextRequest
  );
}

describe("POST /api/internal/operator-change/recover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recoverOperatorChange.mockResolvedValue({
      status: "landed",
      mainSha: "a".repeat(40),
    });
  });

  it("requires the scheduler bearer and a strict request", async () => {
    expect((await post()).status).toBe(401);
    const invalid = await post({
      authorization: `Bearer ${schedulerToken}`,
      body: { ...validRequest, unexpected: true },
    });
    expect(invalid.status).toBe(400);
    expect(recoverOperatorChange).not.toHaveBeenCalled();
  });

  it("returns semantic recovery outcomes as HTTP 200", async () => {
    const response = await post({ authorization: `Bearer ${schedulerToken}` });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "landed",
      mainSha: "a".repeat(40),
    });
    expect(recoverOperatorChange).toHaveBeenCalledWith(
      validRequest,
      { kind: "test-vcs" },
      { kind: "test-deploy" }
    );
  });

  it.each([
    400, 401, 403, 404, 405, 409, 410, 422,
  ])("maps permanent GitHub %s to terminal HTTP 200", async (status) => {
    recoverOperatorChange.mockRejectedValueOnce(
      Object.assign(new Error("permanent"), { status })
    );
    const response = await post({ authorization: `Bearer ${schedulerToken}` });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "terminal",
      reason: `github-permanent-${status}`,
    });
  });

  it.each([
    [404, "catalog_missing"],
    [422, "source_missing"],
    [422, "repo_spec_missing"],
  ])("keeps post-CAS node.register availability %s/%s retryable", async (status, code) => {
    recoverOperatorChange.mockRejectedValueOnce(
      Object.assign(new Error("signed object not visible yet"), {
        status,
        code,
      })
    );
    const response = await post({
      authorization: `Bearer ${schedulerToken}`,
      body: registerRequest,
    });
    expect(response.status).toBe(503);
  });

  it.each([
    [404, "source_missing"],
    [422, "node_id_mismatch"],
    [422, "invalid_repo_spec"],
  ])("keeps unrelated node.register %s/%s terminal", async (status, code) => {
    recoverOperatorChange.mockRejectedValueOnce(
      Object.assign(new Error("permanent register failure"), {
        status,
        code,
      })
    );
    const response = await post({
      authorization: `Bearer ${schedulerToken}`,
      body: registerRequest,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "terminal",
      reason: `github-permanent-${status}`,
    });
  });

  it("keeps the same coded status terminal for non-register operations", async () => {
    recoverOperatorChange.mockRejectedValueOnce(
      Object.assign(new Error("catalog missing"), {
        status: 404,
        code: "catalog_missing",
      })
    );
    const response = await post({
      authorization: `Bearer ${schedulerToken}`,
      body: validRequest,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "terminal",
      reason: "github-permanent-404",
    });
  });

  it.each([
    408,
    429,
    500,
    503,
    undefined,
  ])("keeps retryable or ambiguous GitHub %s as HTTP 503", async (status) => {
    recoverOperatorChange.mockRejectedValueOnce(
      Object.assign(new Error("retry"), status === undefined ? {} : { status })
    );
    const response = await post({ authorization: `Bearer ${schedulerToken}` });
    expect(response.status).toBe(503);
  });
});
