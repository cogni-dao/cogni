// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Display-safe topology reads from the exact deploy branch Argo consumes. */

import { describe, expect, it, vi } from "vitest";

import { GitHubNodeDeploymentTopologyAdapter } from "@/adapters/server";

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

describe("GitHubNodeDeploymentTopologyAdapter", () => {
  it("returns only service names and visibility from Poly's candidate deploy state", async () => {
    const fetchFileText = vi.fn().mockResolvedValue(POLY_DEPLOYMENT);
    const adapter = new GitHubNodeDeploymentTopologyAdapter(
      { fetchFileText },
      { owner: "cogni-test-org", repo: "cogni-monorepo" }
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
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
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
