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
  diffRulesetAgainstPolicy,
  GitHubRepoWriter,
  MERGE_QUEUE_RULESET_NAME,
  nodeMainPolicyRulesetPayload,
  rulesetGetToPutPayload,
} from "@/adapters/server/vcs/github-repo-write";
import {
  renderDistributionActivationSpec,
  renderPaymentsActivationSpec,
} from "@/shared/node-app-scaffold/gens";
import { parseNodeRepoPolicy } from "@/shared/node-repo-policy";

const TEST_NODE_REPO_POLICY_JSON = JSON.stringify({
  schemaVersion: "cogni.node-repo-policy.v1",
  ruleset: {
    name: "main-pr-and-standard-ci",
    target: "default_branch",
    enforcement: "active",
    pullRequest: {
      allowedMergeMethods: ["squash"],
      dismissStaleReviewsOnPush: false,
      requireCodeOwnerReview: false,
      requireLastPushApproval: false,
      requiredApprovingReviewCount: 0,
      requiredReviewThreadResolution: false,
    },
    requiredStatusChecks: {
      doNotEnforceOnCreate: false,
      strict: false,
      contexts: ["unit", "component", "static", "manifest"],
    },
    bypassActors: [],
  },
});
const TEST_NODE_REPO_POLICY = parseNodeRepoPolicy(TEST_NODE_REPO_POLICY_JSON);
const NODE_MAIN_POLICY_RULESET_NAME = TEST_NODE_REPO_POLICY.ruleset.name;

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

const storedRulesets = new Map<number, Record<string, unknown>>();

/**
 * Record a ruleset write the way GitHub would persist it, and return the id.
 * The protection readback reads this back, so a test that overrides the write route
 * must go through here or the readback sees an empty ruleset.
 */
function recordRuleset(
  params: Record<string, unknown>,
  id?: number
): { id: number } {
  const { owner: _o, repo: _r, ruleset_id, ...stored } = params;
  const rulesetId =
    id ??
    (typeof ruleset_id === "number" ? ruleset_id : 88 + storedRulesets.size);
  storedRulesets.set(rulesetId, stored);
  return { id: rulesetId };
}

/** Serve a previously-written ruleset plus GitHub's read-only envelope. */
function readStoredRuleset(
  params: Record<string, unknown>
): Record<string, unknown> {
  const id = params.ruleset_id as number;
  return { id, source_type: "Repository", ...(storedRulesets.get(id) ?? {}) };
}

function setHappyForkHandlers(): void {
  storedRulesets.clear();
  routeHandlers = {
    "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
      expect(String(params.owner).toLowerCase()).toBe("cogni-dao");
      expect(params).toMatchObject({ path: ".cogni/repo-policy.json" });
      // The policy is read TWICE by design: once as a pre-flight at floating template
      // main (fail before minting an unprotectable repo), then again from the FORK at
      // its exact base commit — the revision whose workflows must satisfy it.
      if (params.repo === "node-template") {
        expect(params.ref).toBe("main");
      } else {
        // The fork read must be pinned to the resolved base COMMIT (the sha the
        // identity commit parents on), never the floating "main" the pre-flight used.
        expect(params.repo).toBe("atlas");
        expect(params.ref).toBe("template-main");
        expect(params.ref).not.toBe("main");
      }
      return {
        type: "file",
        encoding: "base64",
        content: Buffer.from(TEST_NODE_REPO_POLICY_JSON).toString("base64"),
      };
    },
    // Canonical merge settings (squash-only, auto-merge, delete-on-merge) — applied
    // to the node by ensureCanonicalMergeSettings during forkFromTemplate.
    "PATCH /repos/{owner}/{repo}": () => ({}),
    // Node main-policy upsert + merge-queue source lookup. Default: no rulesets,
    // so formation creates the required policy and skips the optional queue.
    "GET /repos/{owner}/{repo}/rulesets": () => [],
    "POST /repos/{owner}/{repo}/rulesets": (params) => recordRuleset(params),
    "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}": (params) =>
      recordRuleset(params),
    // READBACK: the adapter re-reads the ruleset it just wrote and refuses to call a
    // node protected until the ACTIVE rules match the policy. This store echoes what
    // GitHub was actually asked to persist for THAT id (plus the read-only envelope),
    // so the happy path exercises a real comparison instead of skipping it.
    "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}": (params) =>
      readStoredRuleset(params),
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
governance:
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
  it("allows only the env-local repo identity to differ from canonical", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": (params) => ({
        truncated: false,
        tree: [
          {
            path: "packages/repo-spec/src/schema.ts",
            mode: "100644",
            type: "blob",
            sha: "shared-schema",
          },
          {
            path: ".cogni/repo-spec.yaml",
            mode: "100644",
            type: "blob",
            sha:
              params.owner === "cogni-test-org"
                ? "test-identity"
                : "canonical-identity",
          },
        ],
      }),
      "POST /repos/{owner}/{repo}/forks": () => {
        throw new Error("fork creation reached");
      },
      // Formation now pre-flights the template repo policy before minting, so this
      // wholesale handler map has to serve it or the drift assertion never runs.
      "GET /repos/{owner}/{repo}/contents/{path}": () => ({
        type: "file",
        encoding: "base64",
        content: Buffer.from(TEST_NODE_REPO_POLICY_JSON).toString("base64"),
      }),
    };

    await expect(
      makeWriter().forkFromTemplate({
        templateOwner: "cogni-test-org",
        owner: "cogni-test-org",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        chainId: 8453,
      })
    ).rejects.toThrow("fork creation reached");
    expect(requests.at(-1)?.route).toBe("POST /repos/{owner}/{repo}/forks");
  });

  it("fails before creating a fork when an env-local mint source drifted from canonical", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": (params) => {
        const sharedEntry = {
          path: "packages/repo-spec/src/schema.ts",
          mode: "100644",
          type: "blob",
        };
        if (params.owner === "cogni-test-org") {
          return {
            truncated: false,
            tree: [
              { ...sharedEntry, sha: "stale-schema" },
              {
                path: ".cogni/repo-spec.yaml",
                mode: "100644",
                type: "blob",
                sha: "test-identity",
              },
            ],
          };
        }
        expect(params.owner).toBe("Cogni-DAO");
        return {
          truncated: false,
          tree: [
            { ...sharedEntry, sha: "canonical-schema" },
            {
              path: ".cogni/repo-spec.yaml",
              mode: "100644",
              type: "blob",
              sha: "canonical-identity",
            },
          ],
        };
      },
      // Formation now pre-flights the template repo policy before minting, so this
      // wholesale handler map has to serve it or the drift assertion never runs.
      "GET /repos/{owner}/{repo}/contents/{path}": () => ({
        type: "file",
        encoding: "base64",
        content: Buffer.from(TEST_NODE_REPO_POLICY_JSON).toString("base64"),
      }),
    };

    await expect(
      makeWriter().forkFromTemplate({
        templateOwner: "cogni-test-org",
        owner: "cogni-test-org",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        chainId: 8453,
      })
    ).rejects.toThrow(
      "node-template source drift: cogni-test-org/node-template differs from Cogni-DAO/node-template at 1 path(s): packages/repo-spec/src/schema.ts"
    );
    expect(
      requests.some(
        (request) => request.route === "POST /repos/{owner}/{repo}/forks"
      )
    ).toBe(false);
  });

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
      "GET /repos/{owner}/{repo}/contents/{path}",
      "POST /repos/{owner}/{repo}/forks",
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      "PUT /repos/{owner}/{repo}/actions/permissions",
      "PUT /repos/{owner}/{repo}/actions/permissions/workflow",
      "GET /repos/{owner}/{repo}/actions/workflows",
      // Policy re-read from the FORK at its base commit — the revision whose
      // workflows must satisfy the contexts we are about to require.
      "GET /repos/{owner}/{repo}/contents/{path}",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/trees",
      "POST /repos/{owner}/{repo}/git/commits",
      "POST /repos/{owner}/{repo}/git/refs",
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
      "PATCH /repos/{owner}/{repo}",
      "GET /repos/{owner}/{repo}/rulesets",
      "POST /repos/{owner}/{repo}/rulesets",
      // The write is not the last word — the ruleset is read back and compared.
      "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
    ]);
  });

  it("creates the exact default-branch PR + standard-CI ruleset without bypass actors", async () => {
    setHappyForkHandlers();
    let postParams: Record<string, unknown> | undefined;
    routeHandlers["POST /repos/{owner}/{repo}/rulesets"] = (params) => {
      postParams = params;
      return recordRuleset(params, 88);
    };

    await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
    });

    expect(postParams).toEqual({
      owner: "Cogni-DAO",
      repo: "atlas",
      ...nodeMainPolicyRulesetPayload(TEST_NODE_REPO_POLICY),
    });
    expect(postParams).toMatchObject({
      enforcement: "active",
      bypass_actors: [],
      rules: [
        { type: "pull_request" },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks:
              TEST_NODE_REPO_POLICY.ruleset.requiredStatusChecks.contexts.map(
                (context) => ({ context })
              ),
          },
        },
      ],
    });
  });

  it("repairs a same-named policy ruleset with an exact PUT (idempotent, non-vacuous)", async () => {
    setHappyForkHandlers();
    routeHandlers["GET /repos/{owner}/{repo}/rulesets"] = () => [
      { id: 41, name: NODE_MAIN_POLICY_RULESET_NAME },
    ];
    let putParams: Record<string, unknown> | undefined;
    routeHandlers["PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}"] = (
      params
    ) => {
      putParams = params;
      return recordRuleset(params);
    };

    await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
    });

    expect(putParams).toEqual({
      owner: "Cogni-DAO",
      repo: "atlas",
      ruleset_id: 41,
      ...nodeMainPolicyRulesetPayload(TEST_NODE_REPO_POLICY),
    });
    const requiredRule = nodeMainPolicyRulesetPayload(
      TEST_NODE_REPO_POLICY
    ).rules.find((rule) => rule.type === "required_status_checks");
    expect(requiredRule?.parameters?.required_status_checks).toHaveLength(4);
    expect(
      requests.filter(
        (request) =>
          request.route === "POST /repos/{owner}/{repo}/rulesets" &&
          request.params.name === NODE_MAIN_POLICY_RULESET_NAME
      )
    ).toHaveLength(0);
  });

  it("replicates the monorepo's merge_queue ruleset onto the node when present", async () => {
    setHappyForkHandlers();
    // Source (monorepo) HAS the queue ruleset; target (node) has none → POST.
    routeHandlers["GET /repos/{owner}/{repo}/rulesets"] = (params) =>
      params.repo === "cogni" ? [{ id: 77, name: "main-merge-queue" }] : [];
    routeHandlers["GET /repos/{owner}/{repo}/rulesets/{ruleset_id}"] = (
      params
    ) =>
      // Only the SOURCE monorepo serves the queue ruleset. The TARGET node repo hits
      // this same route for the protection READBACK, which must see what was stored.
      params.repo !== "cogni"
        ? readStoredRuleset(params)
        : {
            name: "main-merge-queue",
            target: "branch",
            enforcement: "active",
            conditions: {
              ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
            },
            rules: [
              { type: "merge_queue", parameters: { merge_method: "SQUASH" } },
            ],
          };
    routeHandlers["POST /repos/{owner}/{repo}/rulesets"] = (params) =>
      recordRuleset(params, 99);

    await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
      mergeQueueSourceOwner: "Cogni-DAO",
      mergeQueueSourceRepo: "cogni",
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
      (r) =>
        r.route === "POST /repos/{owner}/{repo}/rulesets" &&
        r.params.name === MERGE_QUEUE_RULESET_NAME
    );
    expect(post?.params).toMatchObject({
      owner: "Cogni-DAO",
      repo: "atlas",
      name: "main-merge-queue",
      enforcement: "active",
    });
  });

  it("does NOT fail formation when the node repo plan cannot carry a merge queue (422)", async () => {
    // QUEUE_IS_BEST_EFFORT: the merge_queue ruleset is org/Team-only — a personal-account
    // node 422s. The queue is an enhancement (the PR/check ruleset is the backstop), so
    // formation must still succeed; the node is born queue-less.
    setHappyForkHandlers();
    routeHandlers["GET /repos/{owner}/{repo}/rulesets"] = (params) =>
      params.repo === "cogni" ? [{ id: 77, name: "main-merge-queue" }] : [];
    routeHandlers["GET /repos/{owner}/{repo}/rulesets/{ruleset_id}"] = (
      params
    ) =>
      // Only the SOURCE monorepo serves the queue ruleset. The TARGET node repo hits
      // this same route for the protection READBACK, which must see what was stored.
      params.repo !== "cogni"
        ? readStoredRuleset(params)
        : {
            name: "main-merge-queue",
            target: "branch",
            enforcement: "active",
            conditions: {
              ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
            },
            rules: [
              { type: "merge_queue", parameters: { merge_method: "SQUASH" } },
            ],
          };
    routeHandlers["POST /repos/{owner}/{repo}/rulesets"] = (params) =>
      params.name === MERGE_QUEUE_RULESET_NAME
        ? Promise.reject(
            statusError(
              422,
              "Invalid rule 'merge_queue': unsupported on this plan"
            )
          )
        : recordRuleset(params, 88);

    // Resolves (no throw) despite the queue write failing.
    const result = await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
      mergeQueueSourceOwner: "Cogni-DAO",
      mergeQueueSourceRepo: "cogni",
    });
    expect(result.headSha).toBeTruthy();
  });

  it("fails loud when the App lacks administration:write for the required policy", async () => {
    setHappyForkHandlers();
    routeHandlers["POST /repos/{owner}/{repo}/rulesets"] = () =>
      Promise.reject(
        statusError(403, "Resource not accessible by integration")
      );

    await expect(
      makeWriter().forkFromTemplate({
        templateOwner: "Cogni-DAO",
        owner: "Cogni-DAO",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        ownerWallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949",
        chainId: 8453,
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("does not misclassify a merge-queue 403 as an optional plan limitation", async () => {
    setHappyForkHandlers();
    routeHandlers["GET /repos/{owner}/{repo}/rulesets"] = (params) =>
      params.repo === "cogni"
        ? [{ id: 77, name: MERGE_QUEUE_RULESET_NAME }]
        : [];
    routeHandlers["GET /repos/{owner}/{repo}/rulesets/{ruleset_id}"] = () => ({
      name: MERGE_QUEUE_RULESET_NAME,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "merge_queue", parameters: { merge_method: "SQUASH" } }],
    });
    routeHandlers["POST /repos/{owner}/{repo}/rulesets"] = (params) =>
      params.name === MERGE_QUEUE_RULESET_NAME
        ? Promise.reject(
            statusError(403, "Resource not accessible by integration")
          )
        : recordRuleset(params, 88);

    await expect(
      makeWriter().forkFromTemplate({
        templateOwner: "Cogni-DAO",
        owner: "Cogni-DAO",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        chainId: 8453,
        mergeQueueSourceOwner: "Cogni-DAO",
        mergeQueueSourceRepo: "cogni",
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("does not reuse an existing same-named repo unless it is the template fork", async () => {
    setHappyForkHandlers();
    routeHandlers["POST /repos/{owner}/{repo}/forks"] = () =>
      Promise.reject(statusError(422, "Repository creation failed"));
    routeHandlers["GET /repos/{owner}/{repo}"] = () => ({
      full_name: "Cogni-DAO/atlas",
      fork: false,
      clone_url: "https://github.com/Cogni-DAO/atlas.git",
    });

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
      "GET /repos/{owner}/{repo}/contents/{path}",
      "POST /repos/{owner}/{repo}/forks",
      "GET /repos/{owner}/{repo}",
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      "PUT /repos/{owner}/{repo}/actions/permissions",
      "PUT /repos/{owner}/{repo}/actions/permissions/workflow",
      "GET /repos/{owner}/{repo}/actions/workflows",
      // Policy re-read from the FORK at its base commit — the revision whose
      // workflows must satisfy the contexts we are about to require.
      "GET /repos/{owner}/{repo}/contents/{path}",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/trees",
      "POST /repos/{owner}/{repo}/git/commits",
      "POST /repos/{owner}/{repo}/git/refs",
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
      "PATCH /repos/{owner}/{repo}",
      "GET /repos/{owner}/{repo}/rulesets",
      "POST /repos/{owner}/{repo}/rulesets",
      "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
    ]);
  });

  it("fails before repo creation when the template policy is missing", async () => {
    setHappyForkHandlers();
    routeHandlers["GET /repos/{owner}/{repo}/contents/{path}"] = () =>
      Promise.reject(statusError(404, "Not Found"));

    await expect(
      makeWriter().forkFromTemplate({
        templateOwner: "Cogni-DAO",
        owner: "Cogni-DAO",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        chainId: 8453,
      })
    ).rejects.toMatchObject({ code: "template_repo_policy_missing" });
    expect(requests.map((request) => request.route)).not.toContain(
      "POST /repos/{owner}/{repo}/forks"
    );
  });

  it("fails before repo creation when the template policy has bypass actors", async () => {
    setHappyForkHandlers();
    const invalidPolicy = JSON.stringify({
      ...TEST_NODE_REPO_POLICY,
      ruleset: {
        ...TEST_NODE_REPO_POLICY.ruleset,
        bypassActors: [{ actorType: "OrganizationAdmin" }],
      },
    });
    routeHandlers["GET /repos/{owner}/{repo}/contents/{path}"] = () => ({
      type: "file",
      encoding: "base64",
      content: Buffer.from(invalidPolicy).toString("base64"),
    });

    await expect(
      makeWriter().forkFromTemplate({
        templateOwner: "Cogni-DAO",
        owner: "Cogni-DAO",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        chainId: 8453,
      })
    ).rejects.toMatchObject({ code: "template_repo_policy_invalid" });
    expect(requests.map((request) => request.route)).not.toContain(
      "POST /repos/{owner}/{repo}/forks"
    );
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
        // bug.5094 — the GENERATED per-env scheduler-worker routing patch. A birth
        // must splice the new node into EVERY deploy env's map (and the shared base
        // default), else the PR is drift-red vs render-scheduler-worker-endpoints.sh
        // AND the node is unrouted wherever it later deploys.
        const endpointsEnv = path.match(
          /^infra\/k8s\/overlays\/([^/]+)\/scheduler-worker\/node-endpoints\.patch\.yaml$/
        )?.[1];
        if (endpointsEnv !== undefined) {
          return {
            type: "file",
            encoding: "base64",
            content: encode(`apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
data:
  COGNI_NODE_ENDPOINTS: "node-template=http://node-template-node-app:3000,b927a9dd-6132-4fc9-a51e-e3cee2568e3c=http://node-template-node-app:3000"
`),
          };
        }
        if (path === "infra/k8s/base/scheduler-worker/configmap.yaml") {
          return {
            type: "file",
            encoding: "base64",
            content: encode(`apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-worker-config
data:
  COGNI_NODE_ENDPOINTS: "node-template=http://node-template-node-app:3000,b927a9dd-6132-4fc9-a51e-e3cee2568e3c=http://node-template-node-app:3000"
`),
          };
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
        // The committed web-node roster (mandatory monorepo file). The publish MUST splice the
        // new node in here so the PR is born drift-green (network-nodes-catalog-drift gate).
        if (
          path ===
          "nodes/operator/app/src/adapters/server/node-registry/network-nodes.data.ts"
        ) {
          return {
            type: "file",
            encoding: "base64",
            content: encode(`export interface NetworkNode {
  name: string;
  nodeId?: string;
  primary?: boolean;
}

export const NETWORK_NODES: readonly NetworkNode[] = [
  { name: "node-template", nodeId: "b927a9dd-6132-4fc9-a51e-e3cee2568e3c" },
];
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
        for (const env of ["candidate-a"]) {
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
        expect(
          tree.some((item) =>
            item.path.startsWith("infra/k8s/overlays/preview/atlas/")
          )
        ).toBe(false);
        expect(
          tree.some((item) =>
            item.path.startsWith("infra/k8s/overlays/production/atlas/")
          )
        ).toBe(false);

        // ROUTING DRIFT-GREEN PROOF (bug.5094): the publish PR MUST splice the new node into
        // the shared base default AND every deploy env's provider-resolved map. Splicing base
        // alone leaves the PR drift-red (render-scheduler-worker-endpoints.sh --check) and the
        // node unrouted in preview/production. A birth is always k3s → in-cluster convention.
        for (const routingPath of [
          "infra/k8s/base/scheduler-worker/configmap.yaml",
          "infra/k8s/overlays/candidate-a/scheduler-worker/node-endpoints.patch.yaml",
          "infra/k8s/overlays/preview/scheduler-worker/node-endpoints.patch.yaml",
          "infra/k8s/overlays/production/scheduler-worker/node-endpoints.patch.yaml",
        ]) {
          const routingEntry = tree.find((item) => item.path === routingPath);
          expect(routingEntry, routingPath).toBeDefined();
          const routing = blobs.get(routingEntry?.sha ?? "");
          expect(routing, routingPath).toContain(
            "atlas=http://atlas-node-app:3000,11111111-1111-4111-8111-111111111111=http://atlas-node-app:3000"
          );
          expect(routing, routingPath).toContain(
            "node-template=http://node-template-node-app:3000"
          );
        }

        // ROSTER DRIFT-GREEN PROOF (#1957): the publish PR MUST splice the new node into the
        // committed web-node roster in the SAME tree as the catalog row it adds — else the
        // network-nodes-catalog-drift gate fails `unit` and the auto-PR is un-mergeable. Assert
        // the emitted roster blob carries `atlas` (new node) AND keeps the existing node-template.
        const rosterEntry = tree.find(
          (item) =>
            item.path ===
            "nodes/operator/app/src/adapters/server/node-registry/network-nodes.data.ts"
        );
        expect(rosterEntry).toBeDefined();
        const roster = blobs.get(rosterEntry?.sha ?? "");
        expect(roster).toContain(
          `  { name: "atlas", nodeId: "11111111-1111-4111-8111-111111111111" },`
        );
        expect(roster).toContain(`{ name: "node-template",`);
        // Drift-green by construction: the catalog gains atlas.yaml (type:node) and the roster
        // gains `atlas` in the SAME commit → the slug sets stay equal.
        const catalogEntry = tree.find(
          (item) => item.path === "infra/catalog/atlas.yaml"
        );
        expect(catalogEntry).toBeDefined();
        const catalog = blobs.get(catalogEntry?.sha ?? "");
        expect(catalog).toContain("type: node");
        expect(catalog).toContain("envs: [candidate-a]");
        expect(catalog).toContain("activity_env: candidate-a");
        expect(catalog).toContain(
          'owner_wallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949"'
        );

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
        ownerWallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949",
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

describe("GitHubRepoWriter.listCatalogNodes", () => {
  const encode = (value: string) =>
    Buffer.from(value, "utf-8").toString("base64");

  it("App-reads external and in-repo node identity for registry projection", async () => {
    const sourceRef = "0123456789012345678901234567890123456789";
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params.ref).toBe(sourceRef);
        if (params.path === "infra/catalog") {
          return [
            { name: "atlas.yaml", type: "file" },
            { name: "operator.yaml", type: "file" },
            { name: "_schema.json", type: "file" },
          ];
        }
        const bodies: Record<string, string> = {
          "infra/catalog/atlas.yaml": `name: atlas
type: node
node_id: 11111111-1111-4111-8111-111111111111
source_repo: https://github.com/Cogni-DAO/atlas.git
path_prefix: nodes/atlas/
envs: [candidate-a]
activity_env: candidate-a
deployment_provider:
  candidate-a: akash
owner_wallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949"
`,
          "infra/catalog/operator.yaml": `name: operator
type: node
path_prefix: nodes/operator/
envs: [candidate-a, preview, production]
activity_env: production
owner_wallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949"
`,
          "nodes/operator/.cogni/repo-spec.yaml":
            'node_id: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d"\n',
        };
        const body = bodies[String(params.path)];
        if (!body) throw statusError(404, `not found: ${params.path}`);
        return { type: "file", encoding: "base64", content: encode(body) };
      },
    };

    await expect(
      makeWriter().listCatalogNodes({
        parentOwner: "Cogni-DAO",
        parentRepo: "cogni",
        sourceRef,
      })
    ).resolves.toEqual([
      {
        nodeId: "11111111-1111-4111-8111-111111111111",
        slug: "atlas",
        repoUrl: "https://github.com/Cogni-DAO/atlas",
        repoOwner: "Cogni-DAO",
        repoName: "atlas",
        deployEnvs: ["candidate-a"],
        activityEnv: "candidate-a",
        // bug.5106 — declared placement is projected so the operator can resolve WHERE this
        // node runs without reading the catalog on the hot path.
        deploymentProviders: { "candidate-a": "akash" },
        ownerWallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949",
      },
      {
        nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
        slug: "operator",
        repoUrl: "https://github.com/Cogni-DAO/cogni",
        repoOwner: "Cogni-DAO",
        repoName: "cogni",
        deployEnvs: ["candidate-a", "preview", "production"],
        activityEnv: "production",
        // No `deployment_provider` row ⇒ empty map ⇒ K3S_IS_DEFAULT everywhere.
        deploymentProviders: {},
        ownerWallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949",
      },
    ]);
  });

  it("fails loud on a deployment_provider outside the declared vocabulary (bug.5106)", async () => {
    const sourceRef = "0123456789012345678901234567890123456789";
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        if (params.path === "infra/catalog") {
          return [{ name: "atlas.yaml", type: "file" }];
        }
        return {
          type: "file",
          encoding: "base64",
          content: encode(`name: atlas
type: node
node_id: 11111111-1111-4111-8111-111111111111
source_repo: https://github.com/Cogni-DAO/atlas.git
path_prefix: nodes/atlas/
envs: [candidate-a]
activity_env: candidate-a
deployment_provider:
  candidate-a: fly-io
owner_wallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949"
`),
        };
      },
    };

    // A placement the address resolver cannot honour must never reach the registry as a silent
    // k3s default — one bad row fails the whole reconcile, like every other malformed field.
    await expect(
      makeWriter().listCatalogNodes({
        parentOwner: "Cogni-DAO",
        parentRepo: "cogni",
        sourceRef,
      })
    ).rejects.toMatchObject({ code: "invalid_catalog", status: 409 });
  });

  it("rejects an invalid in-repo node identity", async () => {
    const sourceRef = "0123456789012345678901234567890123456789";
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        if (params.path === "infra/catalog") {
          return [{ name: "operator.yaml", type: "file" }];
        }
        const bodies: Record<string, string> = {
          "infra/catalog/operator.yaml": `name: operator
type: node
path_prefix: nodes/operator/
envs: [candidate-a]
activity_env: candidate-a
owner_wallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949"
`,
          "nodes/operator/.cogni/repo-spec.yaml": "node_id: not-a-uuid\n",
        };
        const body = bodies[String(params.path)];
        if (!body) throw statusError(404, `not found: ${params.path}`);
        return { type: "file", encoding: "base64", content: encode(body) };
      },
    };

    await expect(
      makeWriter().listCatalogNodes({
        parentOwner: "Cogni-DAO",
        parentRepo: "cogni",
        sourceRef,
      })
    ).rejects.toMatchObject({ code: "invalid_repo_spec", status: 422 });
  });

  it("fails loud when activity_env is outside the deploy set", async () => {
    const sourceRef = "0123456789012345678901234567890123456789";
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        expect(params.ref).toBe(sourceRef);
        if (params.path === "infra/catalog") {
          return [{ name: "atlas.yaml", type: "file" }];
        }
        return {
          type: "file",
          encoding: "base64",
          content: encode(`name: atlas
type: node
node_id: 11111111-1111-4111-8111-111111111111
source_repo: https://github.com/Cogni-DAO/atlas.git
path_prefix: nodes/atlas/
envs: [candidate-a]
activity_env: production
owner_wallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949"
`),
        };
      },
    };

    await expect(
      makeWriter().listCatalogNodes({
        parentOwner: "Cogni-DAO",
        parentRepo: "cogni",
        sourceRef,
      })
    ).rejects.toThrow(/activity_env must be present in envs/);
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

  it("surfaces the repo-spec validation reason in invalid_repo_spec (bug.5006)", async () => {
    // A stale node branch that still carries the retired `knowledge-<slug>`
    // DoltHub name (retired by #1974). The flight must reject it — but the
    // error must name the failing field so the node dev can self-fix instead
    // of reverse-engineering the operator schema.
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
        if (
          params.owner === "cogni-test-org" &&
          params.repo === "ghcr" &&
          params.path === ".cogni/repo-spec.yaml"
        ) {
          return {
            type: "file",
            encoding: "base64",
            content: encode(`node_id: "${nodeId}"
governance:
  chain_id: "8453"
knowledge:
  database: "knowledge_ghcr"
  remote:
    provider: dolthub
    owner: "cogni-dao"
    repo: "knowledge-ghcr"
    url: "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-ghcr"
    custody: cogni-owned
`),
          };
        }
        throw statusError(404, `not found: ${String(params.path)}`);
      },
      "GET /repos/{owner}/{repo}/commits/{ref}": () => ({ sha: sourceSha }),
    };

    const rejection = await makeWriter()
      .prepareNodeRefCandidateFlight({
        parentOwner: "cogni-test-org",
        parentRepo: "cogni-monorepo",
        nodeId,
        slug: "ghcr",
        sourceSha,
      })
      .then(
        () => {
          throw new Error("expected prepareNodeRefCandidateFlight to reject");
        },
        (error: unknown) =>
          error as { code: string; status: number; message: string }
      );

    expect(rejection).toMatchObject({
      code: "invalid_repo_spec",
      status: 422,
    });
    // The actionable part: the failing field is named, not swallowed.
    expect(rejection.message).toContain("knowledge.remote.repo");
    expect(rejection.message).not.toBe(
      "node repo-spec is invalid at sourceSha"
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

  // task.5078 — the Tier-1 lists are ROOTS, not the delivered set. A workflow that invokes a script,
  // and a contract barrel that re-exports a module, must carry those files in the SAME sync or the
  // fork receives a build that cannot run (no fork but node-template could publish an Akash bundle).
  it("delivers the transitive closure of the declared roots (TIER1_IS_CLOSED)", async () => {
    const source = {
      ".github/workflows/pr-build.yml":
        'jobs:\n  manifest:\n    steps:\n      - run: node "$GITHUB_WORKSPACE/scripts/ci/record-node-bundle-publication.mjs"\n',
      "scripts/ci/record-node-bundle-publication.mjs":
        'import { readFileSync } from "node:fs";\n',
      "packages/repo-spec/src/index.ts":
        'export { buildNodeArtifactBundle } from "./artifact-bundle.js";\n',
      "packages/repo-spec/src/artifact-bundle.ts": 'import { z } from "zod";\n',
      "packages/repo-spec/package.json": '{ "name": "@cogni/repo-spec" }\n',
    };
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": contentsHandler(source, {}),
      "POST /repos/{owner}/{repo}/git/blobs": () => ({ sha: "blob" }),
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
      "POST /repos/{owner}/{repo}/git/refs": () => ({}),
      "POST /repos/{owner}/{repo}/pulls": () => ({
        number: 11,
        html_url: "https://github.com/cogni-test-org/test-cog/pull/11",
      }),
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": () => ({}),
    };

    const result = await makeWriter().syncCanonicalFilesToFork({
      ...syncInput(),
      canonicalPaths: [
        ".github/workflows/pr-build.yml",
        "packages/repo-spec/src/index.ts",
      ],
    });

    expect(result.status).toBe("pr_opened");
    expect(result.changedPaths).toEqual([
      ".github/workflows/pr-build.yml",
      "packages/repo-spec/src/index.ts",
      // Derived — never hand-listed, and exactly what the forks were missing.
      "scripts/ci/record-node-bundle-publication.mjs",
      "packages/repo-spec/src/artifact-bundle.ts",
      "packages/repo-spec/package.json",
    ]);
  });

  it("fails closed when a re-exported contract module is absent at the source", async () => {
    routeHandlers = {
      "GET /repos/{owner}/{repo}/contents/{path}": contentsHandler(
        {
          "packages/repo-spec/src/index.ts":
            'export { buildNodeArtifactBundle } from "./artifact-bundle.js";\n',
        },
        {}
      ),
    };

    await expect(
      makeWriter().syncCanonicalFilesToFork({
        ...syncInput(),
        canonicalPaths: ["packages/repo-spec/src/index.ts"],
      })
    ).rejects.toThrow(/packages\/repo-spec\/src\/artifact-bundle\.ts/);
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

describe("diffRulesetAgainstPolicy — protection readback", () => {
  // The review's core objection to the first implementation: the tests stopped at the
  // SUBMITTED payload, so they could not detect GitHub storing something other than
  // what we sent. A 2xx is not proof of protection. These pin the comparator that
  // turns the write into a proof.
  const policy = nodeMainPolicyRulesetPayload(TEST_NODE_REPO_POLICY);

  // What a faithful GitHub read of our own payload looks like: same rules, plus the
  // read-only envelope GitHub adds. The comparator must ignore the envelope.
  const faithfulReadback = () => ({
    id: 42,
    node_id: "RS_kwDO",
    source: "cogni-dao/levelup",
    source_type: "Repository",
    created_at: "2026-08-27T00:00:00Z",
    updated_at: "2026-08-27T00:00:00Z",
    _links: { self: { href: "https://api.github.com/..." } },
    current_user_can_bypass: "never",
    name: policy.name,
    target: policy.target,
    enforcement: policy.enforcement,
    conditions: structuredClone(policy.conditions),
    rules: structuredClone(policy.rules),
    bypass_actors: [],
  });

  it("accepts a faithful readback, ignoring GitHub's read-only envelope", () => {
    expect(
      diffRulesetAgainstPolicy(faithfulReadback() as never, policy)
    ).toEqual([]);
  });

  it("compares required contexts as a set, not by order", () => {
    const shuffled = faithfulReadback();
    const checks = shuffled.rules.find(
      (rule: { type: string }) => rule.type === "required_status_checks"
    ) as { parameters: { required_status_checks: unknown[] } };
    checks.parameters.required_status_checks.reverse();
    expect(diffRulesetAgainstPolicy(shuffled as never, policy)).toEqual([]);
  });

  it("catches a ruleset stored as evaluate instead of active", () => {
    const weakened = { ...faithfulReadback(), enforcement: "evaluate" };
    expect(
      diffRulesetAgainstPolicy(weakened as never, policy).join(" ")
    ).toContain("enforcement");
  });

  it("catches a dropped required context", () => {
    const partial = faithfulReadback();
    const checks = partial.rules.find(
      (rule: { type: string }) => rule.type === "required_status_checks"
    ) as { parameters: { required_status_checks: { context: string }[] } };
    const dropped = checks.parameters.required_status_checks.pop();
    expect(
      diffRulesetAgainstPolicy(partial as never, policy).join(" ")
    ).toContain(`required contexts missing: ${dropped?.context}`);
  });

  it("catches a silently dropped pull_request rule — main pushable without a PR", () => {
    const noPr = faithfulReadback();
    noPr.rules = noPr.rules.filter(
      (rule: { type: string }) => rule.type !== "pull_request"
    );
    expect(diffRulesetAgainstPolicy(noPr as never, policy).join(" ")).toContain(
      "pull_request rule is absent"
    );
  });

  it("catches a bypass actor, which would make protection escapable", () => {
    const escapable = {
      ...faithfulReadback(),
      bypass_actors: [{ actor_id: 1, actor_type: "OrganizationAdmin" }],
    };
    expect(
      diffRulesetAgainstPolicy(escapable as never, policy).join(" ")
    ).toContain("bypass actor");
  });

  it("catches a ruleset that no longer targets the default branch", () => {
    const misTargeted = faithfulReadback();
    misTargeted.conditions = {
      ref_name: { include: ["refs/heads/dev"], exclude: [] },
    };
    expect(
      diffRulesetAgainstPolicy(misTargeted as never, policy).join(" ")
    ).toContain("~DEFAULT_BRANCH");
  });
});

describe("forkFromTemplate — protection is the last fallible step", () => {
  // The zero-bypass PR ruleset makes any further direct `main` update impossible,
  // including the identity `upsertRef` a retry would redo. So if ANY fallible step
  // ran after the protection write and failed, the node would be stranded: the retry
  // cannot re-run identity, and whatever failed never completed. Merge-queue
  // replication is the only such step, and it must come first.
  const routesOf = (predicate: (route: string) => boolean) =>
    requests.map((request) => request.route).filter(predicate);

  it("replicates the merge queue BEFORE writing the protection ruleset", async () => {
    setHappyForkHandlers();
    routeHandlers["GET /repos/{owner}/{repo}/rulesets"] = (params) =>
      params.repo === "cogni"
        ? [{ id: 77, name: MERGE_QUEUE_RULESET_NAME }]
        : [];
    routeHandlers["GET /repos/{owner}/{repo}/rulesets/{ruleset_id}"] = (
      params
    ) =>
      params.repo !== "cogni"
        ? readStoredRuleset(params)
        : {
            name: MERGE_QUEUE_RULESET_NAME,
            target: "branch",
            enforcement: "active",
            conditions: {
              ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
            },
            rules: [
              { type: "merge_queue", parameters: { merge_method: "SQUASH" } },
            ],
          };

    await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
      mergeQueueSourceOwner: "Cogni-DAO",
      mergeQueueSourceRepo: "cogni",
    });

    const writes = requests.filter(
      (request) => request.route === "POST /repos/{owner}/{repo}/rulesets"
    );
    const names = writes.map((request) => request.params.name);
    expect(names).toEqual([
      MERGE_QUEUE_RULESET_NAME,
      NODE_MAIN_POLICY_RULESET_NAME,
    ]);
  });

  it("leaves main unprotected — so a retry can still re-form it — when the queue write fails", async () => {
    setHappyForkHandlers();
    routeHandlers["GET /repos/{owner}/{repo}/rulesets"] = (params) =>
      params.repo === "cogni"
        ? [{ id: 77, name: MERGE_QUEUE_RULESET_NAME }]
        : [];
    routeHandlers["GET /repos/{owner}/{repo}/rulesets/{ruleset_id}"] = (
      params
    ) =>
      params.repo !== "cogni"
        ? readStoredRuleset(params)
        : {
            name: MERGE_QUEUE_RULESET_NAME,
            target: "branch",
            enforcement: "active",
            conditions: {
              ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
            },
            rules: [
              { type: "merge_queue", parameters: { merge_method: "SQUASH" } },
            ],
          };
    // A queue write failure that is NOT the optional plan-limitation 422.
    routeHandlers["POST /repos/{owner}/{repo}/rulesets"] = (params) =>
      params.name === MERGE_QUEUE_RULESET_NAME
        ? Promise.reject(statusError(500, "GitHub is having a moment"))
        : recordRuleset(params, 88);

    await expect(
      makeWriter().forkFromTemplate({
        templateOwner: "Cogni-DAO",
        owner: "Cogni-DAO",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        chainId: 8453,
        mergeQueueSourceOwner: "Cogni-DAO",
        mergeQueueSourceRepo: "cogni",
      })
    ).rejects.toBeTruthy();

    // The protection ruleset was never written, so `main` is still directly
    // updatable and the whole formation is safely retryable.
    expect(
      routesOf((route) => route === "POST /repos/{owner}/{repo}/rulesets")
        .length
    ).toBe(1); // the failed queue attempt only
    const policyWrites = requests.filter(
      (request) => request.params.name === NODE_MAIN_POLICY_RULESET_NAME
    );
    expect(policyWrites).toEqual([]);
  });
});

describe("forkFromTemplate — policy is bound to the inherited tree", () => {
  // Finding 3: the policy used to be read once, from FLOATING template main, before
  // the fork existed. Template main can move between that read and the fork (and the
  // 422-reuse path can hand back a much older fork), so the operator could enforce a
  // required context the fork's inherited workflows never emit — which deadlocks the
  // new node's default branch on its very first PR. The applied policy must come from
  // the same revision as the workflows that have to satisfy it.
  it("enforces the policy at the fork's base commit, not a template main that moved", async () => {
    setHappyForkHandlers();
    const movedOnTemplateMain = JSON.stringify({
      ...TEST_NODE_REPO_POLICY,
      ruleset: {
        ...TEST_NODE_REPO_POLICY.ruleset,
        requiredStatusChecks: {
          ...TEST_NODE_REPO_POLICY.ruleset.requiredStatusChecks,
          // A context that exists only on the newer template main.
          contexts: [
            "unit",
            "component",
            "static",
            "manifest",
            "brand-new-check",
          ],
        },
      },
    });
    routeHandlers["GET /repos/{owner}/{repo}/contents/{path}"] = (params) => ({
      type: "file",
      encoding: "base64",
      content: Buffer.from(
        params.repo === "node-template"
          ? movedOnTemplateMain // template main advanced after the pre-flight read
          : TEST_NODE_REPO_POLICY_JSON // what the fork actually inherited
      ).toString("base64"),
    });

    let written: Record<string, unknown> | undefined;
    routeHandlers["POST /repos/{owner}/{repo}/rulesets"] = (params) => {
      written = params;
      return recordRuleset(params, 88);
    };

    await makeWriter().forkFromTemplate({
      templateOwner: "Cogni-DAO",
      owner: "Cogni-DAO",
      slug: "atlas",
      nodeId: "11111111-1111-4111-8111-111111111111",
      chainId: 8453,
    });

    const required = (
      written?.rules as Array<{ type: string; parameters?: unknown }>
    ).find((rule) => rule.type === "required_status_checks");
    const contexts = (
      required?.parameters as {
        required_status_checks: Array<{ context: string }>;
      }
    ).required_status_checks.map((check) => check.context);

    expect(contexts).toEqual(
      TEST_NODE_REPO_POLICY.ruleset.requiredStatusChecks.contexts
    );
    expect(contexts).not.toContain("brand-new-check");
  });

  it("fails formation when the fork's base commit carries no policy", async () => {
    setHappyForkHandlers();
    routeHandlers["GET /repos/{owner}/{repo}/contents/{path}"] = (params) => {
      if (params.repo === "node-template") {
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(TEST_NODE_REPO_POLICY_JSON).toString("base64"),
        };
      }
      return Promise.reject(statusError(404, "Not Found"));
    };

    await expect(
      makeWriter().forkFromTemplate({
        templateOwner: "Cogni-DAO",
        owner: "Cogni-DAO",
        slug: "atlas",
        nodeId: "11111111-1111-4111-8111-111111111111",
        chainId: 8453,
      })
    ).rejects.toMatchObject({ code: "template_repo_policy_missing" });
  });
});
