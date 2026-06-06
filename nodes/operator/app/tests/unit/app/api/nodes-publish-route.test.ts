// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-publish-route`
 * Purpose: Unit coverage for POST /api/v1/nodes/[id]/publish node-repo mint orchestration.
 * Scope: Mocks auth, env, DB, and GitHub writer; no real GitHub or Postgres IO.
 * Invariants: NODE_TEMPLATE_ANCESTRY, NODE_SUBMODULE_PIN.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/publish/route.ts, src/adapters/server/vcs/github-repo-write.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  current: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "atlas",
    ownerUserId: "user-1",
    status: "dao_formed",
    repoOwner: "Cogni-DAO",
    repoName: "cogni",
    chainId: 8453,
    daoAddress: "0x1111111111111111111111111111111111111111",
    pluginAddress: "0x2222222222222222222222222222222222222222",
    signalAddress: "0x3333333333333333333333333333333333333333",
    publishPrUrl: null,
  },
  patch: undefined as
    | { status?: string; publishPrUrl?: string; updatedAt?: Date }
    | undefined,
}));

const mockGetServerSessionUser = vi.hoisted(() => vi.fn());
const mockForkFromTemplate = vi.hoisted(() => vi.fn());
const mockOpenNodeSubmodulePr = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    mockGetServerSessionUser(...args),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64:
      Buffer.from("private-key").toString("base64"),
    NODE_MINT_OWNER: "cogni-test-org",
    NODE_TEMPLATE_OWNER: "cogni-test-org",
    NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
    NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
  }),
}));

vi.mock("@/bootstrap/capabilities/node-repo-write", () => ({
  createNodeRepoWriter: () => ({
    forkFromTemplate: mockForkFromTemplate,
    openNodeSubmodulePr: mockOpenNodeSubmodulePr,
  }),
}));

vi.mock("@/bootstrap/container", () => ({
  resolveAppDb: () => ({}),
}));

vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attrs: Record<string, string>,
    handler: (ctx: { traceId: string }) => Promise<unknown>
  ) => handler({ traceId: "trace-1" }),
}));

vi.mock("@/shared/observability", () => {
  const log = {
    child: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return {
    EVENT_NAMES: { NODE_PUBLISH_COMPLETE: "node.publish.complete" },
    createRequestContext: () => ({
      log,
      reqId: "req-1",
      routeId: "nodes.publish",
    }),
    logEvent: vi.fn(),
    makeLogger: () => log,
  };
});

vi.mock("@cogni/db-client", () => ({
  withTenantScope: async (
    _db: unknown,
    _actor: unknown,
    run: (tx: unknown) => unknown
  ) => run(mockTx),
}));

const mockTx = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => [dbState.current],
      }),
    }),
  }),
  update: () => ({
    set: (patch: typeof dbState.patch) => {
      dbState.patch = patch;
      return {
        where: () => ({
          returning: () => [{ ...dbState.current, ...patch }],
        }),
      };
    },
  }),
};

import { POST } from "@/app/api/v1/nodes/[id]/publish/route";

describe("POST /api/v1/nodes/[id]/publish", () => {
  beforeEach(() => {
    dbState.patch = undefined;
    mockGetServerSessionUser.mockReset();
    mockGetServerSessionUser.mockResolvedValue({ id: "user-1" });
    mockForkFromTemplate.mockReset();
    mockForkFromTemplate.mockResolvedValue({
      cloneUrl: "https://github.com/cogni-test-org/atlas.git",
      headSha: "identity-commit",
    });
    mockOpenNodeSubmodulePr.mockReset();
    mockOpenNodeSubmodulePr.mockResolvedValue({
      prNumber: 1532,
      prUrl: "https://github.com/cogni-test-org/cogni-monorepo/pull/1532",
    });
  });

  it("mints the node repo as a template fork before opening the submodule pin PR", async () => {
    const response = await POST(
      new Request(
        "https://operator.test.cognidao.org/api/v1/nodes/11111111-1111-4111-8111-111111111111/publish",
        { method: "POST" }
      ),
      {
        params: Promise.resolve({
          id: "11111111-1111-4111-8111-111111111111",
        }),
      }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockForkFromTemplate).toHaveBeenCalledWith({
      templateOwner: "cogni-test-org",
      owner: "cogni-test-org",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
      daoContract: "0x1111111111111111111111111111111111111111",
      pluginContract: "0x2222222222222222222222222222222222222222",
      signalContract: "0x3333333333333333333333333333333333333333",
    });
    expect(mockOpenNodeSubmodulePr).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
      daoContract: "0x1111111111111111111111111111111111111111",
      pluginContract: "0x2222222222222222222222222222222222222222",
      signalContract: "0x3333333333333333333333333333333333333333",
      nodeRepoUrl: "https://github.com/cogni-test-org/atlas.git",
      nodeRepoHeadSha: "identity-commit",
    });
    expect(dbState.patch?.status).toBe("published");
    expect(dbState.patch?.publishPrUrl).toBe(
      "https://github.com/cogni-test-org/cogni-monorepo/pull/1532"
    );
    expect(body.pr.prNumber).toBe(1532);
  });
});
