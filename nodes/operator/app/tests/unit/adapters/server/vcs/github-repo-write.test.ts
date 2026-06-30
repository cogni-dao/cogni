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

import {
  GitHubRepoWriter,
  MERGE_QUEUE_RULESET_NAME,
  protectionGetToPutPayload,
  rulesetGetToPutPayload,
} from "@/adapters/server/vcs/github-repo-write";
import {
  renderDistributionActivationSpec,
  renderPaymentsActivationSpec,
} from "@/shared/node-app-scaffold/gens";

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
    // Canonical merge settings (squash-only, auto-merge, delete-on-merge) — applied
    // to the node by ensureCanonicalMergeSettings during forkFromTemplate.
    "PATCH /repos/{owner}/{repo}": () => ({}),
    // Merge-queue replication source lookup. Default: the monorepo has no queue
    // ruleset (admin-opt-in), so replicateMergeQueue finds nothing and skips.
    "GET /repos/{owner}/{repo}/rulesets": () => [],
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

const PAYMENT_PENDING_SPEC = `schema_version: "0.1.4"
node_id: "abc"
scope_id: "def"
scope_key: "default"
intent:
  name: test-cog
  mission: "test payments"
cogni_dao:
  dao_contract: "0xDA0"
  chain_id: "8453"
payments:
  status: pending_activation
`;

const DISTRIBUTION_PENDING_SPEC = `schema_version: "0.1.4"
node_id: "abc"
scope_id: "def"
scope_key: "default"
intent:
  name: test-cog
  mission: "test distributions"
governance:
  dao_contract: "0x1111111111111111111111111111111111111111"
  plugin_contract: "0x2222222222222222222222222222222222222222"
  signal_contract: "0x3333333333333333333333333333333333333333"
  token_contract: "0x4444444444444444444444444444444444444444"
  chain_id: "8453"
distributions:
  status: pending_activation
`;

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  routeHandlers = {};
  installFetchMock();
});

describe("GitHubRepoWriter.openPaymentsActivationPr", () => {
  it("reuses an existing activation PR when its branch already has the desired repo-spec", async () => {
    const nodeWalletAddress = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";
    const splitAddress = "0xec9add7DF66E0481E87C8fB04F22f9813F3B0894";
    const branch = "cogni-operator/activate-payments-test-cog";
    const desiredSpec = renderPaymentsActivationSpec(PAYMENT_PENDING_SPEC, {
      nodeWalletAddress,
      splitAddress,
    });
    const encode = (content: string) =>
      Buffer.from(content, "utf-8").toString("base64");

    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          path: ".cogni/repo-spec.yaml",
        });
        return {
          type: "file",
          encoding: "base64",
          content: encode(
            params.ref === branch ? desiredSpec : PAYMENT_PENDING_SPEC
          ),
          sha: "repo-spec-sha",
        };
      },
      "GET /repos/{owner}/{repo}/pulls": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          state: "open",
          head: `cogni-test-org:${branch}`,
          per_page: 1,
        });
        return [
          {
            number: 11,
            html_url: "https://github.com/cogni-test-org/test-cog/pull/11",
          },
        ];
      },
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          pull_number: 11,
          title: "feat(payments): activate test-cog payment rails",
        });
        return {};
      },
    };

    await expect(
      makeWriter().openPaymentsActivationPr({
        owner: "cogni-test-org",
        repo: "test-cog",
        slug: "test-cog",
        nodeWalletAddress,
        splitAddress,
      })
    ).resolves.toEqual({
      status: "pr_opened",
      prNumber: 11,
      prUrl: "https://github.com/cogni-test-org/test-cog/pull/11",
    });

    expect(requests.map((request) => request.route)).toEqual([
      "GET /repos/{owner}/{repo}/contents/{path}",
      "GET /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/contents/{path}",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
  });

  it("finds an existing activation PR when GitHub's head filter misses it", async () => {
    const nodeWalletAddress = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";
    const splitAddress = "0xec9add7DF66E0481E87C8fB04F22f9813F3B0894";
    const branch = "cogni-operator/activate-payments-test-cog";
    const desiredSpec = renderPaymentsActivationSpec(PAYMENT_PENDING_SPEC, {
      nodeWalletAddress,
      splitAddress,
    });
    const encode = (content: string) =>
      Buffer.from(content, "utf-8").toString("base64");

    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => ({
        type: "file",
        encoding: "base64",
        content: encode(
          params.ref === branch ? desiredSpec : PAYMENT_PENDING_SPEC
        ),
        sha: "repo-spec-sha",
      }),
      "GET /repos/{owner}/{repo}/pulls": (params) => {
        if (params.head !== undefined) return [];
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          state: "open",
          per_page: 100,
        });
        return [
          {
            number: 11,
            html_url: "https://github.com/cogni-test-org/test-cog/pull/11",
            title: "feat(payments): activate test-cog payment rails",
            head: {
              ref: branch,
              repo: { full_name: "cogni-test-org/test-cog" },
            },
          },
        ];
      },
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": () => ({}),
    };

    await expect(
      makeWriter().openPaymentsActivationPr({
        owner: "cogni-test-org",
        repo: "test-cog",
        slug: "test-cog",
        nodeWalletAddress,
        splitAddress,
      })
    ).resolves.toEqual({
      status: "pr_opened",
      prNumber: 11,
      prUrl: "https://github.com/cogni-test-org/test-cog/pull/11",
    });

    expect(requests.map((request) => request.route)).toEqual([
      "GET /repos/{owner}/{repo}/contents/{path}",
      "GET /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/contents/{path}",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
    expect(requests.map((request) => request.route)).not.toContain(
      "POST /repos/{owner}/{repo}/git/commits"
    );
  });

  it("reuses an existing activation PR when its branch is semantically active but not byte-identical", async () => {
    const nodeWalletAddress = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";
    const splitAddress = "0xec9add7DF66E0481E87C8fB04F22f9813F3B0894";
    const branch = "cogni-operator/activate-payments-test-cog";
    const pendingSpec = PAYMENT_PENDING_SPEC;
    const branchSpec = `${PAYMENT_PENDING_SPEC.replace("  status: pending_activation", "  status: active")}

payments_in:
  credits_topup:
    provider: cogni-usdc-backend-v1
    receiving_address: "${splitAddress}"
    allowed_chains:
      - Base
    allowed_tokens:
      - USDC
    markup_factor: 1.10803324099723
    revenue_share: 0

node_wallet:
  address: "${nodeWalletAddress}"
`;
    const renderedFromMain = renderPaymentsActivationSpec(pendingSpec, {
      nodeWalletAddress,
      splitAddress,
    });
    expect(branchSpec).not.toBe(renderedFromMain);
    const encode = (content: string) =>
      Buffer.from(content, "utf-8").toString("base64");

    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => ({
        type: "file",
        encoding: "base64",
        content: encode(params.ref === branch ? branchSpec : pendingSpec),
        sha: "repo-spec-sha",
      }),
      "GET /repos/{owner}/{repo}/pulls": () => [
        {
          number: 11,
          html_url: "https://github.com/cogni-test-org/test-cog/pull/11",
        },
      ],
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": () => ({}),
    };

    await expect(
      makeWriter().openPaymentsActivationPr({
        owner: "cogni-test-org",
        repo: "test-cog",
        slug: "test-cog",
        nodeWalletAddress,
        splitAddress,
      })
    ).resolves.toEqual({
      status: "pr_opened",
      prNumber: 11,
      prUrl: "https://github.com/cogni-test-org/test-cog/pull/11",
    });

    expect(requests.map((request) => request.route)).toEqual([
      "GET /repos/{owner}/{repo}/contents/{path}",
      "GET /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/contents/{path}",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
  });
});

describe("GitHubRepoWriter.openDistributionActivationPr", () => {
  it("returns no_changes when main already has active distribution config", async () => {
    const tokenAddress = "0x4444444444444444444444444444444444444444";
    const emissionsHolderAddress = "0x5555555555555555555555555555555555555555";
    const activeSpec = renderDistributionActivationSpec(
      DISTRIBUTION_PENDING_SPEC,
      {
        tokenAddress,
        emissionsHolderAddress,
      }
    );
    const encode = (content: string) =>
      Buffer.from(content, "utf-8").toString("base64");

    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          path: ".cogni/repo-spec.yaml",
          ref: "main",
        });
        return {
          type: "file",
          encoding: "base64",
          content: encode(activeSpec),
          sha: "repo-spec-sha",
        };
      },
    };

    await expect(
      makeWriter().openDistributionActivationPr({
        owner: "cogni-test-org",
        repo: "test-cog",
        slug: "test-cog",
        tokenAddress,
        emissionsHolderAddress,
      })
    ).resolves.toEqual({ status: "no_changes" });

    expect(requests.map((request) => request.route)).toEqual([
      "GET /repos/{owner}/{repo}/contents/{path}",
    ]);
  });

  it("opens a one-file activation PR from a pending repo-spec", async () => {
    const tokenAddress = "0x4444444444444444444444444444444444444444";
    const emissionsHolderAddress = "0x5555555555555555555555555555555555555555";
    const branch = "cogni-operator/activate-distributions-test-cog";
    const desiredSpec = renderDistributionActivationSpec(
      DISTRIBUTION_PENDING_SPEC,
      {
        tokenAddress,
        emissionsHolderAddress,
      }
    );
    const encode = (content: string) =>
      Buffer.from(content, "utf-8").toString("base64");

    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          path: ".cogni/repo-spec.yaml",
        });
        return {
          type: "file",
          encoding: "base64",
          content: encode(DISTRIBUTION_PENDING_SPEC),
          sha: "repo-spec-sha",
        };
      },
      "GET /repos/{owner}/{repo}/pulls": () => [],
      "GET /repos/{owner}/{repo}/git/ref/{ref}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          ref: "heads/main",
        });
        return { object: { sha: "main-sha" } };
      },
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          commit_sha: "main-sha",
        });
        return { tree: { sha: "main-tree" } };
      },
      "POST /repos/{owner}/{repo}/git/blobs": (params) => {
        const content = Buffer.from(String(params.content), "base64").toString(
          "utf-8"
        );
        expect(content).toBe(desiredSpec);
        return { sha: "repo-spec-blob" };
      },
      "POST /repos/{owner}/{repo}/git/trees": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          base_tree: "main-tree",
        });
        expect(params.tree).toEqual([
          {
            path: ".cogni/repo-spec.yaml",
            mode: "100644",
            type: "blob",
            sha: "repo-spec-blob",
          },
        ]);
        return { sha: "activation-tree" };
      },
      "POST /repos/{owner}/{repo}/git/commits": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          message: "feat(distributions): activate test-cog token distributions",
          tree: "activation-tree",
          parents: ["main-sha"],
        });
        return { sha: "activation-commit" };
      },
      "POST /repos/{owner}/{repo}/git/refs": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          ref: `refs/heads/${branch}`,
          sha: "activation-commit",
        });
        return {};
      },
      "POST /repos/{owner}/{repo}/pulls": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          title: "feat(distributions): activate test-cog token distributions",
          head: branch,
          base: "main",
        });
        return {
          number: 22,
          html_url: "https://github.com/cogni-test-org/test-cog/pull/22",
        };
      },
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          pull_number: 22,
          title: "feat(distributions): activate test-cog token distributions",
        });
        return {};
      },
    };

    await expect(
      makeWriter().openDistributionActivationPr({
        owner: "cogni-test-org",
        repo: "test-cog",
        slug: "test-cog",
        tokenAddress,
        emissionsHolderAddress,
      })
    ).resolves.toEqual({
      status: "pr_opened",
      prNumber: 22,
      prUrl: "https://github.com/cogni-test-org/test-cog/pull/22",
    });

    expect(requests.map((request) => request.route)).toEqual([
      "GET /repos/{owner}/{repo}/contents/{path}",
      "GET /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/pulls",
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/trees",
      "POST /repos/{owner}/{repo}/git/commits",
      "POST /repos/{owner}/{repo}/git/refs",
      "POST /repos/{owner}/{repo}/pulls",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
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

  it("copies the monorepo's branch protection VERBATIM onto the new node repo", async () => {
    setHappyForkHandlers();
    // Source = the deployment monorepo; GET its protection, PUT the same to the node.
    routeHandlers["GET /repos/{owner}/{repo}/branches/{branch}/protection"] = (
      params
    ) => {
      expect(params).toMatchObject({
        owner: "Cogni-DAO",
        repo: "cogni",
        branch: "main",
      });
      return {
        required_status_checks: {
          strict: false,
          contexts: ["unit", "component", "static", "manifest"],
        },
        enforce_admins: { enabled: false },
        required_pull_request_reviews: null,
        restrictions: null,
        required_linear_history: { enabled: false },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_conversation_resolution: { enabled: false },
        lock_branch: { enabled: false },
        allow_fork_syncing: { enabled: false },
      };
    };
    let putParams: Record<string, unknown> | undefined;
    routeHandlers["PUT /repos/{owner}/{repo}/branches/{branch}/protection"] = (
      params
    ) => {
      putParams = params;
      return {};
    };

    await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
      protectionSourceOwner: "Cogni-DAO",
      protectionSourceRepo: "cogni",
    });

    // The node's main gets the EXACT monorepo required set + flags (no node-invented policy).
    expect(putParams).toMatchObject({
      owner: "Cogni-DAO",
      repo: "atlas",
      branch: "main",
      required_status_checks: {
        strict: false,
        contexts: ["unit", "component", "static", "manifest"],
      },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
    });
  });

  it("replicates the monorepo's merge_queue ruleset onto the node when present", async () => {
    setHappyForkHandlers();
    routeHandlers["GET /repos/{owner}/{repo}/branches/{branch}/protection"] =
      () => ({
        required_status_checks: { strict: false, contexts: ["unit"] },
        enforce_admins: { enabled: false },
        required_pull_request_reviews: null,
      });
    routeHandlers["PUT /repos/{owner}/{repo}/branches/{branch}/protection"] =
      () => ({});
    // Source (monorepo) HAS the queue ruleset; target (node) has none → POST.
    routeHandlers["GET /repos/{owner}/{repo}/rulesets"] = (params) =>
      params.repo === "cogni" ? [{ id: 77, name: "main-merge-queue" }] : [];
    routeHandlers["GET /repos/{owner}/{repo}/rulesets/{ruleset_id}"] = () => ({
      name: "main-merge-queue",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "merge_queue", parameters: { merge_method: "SQUASH" } }],
    });
    routeHandlers["POST /repos/{owner}/{repo}/rulesets"] = () => ({ id: 99 });

    await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
      protectionSourceOwner: "Cogni-DAO",
      protectionSourceRepo: "cogni",
    });

    // The node got canonical repo settings (auto-merge ON, NOT a template) + the
    // queue ruleset POSTed.
    const patch = requests.find(
      (r) => r.route === "PATCH /repos/{owner}/{repo}"
    );
    expect(patch?.params).toMatchObject({
      owner: "Cogni-DAO",
      repo: "atlas",
      allow_auto_merge: true,
      allow_squash_merge: true,
      is_template: false,
    });
    const post = requests.find(
      (r) => r.route === "POST /repos/{owner}/{repo}/rulesets"
    );
    expect(post?.params).toMatchObject({
      owner: "Cogni-DAO",
      repo: "atlas",
      name: "main-merge-queue",
      enforcement: "active",
    });
  });

  it("does NOT fail formation when the node repo cannot carry a merge queue (422/403)", async () => {
    // QUEUE_IS_BEST_EFFORT: the merge_queue ruleset is org/Team-only — a personal-account
    // node 422s. The queue is an enhancement (branch protection is the backstop), so
    // formation must still succeed; the node is born queue-less.
    setHappyForkHandlers();
    routeHandlers["GET /repos/{owner}/{repo}/branches/{branch}/protection"] =
      () => ({
        required_status_checks: { strict: false, contexts: ["unit"] },
        enforce_admins: { enabled: false },
        required_pull_request_reviews: null,
      });
    routeHandlers["PUT /repos/{owner}/{repo}/branches/{branch}/protection"] =
      () => ({});
    routeHandlers["GET /repos/{owner}/{repo}/rulesets"] = (params) =>
      params.repo === "cogni" ? [{ id: 77, name: "main-merge-queue" }] : [];
    routeHandlers["GET /repos/{owner}/{repo}/rulesets/{ruleset_id}"] = () => ({
      name: "main-merge-queue",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "merge_queue", parameters: { merge_method: "SQUASH" } }],
    });
    routeHandlers["POST /repos/{owner}/{repo}/rulesets"] = () =>
      Promise.reject(
        statusError(422, "Invalid rule 'merge_queue': unsupported on this plan")
      );

    // Resolves (no throw) despite the queue write failing.
    const result = await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
      protectionSourceOwner: "Cogni-DAO",
      protectionSourceRepo: "cogni",
    });
    expect(result.headSha).toBeTruthy();
  });

  it("fails loud when the monorepo source is unprotected (404)", async () => {
    setHappyForkHandlers();
    routeHandlers["GET /repos/{owner}/{repo}/branches/{branch}/protection"] =
      () => Promise.reject(statusError(404, "Branch not protected"));

    await expect(
      makeWriter().forkFromTemplate({
        templateOwner: "Cogni-DAO",
        owner: "Cogni-DAO",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        chainId: 8453,
        protectionSourceOwner: "Cogni-DAO",
        protectionSourceRepo: "cogni",
      })
    ).rejects.toThrow(/unprotected/i);
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
        // PER-ENV appsets kustomization: appsets/<env>/kustomization.yaml lists ONLY that
        // env's nodes (full <env>- filename prefix kept, file nested under <env>/).
        const appsetsEnv = path.match(
          /^infra\/k8s\/argocd\/appsets\/([^/]+)\/kustomization\.yaml$/
        )?.[1];
        if (appsetsEnv !== undefined) {
          return {
            type: "file",
            encoding: "base64",
            content: encode(`apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: argocd

resources:
  - ${appsetsEnv}-node-template-applicationset.yaml
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

          // PER-ENV AppSet lands under appsets/<env>/<env>-atlas-applicationset.yaml.
          const appsetEntry = tree.find(
            (item) =>
              item.path ===
              `infra/k8s/argocd/appsets/${env}/${env}-atlas-applicationset.yaml`
          );
          expect(appsetEntry).toBeDefined();
          expect(blobs.get(appsetEntry?.sha ?? "")).toBe(
            `appset ${env} atlas\n`
          );

          // The slug folds into THAT env's own appsets/<env>/kustomization.yaml only.
          const kustEntry = tree.find(
            (item) =>
              item.path === `infra/k8s/argocd/appsets/${env}/kustomization.yaml`
          );
          expect(kustEntry).toBeDefined();
          const kust = blobs.get(kustEntry?.sha ?? "");
          expect(kust).toContain(`${env}-atlas-applicationset.yaml`);
          expect(kust).toContain(`${env}-node-template-applicationset.yaml`);
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

describe("GitHubRepoWriter.promoteNode (env=preview)", () => {
  const DISPATCH =
    "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches";
  const childSha = "0123456789012345678901234567890123456789";
  const staleCatalog =
    "name: habitat\ntype: node\npath_prefix: nodes/ghcr/\nsource_repo: https://github.com/Cogni-DAO/habitat.git\nimage_repository: ghcr.io/cogni-dao/habitat\nsource_sha: ffffffffffffffffffffffffffffffffffffffff\n";

  it("source-addresses the node sha on the preview dispatch — ZERO writes to main, no PR (task.5022 Design A)", async () => {
    routeHandlers = {
      // Catalog row is read only to validate existence/identity — never written.
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params.path).toBe("infra/catalog/habitat.yaml");
        expect(params.ref).toBe("main");
        return {
          type: "file",
          encoding: "base64",
          sha: "catalog-blob",
          content: Buffer.from(staleCatalog, "utf-8").toString("base64"),
        };
      },
      [DISPATCH]: () => ({}),
    };

    const result = await makeWriter().promoteNode({
      env: "preview",
      parentOwner: "Cogni-DAO",
      parentRepo: "cogni",
      slug: "habitat",
      sourceSha: childSha,
    });

    expect(result).toMatchObject({
      status: "dispatched",
      env: "preview",
      sourceSha: childSha,
      sourceAddressing: "remote_source",
    });

    // The dispatch carries the node sha as node_source_sha; ref stays main (the
    // operator WORKFLOW checkout ref, not a deploy pin). No source_sha override.
    const dispatch = requests.find((request) => request.route === DISPATCH);
    expect(dispatch?.params).toMatchObject({
      workflow_id: "promote-and-deploy.yml",
      ref: "main",
      inputs: {
        environment: "preview",
        nodes: "habitat",
        skip_infra: "true",
        node_source_sha: childSha,
      },
    });
    expect(
      (dispatch?.params.inputs as Record<string, string>).source_sha
    ).toBeUndefined();

    // ZERO writes to main: no catalog PUT, no PR.
    expect(
      requests.some(
        (r) => r.route === "PUT /repos/{owner}/{repo}/contents/{path}"
      )
    ).toBe(false);
    expect(
      requests.some((r) => r.route === "POST /repos/{owner}/{repo}/pulls")
    ).toBe(false);
  });

  it("rejects a missing catalog row (404 catalog_missing) without dispatching", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": () => {
        const err = new Error("Not Found") as Error & { status: number };
        err.status = 404;
        throw err;
      },
      [DISPATCH]: () => ({}),
    };

    await expect(
      makeWriter().promoteNode({
        env: "preview",
        parentOwner: "Cogni-DAO",
        parentRepo: "cogni",
        slug: "habitat",
        sourceSha: childSha,
      })
    ).rejects.toThrow(/catalog/i);

    expect(requests.some((r) => r.route === DISPATCH)).toBe(false);
  });
});

describe("GitHubRepoWriter.promoteNode (env=production)", () => {
  const DISPATCH =
    "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches";
  const childSha = "0123456789012345678901234567890123456789";
  // REMOTE-SOURCE (fork) catalog: has source_repo + a stale source_sha pin.
  const forkCatalog =
    "name: beacon\ntype: node\npath_prefix: nodes/beacon/\nsource_repo: https://github.com/cogni-dao/beacon.git\nimage_repository: ghcr.io/cogni-dao/beacon\nsource_sha: ffffffffffffffffffffffffffffffffffffffff\n";
  // IN-REPO catalog: NO source_repo (operator/poly shape).
  const inRepoCatalog =
    "name: operator\ntype: node\npath_prefix: nodes/operator/\ndockerfile: nodes/operator/app/Dockerfile\n";

  it("source-addresses node_source_sha for a REMOTE-SOURCE (fork) node — no stale catalog pin, no source_sha (bug.5043)", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params.path).toBe("infra/catalog/beacon.yaml");
        expect(params.ref).toBe("main");
        return {
          type: "file",
          encoding: "base64",
          sha: "catalog-blob",
          content: Buffer.from(forkCatalog, "utf-8").toString("base64"),
        };
      },
      [DISPATCH]: () => ({}),
    };

    const result = await makeWriter().promoteNode({
      env: "production",
      parentOwner: "Cogni-DAO",
      parentRepo: "cogni",
      slug: "beacon",
      sourceSha: childSha,
    });

    expect(result).toMatchObject({
      status: "dispatched",
      env: "production",
      sourceSha: childSha,
      sourceAddressing: "remote_source",
    });

    const dispatch = requests.find((request) => request.route === DISPATCH);
    expect(dispatch?.params).toMatchObject({
      workflow_id: "promote-and-deploy.yml",
      ref: "main",
      inputs: {
        environment: "production",
        nodes: "beacon",
        skip_infra: "true",
        node_source_sha: childSha,
      },
    });
    // No source_sha override: the caller sha is the node image, not the checkout ref.
    expect(
      (dispatch?.params.inputs as Record<string, string>).source_sha
    ).toBeUndefined();
    // ZERO writes to main.
    expect(
      requests.some(
        (r) => r.route === "PUT /repos/{owner}/{repo}/contents/{path}"
      )
    ).toBe(false);
  });

  it("passes source_sha (checkout ref) for an IN-REPO node — no node_source_sha, behavior unchanged", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params.path).toBe("infra/catalog/operator.yaml");
        return {
          type: "file",
          encoding: "base64",
          sha: "catalog-blob",
          content: Buffer.from(inRepoCatalog, "utf-8").toString("base64"),
        };
      },
      [DISPATCH]: () => ({}),
    };

    const result = await makeWriter().promoteNode({
      env: "production",
      parentOwner: "Cogni-DAO",
      parentRepo: "cogni",
      slug: "operator",
      sourceSha: childSha,
    });

    expect(result).toMatchObject({
      status: "dispatched",
      env: "production",
      sourceSha: childSha,
      sourceAddressing: "in_repo",
    });

    const dispatch = requests.find((request) => request.route === DISPATCH);
    expect((dispatch?.params.inputs as Record<string, string>).source_sha).toBe(
      childSha
    );
    expect(
      (dispatch?.params.inputs as Record<string, string>).node_source_sha
    ).toBeUndefined();
  });

  it("rejects a missing catalog row (404) without dispatching", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": () => {
        const err = new Error("Not Found") as Error & { status: number };
        err.status = 404;
        throw err;
      },
      [DISPATCH]: () => ({}),
    };

    await expect(
      makeWriter().promoteNode({
        env: "production",
        parentOwner: "Cogni-DAO",
        parentRepo: "cogni",
        slug: "beacon",
        sourceSha: childSha,
      })
    ).rejects.toThrow(/catalog/i);

    expect(requests.some((r) => r.route === DISPATCH)).toBe(false);
  });
});

describe("GitHubRepoWriter.resolveNodeRepo", () => {
  // IN-REPO catalog: NO source_repo (operator/poly shape).
  const inRepoCatalog =
    "name: operator\ntype: node\npath_prefix: nodes/operator/\ndockerfile: nodes/operator/app/Dockerfile\n";
  // REMOTE-SOURCE (fork) catalog: has source_repo.
  const forkCatalog =
    "name: beacon\ntype: node\npath_prefix: nodes/beacon/\nsource_repo: https://github.com/cogni-dao/beacon.git\nimage_repository: ghcr.io/cogni-dao/beacon\n";

  function catalogHandler(yaml: string) {
    return {
      "GET /repos/{owner}/{repo}/contents/{path}": () => ({
        type: "file" as const,
        encoding: "base64" as const,
        sha: "catalog-blob",
        content: Buffer.from(yaml, "utf-8").toString("base64"),
      }),
    };
  }

  it("IN-REPO node (operator, no source_repo) resolves to the parent monorepo — not catalog_missing", async () => {
    routeHandlers = catalogHandler(inRepoCatalog);
    const repo = await makeWriter().resolveNodeRepo({
      parentOwner: "Cogni-DAO",
      parentRepo: "cogni",
      slug: "operator",
    });
    expect(repo).toEqual({ owner: "Cogni-DAO", repo: "cogni" });
  });

  it("REMOTE-SOURCE node resolves to its own source_repo", async () => {
    routeHandlers = catalogHandler(forkCatalog);
    const repo = await makeWriter().resolveNodeRepo({
      parentOwner: "Cogni-DAO",
      parentRepo: "cogni",
      slug: "beacon",
    });
    expect(repo).toEqual({ owner: "cogni-dao", repo: "beacon" });
  });

  it("throws catalog_missing (404) for a genuinely absent catalog row", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": () => {
        const err = new Error("Not Found") as Error & { status: number };
        err.status = 404;
        throw err;
      },
    };
    await expect(
      makeWriter().resolveNodeRepo({
        parentOwner: "Cogni-DAO",
        parentRepo: "cogni",
        slug: "ghost",
      })
    ).rejects.toMatchObject({ code: "catalog_missing" });
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
governance:
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
    // Parent is authenticated once — for the catalog read. The flight is
    // source-addressed and opens no catalog pin PR, so there is no second
    // parent-authenticated write path (task.5022).
    expect(
      installUrls.filter(
        (url) =>
          url ===
          "https://api.github.com/repos/cogni-test-org/cogni-monorepo/installation"
      )
    ).toHaveLength(1);
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
governance:
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

    // Source-addressed flight opens NO catalog pin PR on `main` (task.5022); the
    // deploy pin rides the dispatch, never a parent code-branch PR.
    expect(requests.map((request) => request.route)).not.toContain(
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
    // Production omits BOTH addressing inputs ⇒ the workflow reads the catalog
    // source_sha pin (CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN) — Design A is additive,
    // production behavior unchanged.
    expect(
      (dispatch?.params.inputs as Record<string, string>).source_sha
    ).toBeUndefined();
    expect(
      (dispatch?.params.inputs as Record<string, string>).node_source_sha
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

  it("forwards node_source_sha when provided (source-addressed preview promote)", async () => {
    routeHandlers = { [DISPATCH_ROUTE]: () => ({}) };

    await makeWriter().dispatchNodePromote({
      owner: "Cogni-DAO",
      repo: "cogni",
      env: "preview",
      slug: "habitat",
      nodeSourceSha: "def4560000000000000000000000000000000000",
    });

    const dispatch = requests.find(
      (request) => request.route === DISPATCH_ROUTE
    );
    expect(
      (dispatch?.params.inputs as Record<string, string>).node_source_sha
    ).toBe("def4560000000000000000000000000000000000");
    // node_source_sha is NOT a checkout ref — source_sha stays absent (ref=main).
    expect(
      (dispatch?.params.inputs as Record<string, string>).source_sha
    ).toBeUndefined();
  });
});

describe("GitHubRepoWriter.syncCanonicalFilesToFork", () => {
  const SOURCE_SHA = "abcdef1234567890abcdef1234567890abcdef12";
  const BRANCH = "cogni-operator/node-template-sync";
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
  const fileBlob = (content: string) => ({
    type: "file" as const,
    encoding: "base64" as const,
    content: b64(content),
  });

  // Dispatch one shared `GET .../contents/{path}` handler by repo (source vs fork) + path.
  function contentsHandler(
    source: Record<string, string>,
    fork: Record<string, string | null>
  ): RouteHandler {
    return (params) => {
      const repo = String(params.repo);
      const path = String(params.path);
      const table = repo === "node-template" ? source : fork;
      const content = table[path];
      if (content === undefined || content === null) {
        throw statusError(404, `not found: ${repo}/${path}`);
      }
      return fileBlob(content);
    };
  }

  function syncInput() {
    return {
      sourceOwner: "Cogni-DAO",
      sourceRepo: "node-template",
      sourceRef: SOURCE_SHA,
      targetOwner: "cogni-test-org",
      targetRepo: "test-cog",
      slug: "test-cog",
      canonicalPaths: [
        ".github/workflows/ci.yaml",
        ".github/workflows/pr-build.yml",
        ".github/workflows/pr-lint.yaml",
      ],
    };
  }

  it("returns no_changes (no tree/commit/PR) when every canonical file is byte-identical", async () => {
    const identical = {
      ".github/workflows/ci.yaml": "CI\n",
      ".github/workflows/pr-build.yml": "BUILD\n",
      ".github/workflows/pr-lint.yaml": "LINT\n",
    };
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": contentsHandler(
        identical,
        identical
      ),
    };

    const result = await makeWriter().syncCanonicalFilesToFork(syncInput());

    expect(result).toEqual({
      status: "no_changes",
      branch: BRANCH,
      changedPaths: [],
    });
    const routes = requests.map((r) => r.route);
    expect(routes).not.toContain("POST /repos/{owner}/{repo}/git/trees");
    expect(routes).not.toContain("POST /repos/{owner}/{repo}/pulls");
  });

  it("commits only changed/missing files as one tree and opens one PR on the stable branch", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": contentsHandler(
        {
          ".github/workflows/ci.yaml": "CI-NEW\n",
          ".github/workflows/pr-build.yml": "BUILD\n",
          ".github/workflows/pr-lint.yaml": "LINT\n",
        },
        {
          ".github/workflows/ci.yaml": "CI-OLD\n", // differs → changed
          ".github/workflows/pr-build.yml": null, // missing on fork → changed
          ".github/workflows/pr-lint.yaml": "LINT\n", // identical → skipped
        }
      ),
      "POST /repos/{owner}/{repo}/git/blobs": (params) => {
        const content = Buffer.from(String(params.content), "base64").toString(
          "utf-8"
        );
        if (content === "CI-NEW\n") return { sha: "blob-ci" };
        if (content === "BUILD\n") return { sha: "blob-build" };
        throw new Error(`Unexpected blob content: ${content}`);
      },
      "GET /repos/{owner}/{repo}/git/ref/{ref}": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          ref: "heads/main",
        });
        return { object: { sha: "fork-main" } };
      },
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": (params) => {
        expect(params).toMatchObject({ commit_sha: "fork-main" });
        return { tree: { sha: "fork-tree" } };
      },
      "POST /repos/{owner}/{repo}/git/trees": (params) => {
        expect(params).toMatchObject({
          owner: "cogni-test-org",
          repo: "test-cog",
          base_tree: "fork-tree",
        });
        expect(params.tree).toEqual([
          {
            path: ".github/workflows/ci.yaml",
            mode: "100644",
            type: "blob",
            sha: "blob-ci",
          },
          {
            path: ".github/workflows/pr-build.yml",
            mode: "100644",
            type: "blob",
            sha: "blob-build",
          },
        ]);
        return { sha: "mirror-tree" };
      },
      "POST /repos/{owner}/{repo}/git/commits": (params) => {
        expect(params).toMatchObject({
          tree: "mirror-tree",
          parents: ["fork-main"],
        });
        return { sha: "mirror-commit" };
      },
      "POST /repos/{owner}/{repo}/git/refs": (params) => {
        expect(params).toMatchObject({
          ref: `refs/heads/${BRANCH}`,
          sha: "mirror-commit",
        });
        return {};
      },
      "POST /repos/{owner}/{repo}/pulls": (params) => {
        expect(params).toMatchObject({ head: BRANCH, base: "main" });
        // Stable, commitlint-standard title (no SHA); the SHA lives in the body.
        expect(String(params.title)).toBe(
          "chore: sync CI + contract files from node-template"
        );
        expect(String(params.body)).toContain("abcdef12");
        return {
          number: 7,
          html_url: "https://github.com/cogni-test-org/test-cog/pull/7",
        };
      },
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": (params) => {
        expect(params).toMatchObject({ pull_number: 7 });
        return {};
      },
    };

    const result = await makeWriter().syncCanonicalFilesToFork(syncInput());

    expect(result).toEqual({
      status: "pr_opened",
      branch: BRANCH,
      prNumber: 7,
      prUrl: "https://github.com/cogni-test-org/test-cog/pull/7",
      changedPaths: [
        ".github/workflows/ci.yaml",
        ".github/workflows/pr-build.yml",
      ],
    });
  });

  it("reuses an existing open PR for the stable branch instead of opening a second", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": contentsHandler(
        { ".github/workflows/ci.yaml": "CI-NEW\n" },
        { ".github/workflows/ci.yaml": "CI-OLD\n" }
      ),
      "POST /repos/{owner}/{repo}/git/blobs": () => ({ sha: "blob-ci" }),
      "GET /repos/{owner}/{repo}/git/ref/{ref}": () => ({
        object: { sha: "fork-main" },
      }),
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": () => ({
        tree: { sha: "fork-tree" },
      }),
      "POST /repos/{owner}/{repo}/git/trees": () => ({ sha: "mirror-tree" }),
      "POST /repos/{owner}/{repo}/git/commits": () => ({
        sha: "mirror-commit",
      }),
      "POST /repos/{owner}/{repo}/git/refs": () =>
        Promise.reject(statusError(422, "Reference already exists")),
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () =>
        Promise.reject(statusError(422, "A pull request already exists")),
      "GET /repos/{owner}/{repo}/pulls": (params) => {
        expect(params).toMatchObject({
          state: "open",
          head: `cogni-test-org:${BRANCH}`,
        });
        return [
          {
            number: 9,
            html_url: "https://github.com/cogni-test-org/test-cog/pull/9",
          },
        ];
      },
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": (params) => {
        expect(params).toMatchObject({ pull_number: 9 });
        return {};
      },
    };

    const result = await makeWriter().syncCanonicalFilesToFork({
      ...syncInput(),
      canonicalPaths: [".github/workflows/ci.yaml"],
    });

    expect(result).toMatchObject({
      status: "pr_opened",
      branch: BRANCH,
      prNumber: 9,
    });
  });
});

describe("GitHubRepoWriter.syncTemplateUpstreamToFork", () => {
  const UPSTREAM_BRANCH = "cogni-operator/node-template-upstream";
  const SHA = "1234567890123456789012345678901234567890";
  const upstreamInput = () => ({
    templateOwner: "Cogni-DAO",
    templateRepo: "node-template",
    templateSha: SHA,
    forkOwner: "cogni-test-org",
    forkRepo: "blue",
    forkBranch: "main",
  });

  // Mock the tree-walk buildUpstreamMergeCommit performs: fork tip → fork tree, upstream tip → upstream tree.
  const treeWalk = (
    forkTree: Array<{ path: string; sha: string; mode?: string }>,
    upstreamTree: Array<{ path: string; sha: string; mode?: string }>
  ) => ({
    "GET /repos/{owner}/{repo}/git/ref/{ref}": (params: { ref: string }) => {
      expect(params.ref).toBe("heads/main");
      return { object: { sha: "fork-main-commit" } };
    },
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": (params: {
      commit_sha: string;
    }) =>
      params.commit_sha === "fork-main-commit"
        ? { tree: { sha: "fork-tree" } }
        : { tree: { sha: "upstream-tree" } },
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": (params: {
      tree_sha: string;
      recursive: string;
    }) => {
      expect(params.recursive).toBe("1");
      const src = params.tree_sha === "fork-tree" ? forkTree : upstreamTree;
      return {
        tree: src.map((e) => ({
          ...e,
          mode: e.mode ?? "100644",
          type: "blob",
        })),
      };
    },
  });

  it("node-template wins Tier-2: overlays differing shared blobs (mode preserved), force-updates the branch, refreshes the PR changelog", async () => {
    let treeEntries: Array<{ path: string; mode: string; sha: string }> = [];
    routeHandlers = {
      ...treeWalk(
        [{ path: "app/src/app/api/x/route.ts", sha: "fork-x" }],
        [
          // shared file the fork drifted on → node-template wins
          { path: "app/src/app/api/x/route.ts", sha: "tmpl-x" },
          // new executable script → overlaid with its mode preserved
          { path: "scripts/provision.sh", sha: "tmpl-prov", mode: "100755" },
        ]
      ),
      "POST /repos/{owner}/{repo}/git/trees": (params) => {
        // Base is the FORK tree (fork-unique files ride along), overlay is node-template's.
        expect(params.base_tree).toBe("fork-tree");
        treeEntries = params.tree as typeof treeEntries;
        return { sha: "merged-tree" };
      },
      "POST /repos/{owner}/{repo}/git/commits": (params) => {
        // Parented on BOTH fork tip + template → branch is a descendant of fork main (always mergeable).
        expect(params).toMatchObject({
          tree: "merged-tree",
          parents: ["fork-main-commit", SHA],
        });
        return { sha: "merge-commit" };
      },
      "POST /repos/{owner}/{repo}/git/refs": () =>
        Promise.reject(statusError(422, "Reference already exists")),
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}": (params) => {
        expect(params).toMatchObject({
          ref: `heads/${UPSTREAM_BRANCH}`,
          sha: "merge-commit",
          force: true,
        });
        return {};
      },
      "POST /repos/{owner}/{repo}/pulls": (params) => {
        expect(params).toMatchObject({ head: UPSTREAM_BRANCH, base: "main" });
        expect(String(params.title)).toBe(
          "chore: merge node-template upstream"
        );
        return {
          number: 5,
          html_url: "https://github.com/cogni-test-org/blue/pull/5",
        };
      },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": (params) => {
        expect(params).toMatchObject({ pull_number: 5 });
        return [
          { commit: { message: "feat(graphs): add poet graph\n\ndetail" } },
          { commit: { message: "fix(app): header crash" } },
        ];
      },
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": (params) => {
        expect(params).toMatchObject({ pull_number: 5 });
        const body = String(params.body);
        expect(body).toContain("- feat(graphs): add poet graph");
        expect(body).toContain("- fix(app): header crash");
        expect(body).not.toContain("detail"); // first line only
        return {};
      },
    };

    const result = await makeWriter().syncTemplateUpstreamToFork(
      upstreamInput()
    );
    expect(result).toMatchObject({
      status: "pr_opened",
      prNumber: 5,
      prUrl: "https://github.com/cogni-test-org/blue/pull/5",
    });
    expect(treeEntries).toEqual(
      expect.arrayContaining([
        {
          path: "app/src/app/api/x/route.ts",
          mode: "100644",
          type: "blob",
          sha: "tmpl-x",
        },
        // mode 100755 preserved — overlaid scripts stay executable.
        {
          path: "scripts/provision.sh",
          mode: "100755",
          type: "blob",
          sha: "tmpl-prov",
        },
      ])
    );
  });

  it("Tier-3 + fork-unique files are preserved (never overlaid), and the PR is built on the fork tip", async () => {
    let treeEntries: Array<{ path: string; sha: string }> = [];
    routeHandlers = {
      ...treeWalk(
        [
          { path: "app/src/adapters/onchain.ts", sha: "fork-onchain" }, // shared, drifted
          { path: "app/src/app/(public)/page.tsx", sha: "fork-home" }, // node_local
          { path: "app/src/features/fork-only.ts", sha: "fork-only" }, // fork-unique
        ],
        [
          { path: "app/src/adapters/onchain.ts", sha: "tmpl-onchain" }, // → node-template wins
          { path: "app/src/app/(public)/page.tsx", sha: "tmpl-home" }, // node_local → skipped
        ]
      ),
      "POST /repos/{owner}/{repo}/git/trees": (params) => {
        expect(params.base_tree).toBe("fork-tree");
        treeEntries = params.tree as typeof treeEntries;
        return { sha: "merged-tree" };
      },
      "POST /repos/{owner}/{repo}/git/commits": () => ({ sha: "merge-commit" }),
      "POST /repos/{owner}/{repo}/git/refs": () =>
        Promise.reject(statusError(422, "Reference already exists")),
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () => ({
        number: 7,
        html_url: "https://github.com/cogni-test-org/blue/pull/7",
      }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": () => [],
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": () => ({}),
    };

    const result = await makeWriter().syncTemplateUpstreamToFork({
      ...upstreamInput(),
      nodeLocalPaths: ["app/src/app/(public)/**"],
    });

    expect(result).toMatchObject({ status: "pr_opened", prNumber: 7 });
    // Only the drifted shared file is overlaid with node-template's blob.
    expect(treeEntries).toEqual([
      {
        path: "app/src/adapters/onchain.ts",
        mode: "100644",
        type: "blob",
        sha: "tmpl-onchain",
      },
    ]);
    // node_local (page.tsx) and fork-unique (fork-only.ts) never appear in the overlay.
    expect(treeEntries.some((e) => e.path.endsWith("page.tsx"))).toBe(false);
    expect(treeEntries.some((e) => e.path.endsWith("fork-only.ts"))).toBe(
      false
    );
  });

  it("returns up_to_date when no Tier-2 path differs (no merge commit, no PR)", async () => {
    routeHandlers = {
      ...treeWalk(
        [{ path: "app/src/app/api/x/route.ts", sha: "same" }],
        [{ path: "app/src/app/api/x/route.ts", sha: "same" }]
      ),
      // entries empty → branch points at fork tip → PR open no-ops (no commits).
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () =>
        Promise.reject(statusError(422, "No commits between main and main")),
      "GET /repos/{owner}/{repo}/pulls": () => [],
    };
    const result = await makeWriter().syncTemplateUpstreamToFork(
      upstreamInput()
    );
    expect(result).toEqual({ status: "up_to_date" });
    expect(requests.map((r) => r.route)).not.toContain(
      "POST /repos/{owner}/{repo}/git/commits"
    );
  });
});

describe("GitHubRepoWriter.resolveNodeLocalPaths", () => {
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

  it("reads node_local globs from the template's sync-manifest at sourceRef", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params).toMatchObject({
          owner: "Cogni-DAO",
          repo: "node-template",
          path: ".cogni/sync-manifest.yaml",
          ref: "feedsha",
        });
        return {
          type: "file",
          encoding: "base64",
          content: b64(`schema: 2
node_local:
  - "app/src/app/(public)/**"
  - ".cogni/repo-spec.yaml"
`),
        };
      },
    };

    await expect(
      makeWriter().resolveNodeLocalPaths({
        sourceOwner: "Cogni-DAO",
        sourceRepo: "node-template",
        sourceRef: "feedsha",
      })
    ).resolves.toEqual(["app/src/app/(public)/**", ".cogni/repo-spec.yaml"]);
  });

  it("falls back to the default floor when the manifest is absent (404)", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": () => {
        throw statusError(404, "not found");
      },
    };

    const result = await makeWriter().resolveNodeLocalPaths({
      sourceOwner: "Cogni-DAO",
      sourceRepo: "node-template",
      sourceRef: "feedsha",
    });
    // Default floor is non-empty and includes the node's homepage + repo-spec.
    // (Scope is the node's face, NOT the whole (public)/ shell — see node-local-paths.ts.)
    expect(result).toContain("app/src/app/(public)/page.tsx");
    expect(result).toContain(".cogni/repo-spec.yaml");
  });
});

describe("protectionGetToPutPayload", () => {
  it("flattens the GET response into the verbatim PUT payload (monorepo fixture shape)", () => {
    const put = protectionGetToPutPayload({
      required_status_checks: {
        strict: false,
        contexts: ["unit", "component", "static", "manifest"],
      },
      enforce_admins: { enabled: false },
      required_pull_request_reviews: null,
      required_linear_history: { enabled: false },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      required_conversation_resolution: { enabled: false },
      lock_branch: { enabled: false },
      allow_fork_syncing: { enabled: false },
    });
    expect(put).toEqual({
      required_status_checks: {
        strict: false,
        contexts: ["unit", "component", "static", "manifest"],
      },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      required_conversation_resolution: false,
      lock_branch: false,
      allow_fork_syncing: false,
    });
  });

  it("preserves enforce_admins=true and a present review requirement", () => {
    const put = protectionGetToPutPayload({
      required_status_checks: { strict: true, contexts: ["unit"] },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 2,
      },
    });
    expect(put.enforce_admins).toBe(true);
    expect(put.required_status_checks).toEqual({
      strict: true,
      contexts: ["unit"],
    });
    expect(put.required_pull_request_reviews).toEqual({
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 2,
    });
  });
});

describe("rulesetGetToPutPayload", () => {
  it("copies the merge_queue ruleset verbatim, dropping the read-only envelope", () => {
    const put = rulesetGetToPutPayload({
      // read-only envelope fields a real GET returns — must be stripped:
      // (id, source, source_type, created_at, updated_at, node_id, _links)
      name: MERGE_QUEUE_RULESET_NAME,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [
        {
          type: "merge_queue",
          parameters: {
            merge_method: "SQUASH",
            grouping_strategy: "ALLGREEN",
            min_entries_to_merge: 1,
            max_entries_to_merge: 5,
            max_entries_to_build: 5,
            min_entries_to_merge_wait_minutes: 5,
            check_response_timeout_minutes: 60,
          },
        },
      ],
    });
    expect(put).toEqual({
      name: MERGE_QUEUE_RULESET_NAME,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [
        {
          type: "merge_queue",
          parameters: {
            merge_method: "SQUASH",
            grouping_strategy: "ALLGREEN",
            min_entries_to_merge: 1,
            max_entries_to_merge: 5,
            max_entries_to_build: 5,
            min_entries_to_merge_wait_minutes: 5,
            check_response_timeout_minutes: 60,
          },
        },
      ],
      bypass_actors: [],
    });
  });

  it("preserves bypass_actors verbatim (monorepo is the SSOT, incl. any bypass)", () => {
    const put = rulesetGetToPutPayload({
      name: MERGE_QUEUE_RULESET_NAME,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "merge_queue", parameters: { merge_method: "SQUASH" } }],
      bypass_actors: [
        { actor_id: 5, actor_type: "Integration", bypass_mode: "always" },
      ],
    });
    expect(put.bypass_actors).toEqual([
      { actor_id: 5, actor_type: "Integration", bypass_mode: "always" },
    ]);
  });

  it("falls back to safe defaults when fields are absent", () => {
    const put = rulesetGetToPutPayload({});
    expect(put.name).toBe(MERGE_QUEUE_RULESET_NAME);
    expect(put.target).toBe("branch");
    expect(put.enforcement).toBe("active");
    expect(put.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
    expect(put.rules).toEqual([]);
    expect(put.bypass_actors).toEqual([]);
  });
});
