// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/nodes-flight-route`
 * Purpose: Unit coverage for POST /api/v1/nodes/[id]/flight node-ref handoff.
 * Scope: Mocks auth, DB, VCS, and GHCR; no real network or Postgres IO.
 * Invariants: OWNER_GATED_NODE_ID, REPO_SPEC_IS_IDENTITY_SSOT.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/flight/route.ts
 * @internal
 */

import { buildTestRepoSpecYaml } from "@cogni/repo-spec/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_NODE_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const dbState = vi.hoisted(() => ({
  current: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "atlas",
    ownerUserId: "user-1",
  } as { id: string; slug: string; ownerUserId: string } | null,
}));

const mockGetSessionUser = vi.hoisted(() => vi.fn());
const mockCommitExists = vi.hoisted(() => vi.fn());
const mockFetchFileText = vi.hoisted(() => vi.fn());
const mockDispatchNodeFlight = vi.hoisted(() => vi.fn());
const mockPackageImageTagExists = vi.hoisted(() => vi.fn());
const mockEnsureNodeSubmodulePin = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  child: vi.fn().mockReturnThis(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: (...args: unknown[]) => mockGetSessionUser(...args),
}));

vi.mock("@/shared/config/repoSpec.server", () => ({
  getGithubRepo: () => ({ owner: "Cogni-DAO", repo: "cogni" }),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64:
      Buffer.from("private-key").toString("base64"),
  }),
}));

vi.mock("@/bootstrap/capabilities/node-repo-write", () => ({
  createNodeRepoWriter: () => ({
    packageImageTagExists: mockPackageImageTagExists,
    ensureNodeSubmodulePin: mockEnsureNodeSubmodulePin,
  }),
}));

vi.mock("@/bootstrap/container", () => ({
  resolveAppDb: () => ({}),
  getContainer: () => ({
    log: mockLog,
    clock: { now: () => new Date("2026-01-01T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" },
    vcsCapability: {
      listPrs: vi.fn(),
      getCiStatus: vi.fn(),
      mergePr: vi.fn(),
      createBranch: vi.fn(),
      commitExists: mockCommitExists,
      fetchFileText: mockFetchFileText,
      dispatchCandidateFlight: vi.fn(),
      dispatchNodeFlight: mockDispatchNodeFlight,
    },
  }),
}));

vi.mock("@/bootstrap/otel", () => ({
  withRootSpan: async (
    _name: string,
    _attrs: Record<string, string>,
    handler: (ctx: {
      traceId: string;
      span: { setAttribute: (key: string, value: string) => void };
    }) => Promise<unknown>
  ) => handler({ traceId: "trace-1", span: { setAttribute: vi.fn() } }),
}));

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
};

import { POST } from "@/app/api/v1/nodes/[id]/flight/route";

function catalogYaml(slug: string): string {
  return `name: ${slug}
type: node
path_prefix: nodes/${slug}/
source_repo: https://github.com/Cogni-DAO/${slug}.git
image_repository: ghcr.io/cogni-dao/${slug}-node
`;
}

function request(): Request {
  return new Request(`https://operator.test/api/v1/nodes/${NODE_ID}/flight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceSha: SOURCE_SHA }),
  });
}

async function postFlight(): Promise<Response> {
  return POST(request(), {
    params: Promise.resolve({ id: NODE_ID }),
  }) as Promise<Response>;
}

describe("POST /api/v1/nodes/[id]/flight", () => {
  beforeEach(() => {
    dbState.current = {
      id: NODE_ID,
      slug: "atlas",
      ownerUserId: "user-1",
    };
    mockGetSessionUser.mockReset();
    mockGetSessionUser.mockResolvedValue({ id: "user-1" });
    mockCommitExists.mockReset();
    mockCommitExists.mockResolvedValue(true);
    mockFetchFileText.mockReset();
    mockFetchFileText.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "infra/catalog/atlas.yaml") return catalogYaml("atlas");
      if (path === ".cogni/repo-spec.yaml") {
        return buildTestRepoSpecYaml({ nodeId: NODE_ID });
      }
      return null;
    });
    mockDispatchNodeFlight.mockReset();
    mockDispatchNodeFlight.mockResolvedValue({
      dispatched: true,
      slug: "atlas",
      sourceSha: SOURCE_SHA,
      environment: "candidate-a",
      workflowUrl:
        "https://github.com/Cogni-DAO/cogni/actions/workflows/candidate-flight.yml",
      message: "ok",
    });
    mockPackageImageTagExists.mockReset();
    mockPackageImageTagExists.mockResolvedValue(true);
    mockEnsureNodeSubmodulePin.mockReset();
    mockEnsureNodeSubmodulePin.mockResolvedValue({
      status: "already_pinned",
      currentSha: SOURCE_SHA,
    });
  });

  it("derives slug from the owner-scoped node row and dispatches node-ref flight", async () => {
    const response = await postFlight();
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.nodeId).toBe(NODE_ID);
    expect(body.slug).toBe("atlas");
    expect(body.nodeRef).toBe(`atlas@${SOURCE_SHA}`);
    expect(mockFetchFileText).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      path: "infra/catalog/atlas.yaml",
      ref: "main",
    });
    expect(mockDispatchNodeFlight).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      slug: "atlas",
      sourceSha: SOURCE_SHA,
      environment: "candidate-a",
    });
    expect(mockPackageImageTagExists).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      imageRepository: "ghcr.io/cogni-dao/atlas-node",
      tag: `sha-${SOURCE_SHA}`,
    });
    expect(mockEnsureNodeSubmodulePin).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      slug: "atlas",
      nodeRepoUrl: "https://github.com/Cogni-DAO/atlas.git",
      nodeRepoHeadSha: SOURCE_SHA,
    });
  });

  it("opens a parent pin PR and refuses to dispatch when main is not pinned", async () => {
    mockEnsureNodeSubmodulePin.mockResolvedValue({
      status: "pin_pr_opened",
      currentSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      prNumber: 1550,
      prUrl: "https://github.com/Cogni-DAO/cogni/pull/1550",
    });

    const response = await postFlight();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe(
      "operator parent pin required before node-ref flight"
    );
    expect(body.currentSha).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(body.pinPr).toEqual({
      number: 1550,
      url: "https://github.com/Cogni-DAO/cogni/pull/1550",
    });
    expect(mockDispatchNodeFlight).not.toHaveBeenCalled();
  });

  it("fails closed when the child image tag is missing", async () => {
    mockPackageImageTagExists.mockResolvedValue(false);

    const response = await postFlight();
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toBe("node image not found");
    expect(body.image).toBe(`ghcr.io/cogni-dao/atlas-node:sha-${SOURCE_SHA}`);
    expect(mockEnsureNodeSubmodulePin).not.toHaveBeenCalled();
    expect(mockDispatchNodeFlight).not.toHaveBeenCalled();
  });

  it("fails closed when child repo-spec node_id does not match the owner-scoped row", async () => {
    mockFetchFileText.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "infra/catalog/atlas.yaml") return catalogYaml("atlas");
      if (path === ".cogni/repo-spec.yaml") {
        return buildTestRepoSpecYaml({ nodeId: OTHER_NODE_ID });
      }
      return null;
    });

    const response = await postFlight();
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toBe("node repo-spec identity mismatch");
    expect(body.expectedNodeId).toBe(NODE_ID);
    expect(body.actualNodeId).toBe(OTHER_NODE_ID);
    expect(mockDispatchNodeFlight).not.toHaveBeenCalled();
  });
});
