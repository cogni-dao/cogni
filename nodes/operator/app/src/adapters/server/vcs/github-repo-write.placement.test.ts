// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-repo-write` (openNodePlacementPr — akash deployment-block gate)
 * Purpose: Pin the AKASH_REQUIRES_DEPLOYMENT_BLOCK pre-check (story.5016 T5 review hardening): a flip
 *   to akash placement must fetch the node's OWN `source_repo` repo-spec and reject BEFORE opening a
 *   PR when it has no declared `deployment:` block — the legacy fallback carries no `secret_refs`,
 *   which is fatal off the k3s lane (env arrives ONLY through declared refs). Also pins that a
 *   declared block lets the request proceed past the gate.
 * Scope: Exercises `GitHubRepoWriter.openNodePlacementPr` against a mocked Octokit `request` + a
 *   stubbed installation-id fetch; no real network IO.
 * Side-effects: none (network mocked)
 * Links: src/adapters/server/vcs/github-repo-write.ts (assertAkashDeploymentBlock),
 *   packages/repo-spec/src/accessors.ts (hasDeclaredNodeDeployment), story.5016
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const octokitRequest = vi.fn();

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "fake-app-token" }),
}));
vi.mock("@octokit/core", () => ({
  Octokit: vi.fn().mockImplementation(function MockOctokit(this: unknown) {
    return Object.assign(this ?? {}, { request: octokitRequest });
  }),
}));

import { renderRepoSpec } from "@/shared/node-app-scaffold/gens";

import { GitHubRepoWriter } from "./github-repo-write";

const OPERATOR_OWNER = "cogni-dao";
const OPERATOR_REPO = "cogni-template";
const NODE_OWNER = "cogni-dao";
const NODE_REPO = "blue";
const SLUG = "blue";
const ENV = "preview" as const;

// Already placed on akash for `preview`, with a `source_repo` (external build plane) — the shape
// buildPlacementPlan needs to resolve `no_changes` once the deployment-block gate lets the request
// through, so the "proceeds" test doesn't also need to mock the full commit/PR write path.
const CATALOG = `name: blue
type: node
port: 3200
node_port: 31100
source_repo: https://github.com/${NODE_OWNER}/${NODE_REPO}
image_repository: ghcr.io/${NODE_OWNER}/${NODE_REPO}
envs: [candidate-a, preview, production]
deployment_provider:
  preview: akash
activity_env: candidate-a
path_prefix: nodes/blue/
`;

const KUSTOMIZATION = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - preview-other-applicationset.yaml
`;

const REPO_SPEC_WITH_DEPLOYMENT = renderRepoSpec({
  slug: SLUG,
  repoOwner: NODE_OWNER,
  nodeId: "11111111-2222-4333-8444-555555555555",
  chainId: 8453,
});

// Strip the block BORN_DEPLOYABLE renders by default, simulating a pre-task.5079 legacy spec.
const REPO_SPEC_WITHOUT_DEPLOYMENT = (() => {
  const parsed = parseYaml(REPO_SPEC_WITH_DEPLOYMENT) as Record<
    string,
    unknown
  >;
  delete parsed.deployment;
  return stringifyYaml(parsed);
})();

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function fileResponse(text: string) {
  return {
    data: {
      type: "file",
      encoding: "base64",
      content: b64(text),
      sha: "blob-sha",
    },
  };
}

/** Routes the endpoints `openNodePlacementPr` actually issues; anything not in `files` 404s. */
function makeRouter(files: Record<string, string>) {
  return vi.fn(async (endpoint: string, params: Record<string, unknown>) => {
    if (endpoint === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      return { data: { object: { sha: "main-commit-sha" } } };
    }
    if (endpoint === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
      return { data: { tree: { sha: "main-tree-sha" } } };
    }
    if (endpoint === "GET /repos/{owner}/{repo}/contents/{path}") {
      const key = `${params.owner}/${params.repo}:${params.path}`;
      const text = files[key];
      if (text === undefined) {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      return fileResponse(text);
    }
    throw new Error(
      `unexpected octokit request in test: ${endpoint} ${JSON.stringify(params)}`
    );
  });
}

beforeEach(() => {
  octokitRequest.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ id: 42 }) }))
  );
});

describe("openNodePlacementPr — akash deployment-block gate (story.5016 T5 hardening)", () => {
  it("rejects 422 akash_requires_deployment_block when the node repo-spec has no declared deployment block, and opens no PR", async () => {
    octokitRequest.mockImplementation(
      makeRouter({
        [`${OPERATOR_OWNER}/${OPERATOR_REPO}:infra/catalog/${SLUG}.yaml`]:
          CATALOG,
        [`${NODE_OWNER}/${NODE_REPO}:.cogni/repo-spec.yaml`]:
          REPO_SPEC_WITHOUT_DEPLOYMENT,
      })
    );
    const writer = new GitHubRepoWriter({ appId: "1", privateKey: "key" });

    await expect(
      writer.openNodePlacementPr({
        owner: OPERATOR_OWNER,
        repo: OPERATOR_REPO,
        slug: SLUG,
        env: ENV,
        placement: "akash",
      })
    ).rejects.toMatchObject({
      code: "akash_requires_deployment_block",
      status: 422,
    });

    // The gate fired before any tree/commit/PR write.
    const writeCalls = octokitRequest.mock.calls.filter(([endpoint]) =>
      String(endpoint).startsWith("POST")
    );
    expect(writeCalls).toHaveLength(0);
  });

  it("rejects 422 repo_spec_missing when the node repo-spec cannot be fetched at all", async () => {
    octokitRequest.mockImplementation(
      makeRouter({
        [`${OPERATOR_OWNER}/${OPERATOR_REPO}:infra/catalog/${SLUG}.yaml`]:
          CATALOG,
        // .cogni/repo-spec.yaml deliberately absent from the file map → 404.
      })
    );
    const writer = new GitHubRepoWriter({ appId: "1", privateKey: "key" });

    await expect(
      writer.openNodePlacementPr({
        owner: OPERATOR_OWNER,
        repo: OPERATOR_REPO,
        slug: SLUG,
        env: ENV,
        placement: "akash",
      })
    ).rejects.toMatchObject({ code: "repo_spec_missing", status: 422 });
  });

  it("proceeds past the gate when the node repo-spec DOES declare a deployment block", async () => {
    octokitRequest.mockImplementation(
      makeRouter({
        [`${OPERATOR_OWNER}/${OPERATOR_REPO}:infra/catalog/${SLUG}.yaml`]:
          CATALOG,
        [`${NODE_OWNER}/${NODE_REPO}:.cogni/repo-spec.yaml`]:
          REPO_SPEC_WITH_DEPLOYMENT,
        [`${OPERATOR_OWNER}/${OPERATOR_REPO}:infra/k8s/argocd/appsets/${ENV}/kustomization.yaml`]:
          KUSTOMIZATION,
      })
    );
    const writer = new GitHubRepoWriter({ appId: "1", privateKey: "key" });

    // The catalog already places `preview` on akash with no lingering k3s residue (the overlay/
    // external-secret/appset probes 404), so buildPlacementPlan resolves `no_changes` — proving the
    // deployment-block gate did NOT fire, without needing to mock the full commit/PR write path.
    await expect(
      writer.openNodePlacementPr({
        owner: OPERATOR_OWNER,
        repo: OPERATOR_REPO,
        slug: SLUG,
        env: ENV,
        placement: "akash",
      })
    ).resolves.toEqual({ status: "no_changes" });
  });
});
