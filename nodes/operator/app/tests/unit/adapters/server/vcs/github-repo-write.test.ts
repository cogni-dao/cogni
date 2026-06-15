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
      if (content.includes('node_id: "11111111-1111-4111-8111-111111111111"')) {
        return { sha: "repo-spec-blob" };
      }
      if (
        content.includes("kind: ExternalSecret") &&
        content.includes("name: atlas-env-secrets") &&
        /key: (candidate-a|preview|production)\/atlas/.test(content)
      ) {
        return { sha: "external-secret-blob" };
      }
      if (
        content.includes("kind: Kustomization") &&
        content.includes("  - external-secret.yaml")
      ) {
        return { sha: "external-secret-kustomization-blob" };
      }
      throw new Error(`Unexpected blob content: ${content}`);
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
        {
          path: "k8s/external-secrets/candidate-a/external-secret.yaml",
          mode: "100644",
          type: "blob",
          sha: "external-secret-blob",
        },
        {
          path: "k8s/external-secrets/candidate-a/kustomization.yaml",
          mode: "100644",
          type: "blob",
          sha: "external-secret-kustomization-blob",
        },
        {
          path: "k8s/external-secrets/preview/external-secret.yaml",
          mode: "100644",
          type: "blob",
          sha: "external-secret-blob",
        },
        {
          path: "k8s/external-secrets/preview/kustomization.yaml",
          mode: "100644",
          type: "blob",
          sha: "external-secret-kustomization-blob",
        },
        {
          path: "k8s/external-secrets/production/external-secret.yaml",
          mode: "100644",
          type: "blob",
          sha: "external-secret-blob",
        },
        {
          path: "k8s/external-secrets/production/kustomization.yaml",
          mode: "100644",
          type: "blob",
          sha: "external-secret-kustomization-blob",
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
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
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
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
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

describe("GitHubRepoWriter.openNodeSubmodulePr", () => {
  it("authors all birth overlays against the ESO target secret", async () => {
    const encode = (value: string) =>
      Buffer.from(value, "utf-8").toString("base64");
    const blobs = new Map<string, string>();
    let blobId = 0;
    const overlayTemplate = (
      env: string
    ) => `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: cogni-${env}

resources:
  - ../../../base/node-app

namePrefix: node-template-

patches:
  - target:
      kind: Deployment
      name: node-app
    patch: |
      - op: replace
        path: /spec/template/spec/containers/0/envFrom/1/secretRef/name
        value: "node-template-env-secrets"
      - op: replace
        path: /spec/template/spec/initContainers/0/envFrom/1/secretRef/name
        value: "node-template-env-secrets"
      - op: replace
        path: /spec/template/spec/initContainers/0/command/2
        value: exec node /app/app/migrate.mjs /app/app/migrations
      - op: replace
        path: /spec/template/spec/containers/0/ports/0/containerPort
        value: 3200
      - op: add
        path: /spec/template/spec/initContainers/-
        value:
          command:
            - /bin/sh
            - -c
            - exec node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: node-template-env-secrets
                  key: DOLTGRES_URL
  - target:
      kind: Service
      name: node-app
    patch: |
      - op: add
        path: /spec/ports/0/nodePort
        value: 30200
      - op: replace
        path: /spec/ports/0/targetPort
        value: 3200
`;

    routeHandlers = {
      "GET /repos/{owner}/{repo}/git/ref/{ref}": (params) => {
        expect(params).toMatchObject({
          owner: "Cogni-DAO",
          repo: "cogni",
          ref: "heads/main",
        });
        return { object: { sha: "parent-main" } };
      },
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": (params) => {
        expect(params).toMatchObject({
          owner: "Cogni-DAO",
          repo: "cogni",
          commit_sha: "parent-main",
        });
        return { tree: { sha: "parent-tree" } };
      },
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        const path = String(params.path);
        if (path === ".gitmodules") {
          return Promise.reject(statusError(404, "not found"));
        }
        if (path.startsWith("infra/k8s/overlays/")) {
          const env = path.split("/")[3];
          return {
            type: "file",
            encoding: "base64",
            content: encode(overlayTemplate(env ?? "candidate-a")),
          };
        }
        if (path === "scripts/ci/node-applicationset.yaml.tmpl") {
          return {
            type: "file",
            encoding: "base64",
            content: encode("appset __ENV__ __NODE__\n"),
          };
        }
        if (path === "infra/k8s/argocd/kustomization.yaml") {
          return {
            type: "file",
            encoding: "base64",
            content: encode(`resources:
  # >>> GENERATED node-appsets (scripts/ci/render-node-appset.sh) — DO NOT EDIT BY HAND
  - candidate-a-node-template-applicationset.yaml
  - preview-node-template-applicationset.yaml
  - production-node-template-applicationset.yaml
  # <<< GENERATED node-appsets
`),
          };
        }
        if (path === "infra/compose/edge/configs/Caddyfile.tmpl") {
          return {
            type: "file",
            encoding: "base64",
            content:
              encode(`# ── operator (primary domain) → k3s NodePort 30000 ──────────────────────────────────
{$OPERATOR_DOMAIN:localhost} {
  reverse_proxy {$OPERATOR_UPSTREAM:host.docker.internal:30000}
}
`),
          };
        }
        throw statusError(404, `not found: ${path}`);
      },
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": (params) => {
        if (params.tree_sha === "parent-tree") {
          return {
            tree: [{ path: "infra", type: "tree", sha: "infra-tree" }],
          };
        }
        if (params.tree_sha === "infra-tree") {
          return {
            tree: [{ path: "catalog", type: "tree", sha: "catalog-tree" }],
          };
        }
        expect(params.tree_sha).toBe("catalog-tree");
        return {
          tree: [
            {
              path: "node-template.yaml",
              type: "blob",
              sha: "node-template-catalog",
            },
          ],
        };
      },
      "GET /repos/{owner}/{repo}/git/blobs/{file_sha}": (params) => {
        expect(params.file_sha).toBe("node-template-catalog");
        return {
          content: encode(`name: node-template
type: node
node_port: 30200
`),
          encoding: "base64",
        };
      },
      "POST /repos/{owner}/{repo}/git/blobs": (params) => {
        const sha = `blob-${blobId++}`;
        blobs.set(
          sha,
          Buffer.from(String(params.content), "base64").toString("utf-8")
        );
        return { sha };
      },
      "POST /repos/{owner}/{repo}/git/trees": (params) => {
        const tree = params.tree as Array<{
          readonly path: string;
          readonly sha: string;
        }>;
        for (const env of ["candidate-a", "preview", "production"]) {
          const entry = tree.find(
            (item) =>
              item.path === `infra/k8s/overlays/${env}/atlas/kustomization.yaml`
          );
          expect(entry).toBeDefined();
          const content = blobs.get(entry?.sha ?? "");
          expect(content).toContain("atlas-env-secrets");
          expect(content).toContain(`namespace: cogni-${env}`);
          expect(content).toContain("value: 30300");
          expect(content).not.toContain("atlas-node-app-secrets");
        }
        return { sha: "birth-tree" };
      },
      "POST /repos/{owner}/{repo}/git/commits": (params) => {
        expect(params).toMatchObject({
          owner: "Cogni-DAO",
          repo: "cogni",
          message: "feat(node): register atlas",
          tree: "birth-tree",
          parents: ["parent-main"],
        });
        return { sha: "birth-commit" };
      },
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () => ({
        number: 88,
        html_url: "https://github.com/Cogni-DAO/cogni/pull/88",
      }),
    };

    await expect(
      makeWriter().openNodeSubmodulePr({
        owner: "Cogni-DAO",
        repo: "cogni",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        chainId: 8453,
        nodeRepoUrl: "https://github.com/Cogni-DAO/atlas.git",
        nodeRepoHeadSha: "0123456789012345678901234567890123456789",
      })
    ).resolves.toEqual({
      prNumber: 88,
      prUrl: "https://github.com/Cogni-DAO/cogni/pull/88",
    });
  });
});

describe("GitHubRepoWriter.ensureCatalogSourceSha", () => {
  it("opens a catalog source_sha pin PR when the catalog pin differs", async () => {
    const childSha = "0123456789012345678901234567890123456789";
    let putContent = "";
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params.path).toBe("infra/catalog/atlas.yaml");
        // Catalog read on main: existing source_sha differs from the requested pin.
        if (params.ref === "main") {
          return {
            type: "file",
            encoding: "base64",
            sha: "catalog-blob",
            content: Buffer.from(
              "name: atlas\ntype: node\nsource_repo: https://github.com/Cogni-DAO/atlas.git\nimage_repository: ghcr.io/cogni-dao/atlas\nsource_sha: ffffffffffffffffffffffffffffffffffffffff\n",
              "utf-8"
            ).toString("base64"),
          };
        }
        // File lookup on the new pin branch → not present yet.
        return Promise.reject(statusError(404, "not found"));
      },
      "GET /repos/{owner}/{repo}/git/ref/{ref}": (params) => {
        expect(params.ref).toBe("heads/main");
        return { object: { sha: "parent-main" } };
      },
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "PUT /repos/{owner}/{repo}/contents/{path}": (params) => {
        putContent = Buffer.from(String(params.content), "base64").toString(
          "utf-8"
        );
        return { commit: { sha: "pin-commit" } };
      },
      "POST /repos/{owner}/{repo}/pulls": () => ({
        number: 88,
        html_url: "https://github.com/Cogni-DAO/cogni/pull/88",
      }),
    };

    await expect(
      makeWriter().ensureCatalogSourceSha({
        owner: "Cogni-DAO",
        repo: "cogni",
        slug: "atlas",
        nodeRepoUrl: "https://github.com/Cogni-DAO/atlas.git",
        nodeRepoHeadSha: childSha,
      })
    ).resolves.toEqual({
      status: "pin_pr_opened",
      currentSha: "ffffffffffffffffffffffffffffffffffffffff",
      prNumber: 88,
      prUrl: "https://github.com/Cogni-DAO/cogni/pull/88",
      parentHeadSha: "pin-commit",
    });

    // The pin PR rewrites the catalog source_sha to the requested child SHA.
    expect(putContent).toContain(`source_sha: ${childSha}`);
    expect(putContent).not.toContain(
      "ffffffffffffffffffffffffffffffffffffffff"
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
source_sha: ${sourceSha}
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
      "PUT /repos/{owner}/{repo}/contents/{path}": () => ({
        commit: { sha: "pin-commit" },
      }),
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

const DISPATCH_ROUTE =
  "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches";

describe("GitHubRepoWriter.dispatchNodePromote", () => {
  it("dispatches promote-and-deploy with skip_infra=true (APP_PROMOTE_IS_NO_INFRA)", async () => {
    routeHandlers = { [DISPATCH_ROUTE]: () => ({}) };

    const result = await makeWriter().dispatchNodePromote({
      owner: "Cogni-DAO",
      repo: "cogni",
      env: "production",
      slug: "habitat",
    });

    expect(result.dispatched).toBe(true);
    const dispatch = requests.find(
      (request) => request.route === DISPATCH_ROUTE
    );
    expect(dispatch?.params).toMatchObject({
      workflow_id: "promote-and-deploy.yml",
      ref: "main",
      inputs: {
        environment: "production",
        nodes: "habitat",
        skip_infra: "true",
      },
    });
    expect(
      (dispatch?.params.inputs as Record<string, string>).source_sha
    ).toBeUndefined();
  });

  it("forwards source_sha only when provided (catalog-pin nodes omit it)", async () => {
    routeHandlers = { [DISPATCH_ROUTE]: () => ({}) };

    await makeWriter().dispatchNodePromote({
      owner: "Cogni-DAO",
      repo: "cogni",
      env: "production",
      slug: "habitat",
      sourceSha: "abc1230000000000000000000000000000000000",
    });

    const dispatch = requests.find(
      (request) => request.route === DISPATCH_ROUTE
    );
    expect((dispatch?.params.inputs as Record<string, string>).source_sha).toBe(
      "abc1230000000000000000000000000000000000"
    );
    expect((dispatch?.params.inputs as Record<string, string>).skip_infra).toBe(
      "true"
    );
  });
});
