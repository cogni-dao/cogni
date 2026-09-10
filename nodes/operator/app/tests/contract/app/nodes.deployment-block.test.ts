// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/nodes.deployment-block`
 * Purpose: Contract tests for the node deployment-declaration verb — `node.manage_envs`-gated
 *   minting of the `deployment:` block into a node's OWN repo-spec via an operator-authored PR.
 * Scope: Route authz + delegation only; the splice/PR mechanics are covered by the
 *   `GitHubRepoWriter.openNodeDeploymentBlockPr` unit tests and the repo-spec splicer tests.
 * Invariants: MANAGE_ENVS_GATED (fail-closed, no owner bypass), IDEMPOTENT (no_changes passthrough),
 *   SINGLE_HOME (targets the catalog-resolved node repo).
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/nodes/[id]/deployment-block/route.ts, task.5083, story.5016
 * @internal
 */

import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const NODE_SLUG = "test-cog";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockResolveNodeAndAuthorize = vi.hoisted(() => vi.fn());
const writer = vi.hoisted(() => ({
  resolveNodeRepo: vi.fn(),
  openNodeDeploymentBlockPr: vi.fn(),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

vi.mock("@/app/_lib/node-rbac", () => ({
  resolveNodeAndAuthorize: (input: unknown) =>
    mockResolveNodeAndAuthorize(input),
}));

vi.mock("@/bootstrap/capabilities/node-repo-write", () => ({
  createNodeRepoWriter: () => writer,
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64: "a2V5",
    NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
    NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
  }),
}));

import * as appHandler from "@/app/api/v1/nodes/[id]/deployment-block/route";

describe("POST /api/v1/nodes/[id]/deployment-block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionUser.mockResolvedValue({ id: USER_ID });
    mockResolveNodeAndAuthorize.mockResolvedValue({
      ok: true,
      node: {
        nodeId: NODE_ID,
        slug: NODE_SLUG,
        deployEnvs: ["preview"],
        activityEnv: "preview",
      },
    });
    writer.resolveNodeRepo.mockResolvedValue({
      owner: "cogni-test-org",
      repo: NODE_SLUG,
    });
    writer.openNodeDeploymentBlockPr.mockResolvedValue({
      status: "pr_opened",
      prNumber: 33,
      prUrl: "https://github.com/cogni-test-org/test-cog/pull/33",
    });
  });

  it("401s without a session and never touches the writer", async () => {
    mockGetSessionUser.mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(401);
      },
    });

    expect(mockResolveNodeAndAuthorize).not.toHaveBeenCalled();
    expect(writer.openNodeDeploymentBlockPr).not.toHaveBeenCalled();
  });

  it("403s on authz_denied (node.manage_envs) and never touches the writer", async () => {
    mockResolveNodeAndAuthorize.mockResolvedValue({
      ok: false,
      status: 403,
      errorCode: "authz_denied",
      slug: NODE_SLUG,
    });

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: "not authorized",
          errorCode: "authz_denied",
        });
      },
    });

    expect(mockResolveNodeAndAuthorize).toHaveBeenCalledWith({
      id: NODE_ID,
      userId: USER_ID,
      action: "node.manage_envs",
    });
    expect(writer.resolveNodeRepo).not.toHaveBeenCalled();
    expect(writer.openNodeDeploymentBlockPr).not.toHaveBeenCalled();
  });

  it("503s fail-closed when no authorization authority is configured", async () => {
    mockResolveNodeAndAuthorize.mockResolvedValue({
      ok: false,
      status: 503,
      errorCode: "authz_unavailable",
      slug: NODE_SLUG,
    });

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: "authorization not configured",
          errorCode: "authz_unavailable",
        });
      },
    });

    expect(writer.openNodeDeploymentBlockPr).not.toHaveBeenCalled();
  });

  it("404s when the node does not resolve", async () => {
    mockResolveNodeAndAuthorize.mockResolvedValue({
      ok: false,
      status: 404,
      errorCode: "node_not_found",
    });

    await testApiHandler({
      appHandler,
      params: { id: "no-such-node" },
      async test({ fetch }) {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(404);
      },
    });

    expect(writer.openNodeDeploymentBlockPr).not.toHaveBeenCalled();
  });

  it("mints on the node's OWN repo (catalog source_repo), addressed by slug", async () => {
    await testApiHandler({
      appHandler,
      params: { id: NODE_SLUG },
      async test({ fetch }) {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          node: { id: NODE_ID, slug: NODE_SLUG },
          result: {
            status: "pr_opened",
            prNumber: 33,
            prUrl: "https://github.com/cogni-test-org/test-cog/pull/33",
          },
        });
      },
    });

    expect(writer.resolveNodeRepo).toHaveBeenCalledWith({
      parentOwner: "cogni-test-org",
      parentRepo: "cogni-monorepo",
      slug: NODE_SLUG,
    });
    expect(writer.openNodeDeploymentBlockPr).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: NODE_SLUG,
      slug: NODE_SLUG,
    });
  });

  it("passes an idempotent no_changes result through", async () => {
    writer.openNodeDeploymentBlockPr.mockResolvedValue({
      status: "no_changes",
    });

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(200);
        expect((await res.json()).result).toEqual({ status: "no_changes" });
      },
    });
  });

  it("maps a coded writer failure to its status (e.g. catalog_missing 404)", async () => {
    writer.resolveNodeRepo.mockRejectedValue(
      Object.assign(new Error("node catalog entry not found for test-cog"), {
        code: "catalog_missing",
        status: 404,
      })
    );

    await testApiHandler({
      appHandler,
      params: { id: NODE_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "POST" });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({
          error: "node deployment-block write failed",
          errorCode: "catalog_missing",
          reason: "node catalog entry not found for test-cog",
        });
      },
    });

    expect(writer.openNodeDeploymentBlockPr).not.toHaveBeenCalled();
  });
});
