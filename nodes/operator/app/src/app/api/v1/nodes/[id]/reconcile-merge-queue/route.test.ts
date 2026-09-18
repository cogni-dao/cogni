// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/reconcile-merge-queue` (test)
 * Purpose: Pin node-scoped authorization and delegation to the App-backed queue reconciler.
 * Scope: Mocked route collaborators; no GitHub, auth, or database IO.
 * Side-effects: none
 * Links: route.ts, task.5141
 * @public
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authorize = vi.fn();
const resolveNodeRepo = vi.fn();
const reconcileMergeQueuePolicy = vi.fn();

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: authorize,
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64: "a2V5",
    NODE_SUBMODULE_PARENT_OWNER: "cogni-dao",
    NODE_SUBMODULE_PARENT_REPO: "cogni",
  }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: unknown) =>
      handler(
        { log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
        request,
        { id: "user-1" },
        context
      ),
}));
vi.mock("@/bootstrap/capabilities/node-repo-write", () => ({
  createNodeRepoWriter: () => ({
    resolveNodeRepo,
    reconcileMergeQueuePolicy,
  }),
}));

const post = async (): Promise<Response> => {
  const { POST } = await import("./route");
  return POST(
    new Request(
      "https://operator.example/api/v1/nodes/operator/reconcile-merge-queue",
      { method: "POST" }
    ) as NextRequest,
    { params: Promise.resolve({ id: "operator" }) }
  );
};

describe("POST /api/v1/nodes/[id]/reconcile-merge-queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue({
      ok: true,
      node: { nodeId: "node-1", slug: "operator" },
    });
    resolveNodeRepo.mockResolvedValue({ owner: "cogni-dao", repo: "cogni" });
    reconcileMergeQueuePolicy.mockResolvedValue({
      status: "applied",
      rulesetName: "main-merge-queue",
      policyRef: "main",
      mismatches: [
        "merge_queue.min_entries_to_merge_wait_minutes is 5, expected 0",
      ],
      waitMinutes: 0,
    });
  });

  it("uses node.manage_envs and applies parent main policy to the resolved node repo", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      node: { id: "node-1", slug: "operator" },
      repository: "cogni-dao/cogni",
      result: { status: "applied", waitMinutes: 0 },
    });
    expect(authorize).toHaveBeenCalledWith({
      id: "operator",
      userId: "user-1",
      action: "node.manage_envs",
    });
    expect(resolveNodeRepo).toHaveBeenCalledWith({
      parentOwner: "cogni-dao",
      parentRepo: "cogni",
      slug: "operator",
    });
    expect(reconcileMergeQueuePolicy).toHaveBeenCalledWith({
      policyOwner: "cogni-dao",
      policyRepo: "cogni",
      policyRef: "main",
      targetOwner: "cogni-dao",
      targetRepo: "cogni",
    });
  });

  it("fails closed before GitHub when node.manage_envs is denied", async () => {
    authorize.mockResolvedValue({
      ok: false,
      errorCode: "authz_denied",
      status: 403,
    });
    const response = await post();
    expect(response.status).toBe(403);
    expect(resolveNodeRepo).not.toHaveBeenCalled();
    expect(reconcileMergeQueuePolicy).not.toHaveBeenCalled();
  });

  it("preserves typed policy errors from the App-backed writer", async () => {
    reconcileMergeQueuePolicy.mockRejectedValue(
      Object.assign(new Error("administration:write is required"), {
        code: "protection_unavailable",
        status: 502,
      })
    );
    const response = await post();
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "protection_unavailable",
    });
  });
});
