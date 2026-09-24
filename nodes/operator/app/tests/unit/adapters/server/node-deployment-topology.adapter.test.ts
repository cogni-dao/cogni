// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Display-safe topology reads from the exact deploy branch Argo consumes. */

import { describe, expect, it, vi } from "vitest";

import {
  GitHubNodeDeploymentTopologyAdapter,
  PublicGitHubNodeDeploymentFileReader,
} from "@/adapters/server";

const POLY_DEPLOYMENT = `
apiVersion: compute.cogni.io/v1alpha1
kind: XComputeWorkload
spec:
  workload:
    services:
      - name: app
        visibility: public
        port: 3200
        secretRefs:
          - key: DATABASE_URL
      - name: paper-trader
        visibility: private
        port: 9100
`;

const OPERATOR_KUSTOMIZATION = `
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../../base/node-app
  - ../../../base/openfga-external
`;

describe("GitHubNodeDeploymentTopologyAdapter", () => {
  it("returns only service names and visibility from Poly's candidate deploy state", async () => {
    const fetchFileText = vi.fn().mockResolvedValue(POLY_DEPLOYMENT);
    const adapter = new GitHubNodeDeploymentTopologyAdapter(
      { fetchFileText },
      { owner: "cogni-dao", repo: "cogni" }
    );

    const result = await adapter.listServices({
      slug: "poly",
      environment: "candidate-a",
    });
    expect(result).toEqual([
      { name: "app", visibility: "public" },
      { name: "paper-trader", visibility: "private" },
    ]);
    expect(fetchFileText).toHaveBeenCalledExactlyOnceWith({
      owner: "cogni-dao",
      repo: "cogni",
      path: "infra/k8s/overlays/candidate-a/poly/xcomputeworkload.yaml",
      ref: "deploy/candidate-a-poly",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /DATABASE_URL|cpu|memory|storage|port/
    );
  });

  it("fails locally when the repo-spec is absent", async () => {
    const adapter = new GitHubNodeDeploymentTopologyAdapter(
      { fetchFileText: vi.fn().mockResolvedValue(null) },
      { owner: "cogni-test-org", repo: "cogni-monorepo" }
    );

    await expect(
      adapter.listServices({ slug: "missing", environment: "candidate-a" })
    ).rejects.toThrow("deployed service topology is unavailable");
  });

  it("projects the standard app from an exact k3s deploy branch", async () => {
    const fetchFileText = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(OPERATOR_KUSTOMIZATION);
    const adapter = new GitHubNodeDeploymentTopologyAdapter(
      { fetchFileText },
      { owner: "cogni-dao", repo: "cogni" }
    );

    await expect(
      adapter.listServices({ slug: "operator", environment: "candidate-a" })
    ).resolves.toEqual([{ name: "app", visibility: "public" }]);
    expect(fetchFileText).toHaveBeenNthCalledWith(2, {
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
      .mockResolvedValue(new Response(POLY_DEPLOYMENT, { status: 200 }));
    const reader = new PublicGitHubNodeDeploymentFileReader(fetchImpl);

    await expect(
      reader.fetchFileText({
        owner: "cogni-dao",
        repo: "cogni",
        path: "infra/k8s/overlays/candidate-a/poly/xcomputeworkload.yaml",
        ref: "deploy/candidate-a-poly",
      })
    ).resolves.toBe(POLY_DEPLOYMENT);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "https://raw.githubusercontent.com/cogni-dao/cogni/refs/heads/deploy/candidate-a-poly/infra/k8s/overlays/candidate-a/poly/xcomputeworkload.yaml",
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
        path: "infra/k8s/overlays/candidate-a/missing/xcomputeworkload.yaml",
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
