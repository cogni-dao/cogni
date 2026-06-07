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

import { renderRepoSpec } from "@/shared/node-app-scaffold/gens";

interface RequestCall {
  readonly route: string;
  readonly params: Record<string, unknown>;
}

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_SHA = "0123456789012345678901234567890123456789";
const OLD_SOURCE_SHA = "0000000000000000000000000000000000000000";

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

function fileResponse(content: string): {
  readonly type: "file";
  readonly content: string;
  readonly encoding: "base64";
  readonly sha: string;
} {
  return {
    type: "file",
    content: Buffer.from(content, "utf-8").toString("base64"),
    encoding: "base64",
    sha: "file-sha",
  };
}

function catalogYaml(): string {
  return [
    "name: creative",
    "type: node",
    "path_prefix: nodes/creative/",
    "source_repo: https://github.com/Cogni-DAO/creative.git",
    "image_repository: ghcr.io/cogni-dao/creative-node",
    "",
  ].join("\n");
}

function repoSpecYaml(): string {
  return renderRepoSpec({ nodeId: NODE_ID, chainId: 8453 });
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

function installNodeRefPreflightHandlers(options: {
  readonly currentPinSha: string | null;
  readonly existingPinBranchSha?: string | undefined;
}): void {
  const pinBranch = "heads/cogni-operator/node-submodule-creative-pin-01234567";
  routeHandlers = {
    "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
      if (params.path === "infra/catalog/creative.yaml") {
        expect(params).toMatchObject({
          owner: "Cogni-DAO",
          repo: "cogni",
          ref: "main",
        });
        return fileResponse(catalogYaml());
      }
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "creative",
        path: ".cogni/repo-spec.yaml",
        ref: SOURCE_SHA,
      });
      return fileResponse(repoSpecYaml());
    },
    "GET /repos/{owner}/{repo}/commits/{ref}": (params) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "creative",
        ref: SOURCE_SHA,
      });
      return { sha: SOURCE_SHA };
    },
    "GET /orgs/{org}/packages/{package_type}/{package_name}/versions": () => [
      {
        metadata: {
          container: {
            tags: [`sha-${SOURCE_SHA}`],
          },
        },
      },
    ],
    "GET /repos/{owner}/{repo}/git/ref/{ref}": (params) => {
      if (params.ref === "heads/main") {
        return { object: { sha: "parent-main" } };
      }
      expect(params.ref).toBe(pinBranch);
      if (!options.existingPinBranchSha) {
        throw statusError(404, "Not Found");
      }
      return { object: { sha: options.existingPinBranchSha } };
    },
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": (params) => {
      expect(params.commit_sha).toBe("parent-main");
      return { tree: { sha: "main-tree" } };
    },
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": (params) => {
      if (params.tree_sha === "main-tree") {
        return {
          tree: [
            { path: "nodes", type: "tree", mode: "040000", sha: "nodes-tree" },
          ],
        };
      }
      expect(params.tree_sha).toBe("nodes-tree");
      return {
        tree: options.currentPinSha
          ? [
              {
                path: "creative",
                type: "commit",
                mode: "160000",
                sha: options.currentPinSha,
              },
            ]
          : [],
      };
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

describe("GitHubRepoWriter deployment helpers", () => {
  it("combines GitHub Actions check runs and commit statuses into a CI gate", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": (params) => {
        expect(params).toMatchObject({
          owner: "Cogni-DAO",
          repo: "cogni",
          pull_number: 42,
        });
        return {
          number: 42,
          head: { sha: "abc123def456abc123def456abc123def456abc1" },
        };
      },
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": (params) => {
        expect(params.ref).toBe("abc123def456abc123def456abc123def456abc1");
        return {
          check_runs: [
            {
              name: "unit",
              status: "completed",
              conclusion: "success",
              app: { slug: "github-actions" },
            },
            {
              name: "SonarCloud Code Analysis",
              status: "completed",
              conclusion: "failure",
              app: { slug: "sonarcloud" },
            },
          ],
        };
      },
      "GET /repos/{owner}/{repo}/commits/{ref}/status": () => ({
        statuses: [{ context: "external/status", state: "success" }],
      }),
    };

    await expect(
      makeWriter().getCiStatus({
        owner: "Cogni-DAO",
        repo: "cogni",
        prNumber: 42,
      })
    ).resolves.toEqual({
      prNumber: 42,
      headSha: "abc123def456abc123def456abc123def456abc1",
      allGreen: true,
      pending: false,
      checks: [
        {
          name: "unit",
          status: "completed",
          conclusion: "success",
        },
        {
          name: "SonarCloud Code Analysis",
          status: "completed",
          conclusion: "failure",
        },
        {
          name: "external/status",
          status: "completed",
          conclusion: "success",
        },
      ],
    });
  });

  it("dispatches candidate flights with PR and node-ref workflow inputs", async () => {
    routeHandlers = {
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches": (
        params
      ) => {
        expect(params).toMatchObject({
          owner: "Cogni-DAO",
          repo: "cogni",
          workflow_id: "candidate-flight.yml",
          ref: "main",
        });
        return {};
      },
    };

    const writer = makeWriter();

    await expect(
      writer.dispatchCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        prNumber: 42,
        headSha: SOURCE_SHA,
      })
    ).resolves.toMatchObject({
      dispatched: true,
      message: "Flight dispatched for PR #42 @ 01234567.",
    });

    await expect(
      writer.dispatchNodeRefCandidateFlight({
        owner: "Cogni-DAO",
        repo: "cogni",
        slug: "creative",
        sourceSha: SOURCE_SHA,
      })
    ).resolves.toMatchObject({
      dispatched: true,
      message: "Candidate flight dispatched for creative@01234567.",
    });

    expect(requests.map((request) => request.params.inputs)).toEqual([
      { pr_number: "42", head_sha: SOURCE_SHA },
      { node_slug: "creative", source_sha: SOURCE_SHA },
    ]);
  });

  it("preflights a node-ref flight when the parent already pins the source", async () => {
    installNodeRefPreflightHandlers({ currentPinSha: SOURCE_SHA });

    await expect(
      makeWriter().prepareNodeRefCandidateFlight({
        parentOwner: "Cogni-DAO",
        parentRepo: "cogni",
        nodeId: NODE_ID,
        slug: "creative",
        sourceSha: SOURCE_SHA,
      })
    ).resolves.toEqual({
      nodeId: NODE_ID,
      slug: "creative",
      sourceSha: SOURCE_SHA,
      sourceRepo: "https://github.com/Cogni-DAO/creative.git",
      image: `ghcr.io/cogni-dao/creative-node:sha-${SOURCE_SHA}`,
      parentPin: {
        status: "already_pinned",
        currentSha: SOURCE_SHA,
      },
    });
  });

  it("opens a parent pin PR when a node-ref source is not yet pinned", async () => {
    installNodeRefPreflightHandlers({ currentPinSha: OLD_SOURCE_SHA });
    routeHandlers["GET /repos/{owner}/{repo}/contents/{path}"] = (params) => {
      if (params.path === "infra/catalog/creative.yaml") {
        return fileResponse(catalogYaml());
      }
      if (params.path === ".cogni/repo-spec.yaml") {
        return fileResponse(repoSpecYaml());
      }
      expect(params).toMatchObject({
        path: ".gitmodules",
        ref: "main",
      });
      return fileResponse(
        `[submodule "nodes/old"]\n\tpath = nodes/old\n\turl = https://github.com/Cogni-DAO/old.git\n`
      );
    };
    routeHandlers["POST /repos/{owner}/{repo}/git/blobs"] = (params) => {
      const content = Buffer.from(String(params.content), "base64").toString(
        "utf-8"
      );
      expect(content).toContain(`[submodule "nodes/creative"]`);
      return { sha: "gitmodules-blob" };
    };
    routeHandlers["POST /repos/{owner}/{repo}/git/trees"] = (params) => {
      expect(params.tree).toEqual([
        {
          path: "nodes/creative",
          mode: "160000",
          type: "commit",
          sha: SOURCE_SHA,
        },
        {
          path: ".gitmodules",
          mode: "100644",
          type: "blob",
          sha: "gitmodules-blob",
        },
      ]);
      return { sha: "pin-tree" };
    };
    routeHandlers["POST /repos/{owner}/{repo}/git/commits"] = (params) => {
      expect(params).toMatchObject({
        message: "chore(node): pin creative at 01234567",
        tree: "pin-tree",
        parents: ["parent-main"],
      });
      return { sha: "pin-commit" };
    };
    routeHandlers["POST /repos/{owner}/{repo}/git/refs"] = (params) => {
      expect(params).toMatchObject({
        ref: "refs/heads/cogni-operator/node-submodule-creative-pin-01234567",
        sha: "pin-commit",
      });
      return {};
    };
    routeHandlers["POST /repos/{owner}/{repo}/pulls"] = (params) => {
      expect(params).toMatchObject({
        title: "chore(node): pin creative at 01234567",
        head: "cogni-operator/node-submodule-creative-pin-01234567",
        base: "main",
      });
      return {
        number: 77,
        html_url: "https://github.com/Cogni-DAO/cogni/pull/77",
      };
    };

    await expect(
      makeWriter().prepareNodeRefCandidateFlight({
        parentOwner: "Cogni-DAO",
        parentRepo: "cogni",
        nodeId: NODE_ID,
        slug: "creative",
        sourceSha: SOURCE_SHA,
      })
    ).resolves.toMatchObject({
      parentPin: {
        status: "pin_pr_opened",
        currentSha: OLD_SOURCE_SHA,
        prNumber: 77,
        prUrl: "https://github.com/Cogni-DAO/cogni/pull/77",
        parentHeadSha: "pin-commit",
      },
    });
  });
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
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/trees",
      "POST /repos/{owner}/{repo}/git/commits",
      "POST /repos/{owner}/{repo}/git/refs",
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
    ]);
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

describe("GitHubRepoWriter.packageImageTagExists", () => {
  it("probes GHCR tags through GitHub Packages REST with installation auth", async () => {
    routeHandlers = {
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions": (
        params
      ) => {
        expect(params).toMatchObject({
          org: "cogni-dao",
          package_type: "container",
          package_name: "creative-node",
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
        imageRepository: "ghcr.io/cogni-dao/creative-node",
        tag: "sha-0123456789012345678901234567890123456789",
      })
    ).resolves.toBe(true);

    expect(requests.map((request) => request.route)).toEqual([
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
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions": () =>
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
});
