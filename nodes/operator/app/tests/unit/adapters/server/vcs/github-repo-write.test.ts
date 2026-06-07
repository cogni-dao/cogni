// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/vcs/github-repo-write`
 * Purpose: Unit tests for node repo minting through the operator GitHub App adapter.
 * Scope: Mocked Octokit/fetch only; no real GitHub I/O.
 * Invariants: NODE_TEMPLATE_ANCESTRY — wizard-minted nodes are named forks of node-template.
 * Side-effects: none
 * Links: src/adapters/server/vcs/github-repo-write.ts, docs/spec/node-formation.md
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface RequestCall {
  readonly route: string;
  readonly params: Record<string, unknown>;
}

type RouteHandler = (
  params: Record<string, unknown>
) => Promise<unknown> | unknown;

const requests: RequestCall[] = [];
let routeHandlers: Record<string, RouteHandler> = {};

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "app-token" }),
}));

vi.mock("@octokit/core", () => ({
  Octokit: class MockOctokit {
    async request(route: string, params: Record<string, unknown>) {
      requests.push({ route, params });
      const handler = routeHandlers[route];
      if (!handler) throw new Error(`Unhandled GitHub route: ${route}`);
      return { data: await handler(params) };
    }
  },
}));

import { GitHubRepoWriter } from "@/adapters/server/vcs/github-repo-write";

function statusError(
  status: number,
  message: string
): Error & {
  readonly status: number;
} {
  return Object.assign(new Error(message), { status });
}

function installFetchMock(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 123 }),
    }))
  );
}

function setHappyForkHandlers(): void {
  routeHandlers = {
    "POST /repos/{owner}/{repo}/forks": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "node-template",
        organization: "Cogni-DAO",
        name: "atlas",
        default_branch_only: true,
      });
      return { clone_url: "https://github.com/Cogni-DAO/atlas.git" };
    },
    "GET /repos/{owner}/{repo}/git/ref/{ref}": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "atlas",
        ref: "heads/main",
      });
      return { object: { sha: "template-main" } };
    },
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "atlas",
        commit_sha: "template-main",
      });
      return { tree: { sha: "template-tree" } };
    },
    "PUT /repos/{owner}/{repo}/actions/permissions": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "atlas",
        enabled: true,
        allowed_actions: "all",
      });
      return {};
    },
    "PUT /repos/{owner}/{repo}/actions/permissions/workflow": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "atlas",
        default_workflow_permissions: "write",
        can_approve_pull_request_reviews: false,
      });
      return {};
    },
    "GET /repos/{owner}/{repo}/actions/workflows": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "atlas",
        per_page: 100,
      });
      return {
        workflows: [
          { path: ".github/workflows/ci.yaml", state: "active" },
          { path: ".github/workflows/pr-build.yml", state: "active" },
          { path: ".github/workflows/pr-lint.yaml", state: "active" },
        ],
      };
    },
    "POST /repos/{owner}/{repo}/git/blobs": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "atlas",
        encoding: "base64",
      });
      const content = Buffer.from(String(params.content), "base64").toString(
        "utf-8"
      );
      expect(content).toContain(
        'node_id: "11111111-1111-4111-8111-111111111111"'
      );
      return { sha: "repo-spec-blob" };
    },
    "POST /repos/{owner}/{repo}/git/trees": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "atlas",
        base_tree: "template-tree",
      });
      expect(params.tree).toEqual([
        {
          path: ".cogni/repo-spec.yaml",
          mode: "100644",
          type: "blob",
          sha: "repo-spec-blob",
        },
      ]);
      return { sha: "identity-tree" };
    },
    "POST /repos/{owner}/{repo}/git/commits": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "atlas",
        message: "chore(node): set atlas identity",
        tree: "identity-tree",
        parents: ["template-main"],
      });
      return { sha: "identity-commit" };
    },
    "POST /repos/{owner}/{repo}/git/refs": () =>
      Promise.reject(statusError(422, "Reference already exists")),
    "PATCH /repos/{owner}/{repo}/git/refs/{ref}": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "atlas",
        ref: "heads/main",
        sha: "identity-commit",
        force: true,
      });
      return {};
    },
  };
}

function makeWriter(): GitHubRepoWriter {
  return new GitHubRepoWriter({
    appId: "1",
    privateKey: "key",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  routeHandlers = {};
  installFetchMock();
});

describe("GitHubRepoWriter.forkFromTemplate", () => {
  it("mints a node as a named fork and commits identity on top of template main", async () => {
    setHappyForkHandlers();

    const result = await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
      daoContract: "0x1111111111111111111111111111111111111111",
      pluginContract: "0x2222222222222222222222222222222222222222",
      signalContract: "0x3333333333333333333333333333333333333333",
    });

    expect(result).toEqual({
      cloneUrl: "https://github.com/Cogni-DAO/atlas.git",
      headSha: "identity-commit",
    });
    expect(requests.map((request) => request.route)).toEqual([
      "POST /repos/{owner}/{repo}/forks",
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      "PUT /repos/{owner}/{repo}/actions/permissions",
      "PUT /repos/{owner}/{repo}/actions/permissions/workflow",
      "GET /repos/{owner}/{repo}/actions/workflows",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/trees",
      "POST /repos/{owner}/{repo}/git/commits",
      "POST /repos/{owner}/{repo}/git/refs",
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
    ]);
  });

  it("does not reuse an existing same-named repo unless it is the template fork", async () => {
    routeHandlers = {
      "POST /repos/{owner}/{repo}/forks": () =>
        Promise.reject(statusError(422, "Repository creation failed")),
      "GET /repos/{owner}/{repo}": () => ({
        full_name: "Cogni-DAO/atlas",
        fork: false,
        clone_url: "https://github.com/Cogni-DAO/atlas.git",
      }),
    };

    await expect(
      makeWriter().forkFromTemplate({
        templateOwner: "Cogni-DAO",
        owner: "Cogni-DAO",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        chainId: 8453,
      })
    ).rejects.toThrow(
      "forkFromTemplate: Cogni-DAO/atlas already exists but is not a fork of Cogni-DAO/node-template"
    );
  });

  it("reuses an existing same-named repo when it is the template fork", async () => {
    setHappyForkHandlers();
    routeHandlers["POST /repos/{owner}/{repo}/forks"] = () =>
      Promise.reject(statusError(422, "Repository creation failed"));
    routeHandlers["GET /repos/{owner}/{repo}"] = () => ({
      full_name: "Cogni-DAO/atlas",
      fork: true,
      parent: { full_name: "Cogni-DAO/node-template" },
      clone_url: "https://github.com/Cogni-DAO/atlas.git",
    });

    const result = await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
    });

    expect(result).toEqual({
      cloneUrl: "https://github.com/Cogni-DAO/atlas.git",
      headSha: "identity-commit",
    });
    expect(requests.map((request) => request.route)).toEqual([
      "POST /repos/{owner}/{repo}/forks",
      "GET /repos/{owner}/{repo}",
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      "PUT /repos/{owner}/{repo}/actions/permissions",
      "PUT /repos/{owner}/{repo}/actions/permissions/workflow",
      "GET /repos/{owner}/{repo}/actions/workflows",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/trees",
      "POST /repos/{owner}/{repo}/git/commits",
      "POST /repos/{owner}/{repo}/git/refs",
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
    ]);
  });

  it("continues when org policy rejects default workflow write permissions", async () => {
    setHappyForkHandlers();
    routeHandlers["PUT /repos/{owner}/{repo}/actions/permissions/workflow"] = (
      params
    ) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "atlas",
        default_workflow_permissions: "write",
        can_approve_pull_request_reviews: false,
      });
      return Promise.reject(
        statusError(409, "Write permissions for workflows are disabled")
      );
    };

    const result = await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
    });

    expect(result).toEqual({
      cloneUrl: "https://github.com/Cogni-DAO/atlas.git",
      headSha: "identity-commit",
    });
    expect(requests.map((request) => request.route)).toContain(
      "POST /repos/{owner}/{repo}/git/commits"
    );
    expect(requests.map((request) => request.route)).toContain(
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}"
    );
  });

  it("reuses an existing fork when GitHub reports template ancestry through source", async () => {
    setHappyForkHandlers();
    routeHandlers["POST /repos/{owner}/{repo}/forks"] = () =>
      Promise.reject(statusError(422, "Repository creation failed"));
    routeHandlers["GET /repos/{owner}/{repo}"] = () => ({
      full_name: "Cogni-DAO/atlas",
      fork: true,
      source: { full_name: "Cogni-DAO/node-template" },
      clone_url: "https://github.com/Cogni-DAO/atlas.git",
    });

    const result = await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
    });

    expect(result).toEqual({
      cloneUrl: "https://github.com/Cogni-DAO/atlas.git",
      headSha: "identity-commit",
    });
  });

  it("reuses an existing fork when GitHub returns owner casing that differs from config", async () => {
    setHappyForkHandlers();
    routeHandlers["POST /repos/{owner}/{repo}/forks"] = () =>
      Promise.reject(statusError(422, "Repository creation failed"));
    routeHandlers["GET /repos/{owner}/{repo}"] = () => ({
      full_name: "Cogni-DAO/atlas",
      fork: true,
      parent: { full_name: "Cogni-DAO/node-template" },
      clone_url: "https://github.com/Cogni-DAO/atlas.git",
    });

    const result = await makeWriter().forkFromTemplate({
      templateOwner: "cogni-dao",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
    });

    expect(result).toEqual({
      cloneUrl: "https://github.com/Cogni-DAO/atlas.git",
      headSha: "identity-commit",
    });
  });
});

describe("GitHubRepoWriter.ensureNodeSubmodulePin", () => {
  it("reuses an existing matching pin PR without moving the branch", async () => {
    const childSha = "0123456789012345678901234567890123456789";
    const branch = "heads/cogni-operator/node-submodule-atlas-pin-01234567";
    routeHandlers = {
      "GET /repos/{owner}/{repo}/git/ref/{ref}": (params) => {
        if (params.ref === "heads/main") {
          return { object: { sha: "parent-main" } };
        }
        expect(params.ref).toBe(branch);
        return { object: { sha: "pin-head" } };
      },
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": (params) => {
        if (params.commit_sha === "parent-main") {
          return { tree: { sha: "main-tree" } };
        }
        expect(params.commit_sha).toBe("pin-head");
        return { tree: { sha: "pin-tree" } };
      },
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": (params) => {
        if (params.tree_sha === "main-tree") {
          return {
            tree: [
              {
                path: "nodes",
                type: "tree",
                mode: "040000",
                sha: "main-nodes",
              },
            ],
          };
        }
        if (params.tree_sha === "main-nodes") {
          return { tree: [] };
        }
        if (params.tree_sha === "pin-tree") {
          return {
            tree: [
              { path: "nodes", type: "tree", mode: "040000", sha: "pin-nodes" },
              {
                path: ".gitmodules",
                type: "blob",
                mode: "100644",
                sha: "pin-gitmodules",
              },
            ],
          };
        }
        expect(params.tree_sha).toBe("pin-nodes");
        return {
          tree: [
            {
              path: "atlas",
              type: "commit",
              mode: "160000",
              sha: childSha,
            },
          ],
        };
      },
      "GET /repos/{owner}/{repo}/git/blobs/{file_sha}": (params) => {
        expect(params.file_sha).toBe("pin-gitmodules");
        return {
          content: Buffer.from(
            `[submodule "nodes/atlas"]\n\tpath = nodes/atlas\n\turl = https://github.com/Cogni-DAO/atlas.git\n`,
            "utf-8"
          ).toString("base64"),
          encoding: "base64",
        };
      },
      "POST /repos/{owner}/{repo}/pulls": () =>
        Promise.reject(statusError(422, "A pull request already exists")),
      "GET /repos/{owner}/{repo}/pulls": (params) => {
        expect(params).toMatchObject({
          owner: "Cogni-DAO",
          repo: "cogni",
          state: "open",
          head: "Cogni-DAO:cogni-operator/node-submodule-atlas-pin-01234567",
        });
        return [
          {
            number: 88,
            html_url: "https://github.com/Cogni-DAO/cogni/pull/88",
          },
        ];
      },
    };

    await expect(
      makeWriter().ensureNodeSubmodulePin({
        owner: "Cogni-DAO",
        repo: "cogni",
        slug: "atlas",
        nodeRepoUrl: "https://github.com/Cogni-DAO/atlas.git",
        nodeRepoHeadSha: childSha,
      })
    ).resolves.toEqual({
      status: "pin_pr_opened",
      currentSha: null,
      prNumber: 88,
      prUrl: "https://github.com/Cogni-DAO/cogni/pull/88",
      parentHeadSha: "pin-head",
    });

    expect(requests.map((request) => request.route)).not.toContain(
      "POST /repos/{owner}/{repo}/git/commits"
    );
    expect(requests.map((request) => request.route)).not.toContain(
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}"
    );
  });
});

describe("GitHubRepoWriter.prepareNodeRefCandidateFlight", () => {
  it("prepares node-ref flights from source repo identity without GHCR metadata", async () => {
    const sourceSha = "0123456789012345678901234567890123456789";
    const nodeId = "11111111-1111-4111-8111-111111111111";
    const encode = (value: string) =>
      Buffer.from(value, "utf-8").toString("base64");
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        if (
          params.owner === "cogni-test-org" &&
          params.repo === "cogni-monorepo" &&
          params.path === "infra/catalog/ghcr.yaml"
        ) {
          return {
            type: "file",
            encoding: "base64",
            content: encode(`name: ghcr
type: node
path_prefix: nodes/ghcr/
source_repo: https://github.com/cogni-test-org/ghcr
image_repository: ghcr.io/cogni-test-org/ghcr
`),
          };
        }
        if (
          params.owner === "cogni-test-org" &&
          params.repo === "ghcr" &&
          params.path === ".cogni/repo-spec.yaml"
        ) {
          expect(params.ref).toBe(sourceSha);
          return {
            type: "file",
            encoding: "base64",
            content: encode(`node_id: "${nodeId}"
cogni_dao:
  chain_id: "8453"
payments_in:
  credits_topup:
    provider: cogni-usdc-backend-v1
    receiving_address: "0x1111111111111111111111111111111111111111"
`),
          };
        }
        throw statusError(404, `not found: ${String(params.path)}`);
      },
      "GET /repos/{owner}/{repo}/commits/{ref}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "ghcr",
          ref: sourceSha,
        });
        return { sha: sourceSha };
      },
      "GET /repos/{owner}/{repo}/git/ref/{ref}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "cogni-monorepo",
          ref: "heads/main",
        });
        return { object: { sha: "parent-main" } };
      },
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "cogni-monorepo",
          commit_sha: "parent-main",
        });
        return { tree: { sha: "parent-tree" } };
      },
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": (params) => {
        if (params.tree_sha === "parent-tree") {
          return {
            tree: [
              {
                path: "nodes",
                type: "tree",
                mode: "040000",
                sha: "nodes-tree",
              },
            ],
          };
        }
        expect(params.tree_sha).toBe("nodes-tree");
        return {
          tree: [
            { path: "ghcr", type: "commit", mode: "160000", sha: sourceSha },
          ],
        };
      },
    };

    await expect(
      makeWriter().prepareNodeRefCandidateFlight({
        parentOwner: "cogni-test-org",
        parentRepo: "cogni-monorepo",
        nodeId,
        slug: "ghcr",
        sourceSha,
      })
    ).resolves.toMatchObject({
      nodeId,
      slug: "ghcr",
      sourceSha,
      sourceRepo: "https://github.com/cogni-test-org/ghcr",
      image: `ghcr.io/cogni-test-org/ghcr:sha-${sourceSha}`,
      parentPin: { status: "already_pinned", currentSha: sourceSha },
    });

    const installUrls = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => String(input));
    expect(
      installUrls.filter(
        (url) =>
          url ===
          "https://api.github.com/repos/cogni-test-org/ghcr/installation"
      )
    ).toHaveLength(2);
    expect(
      installUrls.filter(
        (url) =>
          url ===
          "https://api.github.com/repos/cogni-test-org/cogni-monorepo/installation"
      )
    ).toHaveLength(2);
  });

  it("does not require source repo GHCR package metadata before flight", async () => {
    const sourceSha = "0123456789012345678901234567890123456789";
    const nodeId = "11111111-1111-4111-8111-111111111111";
    const encode = (value: string) =>
      Buffer.from(value, "utf-8").toString("base64");
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        if (params.path === "infra/catalog/ghcr.yaml") {
          return {
            type: "file",
            encoding: "base64",
            content: encode(`name: ghcr
type: node
path_prefix: nodes/ghcr/
source_repo: https://github.com/cogni-test-org/ghcr
image_repository: ghcr.io/cogni-test-org/ghcr
`),
          };
        }
        if (params.path === ".cogni/repo-spec.yaml") {
          return {
            type: "file",
            encoding: "base64",
            content: encode(`node_id: "${nodeId}"
cogni_dao:
  chain_id: "8453"
payments_in:
  credits_topup:
    provider: cogni-usdc-backend-v1
    receiving_address: "0x1111111111111111111111111111111111111111"
`),
          };
        }
        throw statusError(404, `not found: ${String(params.path)}`);
      },
      "GET /repos/{owner}/{repo}/commits/{ref}": () => ({ sha: sourceSha }),
      "GET /repos/{owner}/{repo}/git/ref/{ref}": () => ({
        ref: "refs/heads/main",
        object: { type: "commit", sha: "parent-main" },
      }),
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": () => ({
        sha: "parent-main",
        tree: { sha: "tree-main" },
      }),
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": () => ({
        tree: [
          { path: ".gitmodules", type: "blob", sha: "gitmodules-sha" },
          { path: "nodes", type: "tree", sha: "nodes-tree-sha" },
        ],
      }),
      "GET /repos/{owner}/{repo}/git/blobs/{file_sha}": () => ({
        content: encode(``),
        encoding: "base64",
      }),
      "POST /repos/{owner}/{repo}/git/blobs": () => ({ sha: "blob-sha" }),
      "POST /repos/{owner}/{repo}/git/trees": () => ({ sha: "new-tree" }),
      "POST /repos/{owner}/{repo}/git/commits": () => ({ sha: "new-commit" }),
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}": () => ({}),
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "POST /repos/{owner}/{repo}/pulls": () => ({
        number: 42,
        html_url: "https://github.com/cogni-test-org/cogni-monorepo/pull/42",
      }),
    };

    await expect(
      makeWriter().prepareNodeRefCandidateFlight({
        parentOwner: "cogni-test-org",
        parentRepo: "cogni-monorepo",
        nodeId,
        slug: "ghcr",
        sourceSha,
      })
    ).resolves.toMatchObject({
      nodeId,
      slug: "ghcr",
      sourceSha,
      sourceRepo: "https://github.com/cogni-test-org/ghcr",
      image: `ghcr.io/cogni-test-org/ghcr:sha-${sourceSha}`,
    });

    expect(requests.map((request) => request.route)).toContain(
      "POST /repos/{owner}/{repo}/pulls"
    );
    expect(requests.map((request) => request.route)).not.toContain(
      "GET /orgs/{org}/packages/{package_type}/{package_name}"
    );
    expect(requests.map((request) => request.route)).not.toContain(
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions"
    );
  });

  it("rejects catalogs that point source refs at a different GHCR package", async () => {
    const sourceSha = "0123456789012345678901234567890123456789";
    const nodeId = "11111111-1111-4111-8111-111111111111";
    const encode = (value: string) =>
      Buffer.from(value, "utf-8").toString("base64");
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params.path).toBe("infra/catalog/ghcr.yaml");
        return {
          type: "file",
          encoding: "base64",
          content: encode(`name: ghcr
type: node
path_prefix: nodes/ghcr/
source_repo: https://github.com/cogni-test-org/ghcr
image_repository: ghcr.io/cogni-test-org/other
`),
        };
      },
    };

    await expect(
      makeWriter().prepareNodeRefCandidateFlight({
        parentOwner: "cogni-test-org",
        parentRepo: "cogni-monorepo",
        nodeId,
        slug: "ghcr",
        sourceSha,
      })
    ).rejects.toMatchObject({
      code: "image_repository_mismatch",
      status: 409,
    });

    expect(requests.map((request) => request.route)).not.toContain(
      "GET /repos/{owner}/{repo}/commits/{ref}"
    );
  });
});

describe("GitHubRepoWriter.packageImageTagExists", () => {
  it("probes GHCR tags through GitHub Packages REST with installation auth", async () => {
    routeHandlers = {
      "GET /orgs/{org}/packages/{package_type}/{package_name}": (params) => {
        expect(params).toMatchObject({
          org: "cogni-dao",
          package_type: "container",
          package_name: "creative",
        });
        return { visibility: "public" };
      },
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions": (
        params
      ) => {
        expect(params).toMatchObject({
          org: "cogni-dao",
          package_type: "container",
          package_name: "creative",
          per_page: 100,
        });
        if (params.page === 1) {
          return Array.from({ length: 100 }, () => ({
            metadata: { container: { tags: ["sha-other"] } },
          }));
        }
        return [
          {
            metadata: {
              container: {
                tags: ["sha-0123456789012345678901234567890123456789"],
              },
            },
          },
        ];
      },
    };

    await expect(
      makeWriter().packageImageTagExists({
        owner: "Cogni-DAO",
        repo: "cogni",
        imageRepository: "ghcr.io/cogni-dao/creative",
        tag: "sha-0123456789012345678901234567890123456789",
      })
    ).resolves.toBe(true);

    expect(requests.map((request) => request.route)).toEqual([
      "GET /orgs/{org}/packages/{package_type}/{package_name}",
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions",
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions",
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/Cogni-DAO/cogni/installation",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer app-token",
        }),
      })
    );
  });

  it("fails closed when GitHub Packages denies or hides the image package", async () => {
    routeHandlers = {
      "GET /orgs/{org}/packages/{package_type}/{package_name}": () =>
        Promise.reject(statusError(403, "Resource not accessible")),
    };

    await expect(
      makeWriter().packageImageTagExists({
        owner: "Cogni-DAO",
        repo: "cogni",
        imageRepository: "ghcr.io/cogni-dao/private-node",
        tag: "sha-0123456789012345678901234567890123456789",
      })
    ).resolves.toBe(false);
  });

  it("does not reject readable private GHCR packages", async () => {
    routeHandlers = {
      "GET /orgs/{org}/packages/{package_type}/{package_name}": () => ({
        visibility: "private",
      }),
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions": () => [
        {
          metadata: {
            container: {
              tags: ["sha-0123456789012345678901234567890123456789"],
            },
          },
        },
      ],
    };

    await expect(
      makeWriter().packageImageTagExists({
        owner: "cogni-test-org",
        repo: "ghcr",
        imageRepository: "ghcr.io/cogni-test-org/ghcr",
        tag: "sha-0123456789012345678901234567890123456789",
      })
    ).resolves.toBe(true);

    expect(requests.map((request) => request.route)).toEqual([
      "GET /orgs/{org}/packages/{package_type}/{package_name}",
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions",
    ]);
  });
});
