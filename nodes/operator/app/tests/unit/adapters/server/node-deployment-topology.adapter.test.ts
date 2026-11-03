// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Display-safe topology reads: node-deploy release view for nodes, exact k3s deploy branch for the operator. */

import { describe, expect, it, vi } from "vitest";

import {
  GitHubNodeDeploymentTopologyAdapter,
  PublicGitHubNodeDeploymentFileReader,
} from "@/adapters/server";

const PUBLIC_DECLARATION = "apiVersion: v1\nkind: ConfigMap\n";

const POLY_ID = "11111111-1111-4111-8111-111111111111";

function spec(name: string, http: boolean) {
  return {
    name,
    kind: http ? ("app" as const) : ("state" as const),
    image: `ghcr.io/cogni-dao/poly@sha256:${"a".repeat(64)}`,
    port: http ? 3200 : 5432,
    expose: http
      ? { http: { host: "poly.cognidao.org" } }
      : { tcp: { global: true as const } },
    cpu: 1,
    memoryMi: 512,
    storageMi: 512,
    env: { SECRET_HINT: "DATABASE_URL" },
    bindings: [],
  };
}

function releaseView() {
  const desired = [
    {
      nodeId: POLY_ID,
      env: "candidate-a",
      workload: "app",
      releaseId: "r-app",
    },
    { nodeId: POLY_ID, env: "candidate-a", workload: "db", releaseId: "r-db" },
    {
      nodeId: "other",
      env: "candidate-a",
      workload: "app",
      releaseId: "r-other",
    },
  ];
  const releases: Record<string, { spec: ReturnType<typeof spec> }> = {
    "r-app": { spec: spec("app", true) },
    "r-db": { spec: spec("db", false) },
    "r-other": { spec: spec("other-app", true) },
  };
  return {
    listDesired: vi.fn(async (env: string) =>
      desired.filter((row) => row.env === env)
    ),
    getRelease: vi.fn(async (id: string) => releases[id]),
  };
}

const OPERATOR_KUSTOMIZATION = `
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../../base/node-app
  - ../../../base/openfga-external
`;

describe("GitHubNodeDeploymentTopologyAdapter", () => {
  it("reads a node lane from the node-deploy release view, never a deploy branch (story.5137)", async () => {
    const fetchFileText = vi.fn();
    const view = releaseView();
    const adapter = new GitHubNodeDeploymentTopologyAdapter(
      { fetchFileText },
      { owner: "cogni-dao", repo: "cogni" },
      // biome-ignore lint/suspicious/noExplicitAny: test double for the store read half
      () => view as any
    );

    const result = await adapter.listServices({
      nodeId: POLY_ID,
      slug: "poly",
      environment: "candidate-a",
    });
    expect(result).toEqual([
      { name: "app", visibility: "public" },
      { name: "db", visibility: "private" },
    ]);
    expect(view.listDesired).toHaveBeenCalledExactlyOnceWith("candidate-a");
    expect(fetchFileText).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(
      /DATABASE_URL|cpu|memory|storage|port|sha256/
    );
  });

  it("a node lane with no desired release is unavailable, not a stale deploy-branch read", async () => {
    const fetchFileText = vi.fn();
    const view = releaseView();
    const adapter = new GitHubNodeDeploymentTopologyAdapter(
      { fetchFileText },
      { owner: "cogni-dao", repo: "cogni" },
      // biome-ignore lint/suspicious/noExplicitAny: test double for the store read half
      () => view as any
    );

    await expect(
      adapter.listServices({
        nodeId: POLY_ID,
        slug: "poly",
        environment: "production",
      })
    ).rejects.toThrow("deployed service topology is unavailable");
    expect(fetchFileText).not.toHaveBeenCalled();
  });

  it("a node lane without a release reader is unavailable", async () => {
    const fetchFileText = vi.fn();
    const adapter = new GitHubNodeDeploymentTopologyAdapter(
      { fetchFileText },
      { owner: "cogni-test-org", repo: "cogni-monorepo" }
    );

    await expect(
      adapter.listServices({
        nodeId: POLY_ID,
        slug: "missing",
        environment: "candidate-a",
      })
    ).rejects.toThrow("deployed service topology is unavailable");
    expect(fetchFileText).not.toHaveBeenCalled();
  });

  it("projects the standard app from an exact k3s deploy branch", async () => {
    const fetchFileText = vi.fn().mockResolvedValue(OPERATOR_KUSTOMIZATION);
    const adapter = new GitHubNodeDeploymentTopologyAdapter(
      { fetchFileText },
      { owner: "cogni-dao", repo: "cogni" }
    );

    await expect(
      adapter.listServices({
        nodeId: "operator-id",
        slug: "operator",
        environment: "candidate-a",
      })
    ).resolves.toEqual([{ name: "app", visibility: "public" }]);
    expect(fetchFileText).toHaveBeenCalledExactlyOnceWith({
      owner: "cogni-dao",
      repo: "cogni",
      path: "infra/k8s/overlays/candidate-a/operator/kustomization.yaml",
      ref: "deploy/candidate-a-operator",
    });
  });

  it("rejects a non-slug path before reading Git", async () => {
    const fetchFileText = vi.fn();
    const adapter = new GitHubNodeDeploymentTopologyAdapter(
      { fetchFileText },
      { owner: "cogni-test-org", repo: "cogni-monorepo" }
    );

    await expect(
      adapter.listServices({
        nodeId: POLY_ID,
        slug: "../private",
        environment: "candidate-a",
      })
    ).rejects.toThrow();
    expect(fetchFileText).not.toHaveBeenCalled();
  });
});

describe("PublicGitHubNodeDeploymentFileReader", () => {
  it("reads a slash-named deploy branch from the public reproducibility surface", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(PUBLIC_DECLARATION, { status: 200 }));
    const reader = new PublicGitHubNodeDeploymentFileReader(fetchImpl);

    await expect(
      reader.fetchFileText({
        owner: "cogni-dao",
        repo: "cogni",
        path: "infra/k8s/overlays/candidate-a/operator/kustomization.yaml",
        ref: "deploy/candidate-a-operator",
      })
    ).resolves.toBe(PUBLIC_DECLARATION);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "https://raw.githubusercontent.com/cogni-dao/cogni/refs/heads/deploy/candidate-a-operator/infra/k8s/overlays/candidate-a/operator/kustomization.yaml",
      expect.objectContaining({ cache: "no-store", redirect: "error" })
    );
  });

  it("maps a missing public declaration to null", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const reader = new PublicGitHubNodeDeploymentFileReader(fetchImpl);

    await expect(
      reader.fetchFileText({
        owner: "cogni-dao",
        repo: "cogni",
        path: "infra/k8s/overlays/candidate-a/missing/kustomization.yaml",
        ref: "deploy/candidate-a-missing",
      })
    ).resolves.toBeNull();
  });

  it("rejects traversal before making a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const reader = new PublicGitHubNodeDeploymentFileReader(fetchImpl);

    await expect(
      reader.fetchFileText({
        owner: "cogni-dao",
        repo: "cogni",
        path: "../private",
        ref: "main",
      })
    ).rejects.toThrow("invalid GitHub file path");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
