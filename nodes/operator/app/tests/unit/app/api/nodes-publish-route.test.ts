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
  } as {
    id: string;
    slug: string;
    ownerUserId: string;
    status: string;
    repoOwner: string;
    repoName: string;
    chainId: number | null;
    daoAddress: string | null;
    pluginAddress: string | null;
    signalAddress: string | null;
    publishPrUrl: string | null;
  } | null,
  patch: undefined as
    | { status?: string; publishPrUrl?: string; updatedAt?: Date }
    | undefined,
  throwOnUpdate: false,
}));

const envState = vi.hoisted(() => ({
  current: {
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64:
      Buffer.from("private-key").toString("base64"),
    NODE_MINT_OWNER: "cogni-test-org",
    NODE_TEMPLATE_OWNER: "cogni-test-org",
    NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
    NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
  } as {
    GH_REVIEW_APP_ID?: string;
    GH_REVIEW_APP_PRIVATE_KEY_BASE64?: string;
    NODE_MINT_OWNER?: string;
    NODE_TEMPLATE_OWNER?: string;
    NODE_SUBMODULE_PARENT_OWNER?: string;
    NODE_SUBMODULE_PARENT_REPO?: string;
    DOLTHUB_OWNER?: string;
    DOLTHUB_API_TOKEN?: string;
  },
}));

const mockGetServerSessionUser = vi.hoisted(() => vi.fn());
const mockEnsureDatabase = vi.hoisted(() => vi.fn());
const mockForkFromTemplate = vi.hoisted(() => vi.fn());
const mockOpenNodeSubmodulePr = vi.hoisted(() => vi.fn());
const mockLogEvent = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: (...args: unknown[]) =>
    mockGetServerSessionUser(...args),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => envState.current,
}));

vi.mock("@/bootstrap/capabilities/dolthub-database", () => ({
  createDoltHubDatabaseEnsurer: () => ({
    ensureDatabase: mockEnsureDatabase,
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
  return {
    EVENT_NAMES: {
      ADAPTER_GITHUB_REPO_WRITE_ERROR: "adapter.github_repo_write.error",
      NODE_PUBLISH_COMPLETE: "feature.node_publish.complete",
    },
    createRequestContext: () => ({
      log: mockLog,
      reqId: "req-1",
      routeId: "nodes.publish",
    }),
    logEvent: mockLogEvent,
    logRequestEnd: vi.fn(),
    logRequestStart: vi.fn(),
    makeLogger: () => mockLog,
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
        limit: () => (dbState.current ? [dbState.current] : []),
      }),
    }),
  }),
  update: () => ({
    set: (patch: typeof dbState.patch) => {
      if (dbState.throwOnUpdate) {
        throw new Error("database unavailable");
      }
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

const defaultNode = {
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
};

async function publishNode() {
  return POST(
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
}

describe("POST /api/v1/nodes/[id]/publish", () => {
  beforeEach(() => {
    dbState.current = { ...defaultNode };
    dbState.patch = undefined;
    dbState.throwOnUpdate = false;
    envState.current = {
      GH_REVIEW_APP_ID: "1",
      GH_REVIEW_APP_PRIVATE_KEY_BASE64:
        Buffer.from("private-key").toString("base64"),
      NODE_MINT_OWNER: "cogni-test-org",
      NODE_TEMPLATE_OWNER: "cogni-test-org",
      NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
      NODE_SUBMODULE_PARENT_REPO: "cogni-monorepo",
      DOLTHUB_OWNER: "cogni-dao",
      DOLTHUB_API_TOKEN: "test-dolthub-token",
    };
    mockGetServerSessionUser.mockReset();
    mockGetServerSessionUser.mockResolvedValue({ id: "user-1" });
    mockEnsureDatabase.mockReset();
    mockEnsureDatabase.mockResolvedValue({
      owner: "cogni-dao",
      repo: "knowledge-atlas",
      created: true,
    });
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
    mockLogEvent.mockReset();
    mockLog.child.mockClear();
    mockLog.debug.mockClear();
    mockLog.error.mockClear();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
  });

  it("mints the node repo as a template fork before opening the submodule pin PR", async () => {
    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockEnsureDatabase).toHaveBeenCalledWith({
      owner: "cogni-dao",
      repo: "knowledge-atlas",
      description: "Cogni node atlas knowledge mirror",
    });
    expect(mockForkFromTemplate).toHaveBeenCalledWith({
      templateOwner: "cogni-test-org",
      owner: "cogni-test-org",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
      daoContract: "0x1111111111111111111111111111111111111111",
      pluginContract: "0x2222222222222222222222222222222222222222",
      signalContract: "0x3333333333333333333333333333333333333333",
      knowledgeRemote: {
        database: "knowledge_atlas",
        owner: "cogni-dao",
        repo: "knowledge-atlas",
        url: "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-atlas",
      },
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
      knowledgeRemote: {
        database: "knowledge_atlas",
        owner: "cogni-dao",
        repo: "knowledge-atlas",
        url: "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-atlas",
      },
      nodeRepoUrl: "https://github.com/cogni-test-org/atlas.git",
      nodeRepoHeadSha: "identity-commit",
    });
    expect(dbState.patch?.status).toBe("published");
    expect(dbState.patch?.publishPrUrl).toBe(
      "https://github.com/cogni-test-org/cogni-monorepo/pull/1532"
    );
    expect(body.pr.prNumber).toBe(1532);
    expect(body.doltHub).toEqual({
      owner: "cogni-dao",
      repo: "knowledge-atlas",
      created: true,
    });
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        phase: "started",
        nodeId: "11111111-1111-4111-8111-111111111111",
      }),
      "feature.node_publish.complete"
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        phase: "step",
        step: "bootstrap_dolthub",
        outcome: "success",
        created: true,
      }),
      "feature.node_publish.complete"
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        phase: "step",
        step: "fork_from_template",
        outcome: "started",
        slug: "atlas",
      }),
      "feature.node_publish.complete"
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        phase: "step",
        step: "open_submodule_pr",
        outcome: "success",
        prNumber: 1532,
      }),
      "feature.node_publish.complete"
    );
    expect(mockLogEvent).toHaveBeenCalledWith(
      mockLog,
      "feature.node_publish.complete",
      expect.objectContaining({
        nodeId: "11111111-1111-4111-8111-111111111111",
        outcome: "success",
        prNumber: 1532,
        prUrl: "https://github.com/cogni-test-org/cogni-monorepo/pull/1532",
      })
    );
  });

  it("logs the failing PR formation stage with a classified GitHub status", async () => {
    const err = new Error(
      "GitHub App not installed on cogni-test-org/cogni-monorepo (HTTP 404)"
    );
    Object.assign(err, { status: 404 });
    mockOpenNodeSubmodulePr.mockRejectedValue(err);

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(424);
    expect(body.error).toBe("node publish dependency failed");
    expect(body.reason).toBe(
      "GitHub App installation is missing on the target repository."
    );
    expect(body.errorCode).toBe("app_not_installed");
    expect(body.step).toBe("open_submodule_pr");
    expect(body.reqId).toBe("req-1");
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        phase: "step",
        step: "open_submodule_pr",
        outcome: "error",
        errorCode: "app_not_installed",
        githubStatus: 404,
        slug: "atlas",
      }),
      "feature.node_publish.complete"
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "adapter.github_repo_write.error",
        dep: "github",
        step: "open_submodule_pr",
        reasonCode: "app_not_installed",
        githubStatus: 404,
        reqId: "req-1",
      }),
      "adapter.github_repo_write.error"
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        step: "open_submodule_pr",
        outcome: "error",
        errorCode: "app_not_installed",
        githubStatus: 404,
        status: 424,
        slug: "atlas",
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs unauthenticated requests before leaving the auth stage", async () => {
    mockGetServerSessionUser.mockResolvedValue(null);

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("unauthorized");
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        step: "auth",
        outcome: "error",
        errorCode: "unauthorized",
        status: 401,
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs missing GitHub App config as a terminal config error", async () => {
    envState.current.GH_REVIEW_APP_ID = undefined;

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("operator not configured for repo write");
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        step: "config",
        outcome: "error",
        errorCode: "repo_write_config_missing",
        status: 503,
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs missing mint config as a terminal config error", async () => {
    envState.current.NODE_TEMPLATE_OWNER = undefined;

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("operator not configured for node minting");
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        step: "config",
        outcome: "error",
        errorCode: "node_mint_config_missing",
        status: 503,
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs missing DoltHub config as a terminal config error", async () => {
    envState.current.DOLTHUB_API_TOKEN = undefined;

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("operator not configured for DoltHub bootstrap");
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        step: "config",
        outcome: "error",
        errorCode: "dolthub_config_missing",
        status: 503,
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs a missing node at the load step", async () => {
    dbState.current = null;

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("not found");
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        phase: "step",
        step: "load_node",
        outcome: "error",
        errorCode: "node_not_found",
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs idempotent already-published requests", async () => {
    dbState.current = {
      ...defaultNode,
      status: "published",
      publishPrUrl: "https://github.com/Cogni-DAO/cogni/pull/1",
    };

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.alreadyPublished).toBe(true);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        step: "load_node",
        outcome: "already_published",
        status: 200,
        slug: "atlas",
        nodeStatus: "published",
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs invalid state before attempting repo authoring", async () => {
    dbState.current = { ...defaultNode, status: "dao_pending" };

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("invalid state for publish");
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockForkFromTemplate).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        step: "validate_state",
        outcome: "error",
        errorCode: "invalid_state",
        status: 409,
        nodeStatus: "dao_pending",
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs missing onchain addresses before attempting repo authoring", async () => {
    dbState.current = { ...defaultNode, pluginAddress: null };

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe(
      "node row missing required addresses for repo-spec emission"
    );
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockForkFromTemplate).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        step: "validate_addresses",
        outcome: "error",
        errorCode: "node_addresses_missing",
        status: 409,
        hasChainId: true,
        hasPluginAddress: false,
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs DoltHub bootstrap failures before attempting repo authoring", async () => {
    mockEnsureDatabase.mockRejectedValue(new Error("database already wedged"));

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("dolthub bootstrap failed");
    expect(mockForkFromTemplate).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        phase: "step",
        step: "bootstrap_dolthub",
        outcome: "error",
        errorCode: "dolthub_bootstrap_failed",
      }),
      "feature.node_publish.complete"
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        step: "bootstrap_dolthub",
        outcome: "error",
        errorCode: "dolthub_bootstrap_failed",
        status: 502,
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs the failing template fork stage with a classified GitHub status", async () => {
    const err = new Error("node-template was not found");
    Object.assign(err, { status: 404 });
    mockForkFromTemplate.mockRejectedValue(err);

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(424);
    expect(body.reason).toBe(
      "Configured node-template repository was not found."
    );
    expect(body.errorCode).toBe("template_not_found");
    expect(body.step).toBe("fork_from_template");
    expect(mockOpenNodeSubmodulePr).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        phase: "step",
        step: "fork_from_template",
        outcome: "error",
        errorCode: "template_not_found",
        githubStatus: 404,
      }),
      "feature.node_publish.complete"
    );
  });

  it("logs unexpected persistence failures at the update step", async () => {
    dbState.throwOnUpdate = true;

    const response = await publishNode();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("node publish failed");
    expect(body.reason).toBe("Unexpected node publish failure.");
    expect(body.errorCode).toBe("unhandled");
    expect(body.step).toBe("update_node");
    expect(body.reqId).toBe("req-1");
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "feature.node_publish.complete",
        step: "update_node",
        outcome: "error",
        errorCode: "unhandled",
        status: 500,
      }),
      "feature.node_publish.complete"
    );
  });
});
