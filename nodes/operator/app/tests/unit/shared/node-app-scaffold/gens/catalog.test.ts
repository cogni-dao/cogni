// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderCatalog } from "@/shared/node-app-scaffold/gens/catalog";

describe("renderCatalog", () => {
  const ownerWallet = "0x070075F1389Ae1182aBac722B36CA12285d0c949";

  it("renders inline node catalog without submodule source metadata", () => {
    const out = renderCatalog("acme", 3200, 30400, { ownerWallet });
    expect(out).toContain("name: acme\n");
    expect(out).not.toContain("source_repo:");
    expect(out).not.toContain("image_repository:");
    expect(out).toContain("envs: [candidate-a, production]\n");
    expect(out).toContain("activity_env: production\n");
    expect(out).toContain(`owner_wallet: "${ownerWallet}"\n`);
    // AKASH_NEEDS_BUILD_PLANE — an in-repo row has no external artifact lineage, and the
    // catalog schema gates both keys on `source_repo`. Emitting them here would render a row
    // the schema rejects, so this arm stays on the pre-existing default.
    expect(out).not.toContain("deployment_provider:");
    expect(out).not.toContain("compute_api:");
  });

  it("renders submodule source metadata for child image resolution", () => {
    const out = renderCatalog("ay", 3200, 30400, {
      ownerWallet,
      sourceRepo: "https://github.com/cogni-test-org/ay.git",
    });

    expect(out).toContain(
      "source_repo: https://github.com/cogni-test-org/ay.git\n"
    );
    expect(out).toContain("image_repository: ghcr.io/cogni-test-org/ay\n");
  });

  it("derives child image repositories from the full source repo name", () => {
    const out = renderCatalog("ay", 3200, 30400, {
      ownerWallet,
      sourceRepo: "https://github.com/Cogni-Test-Org/ay.node.git",
    });

    expect(out).toContain("image_repository: ghcr.io/cogni-test-org/ay.node\n");
  });

  /**
   * BORN_ON_AKASH + BORN_PRODUCTION (story.5025). A Spawn is always a fork, so this is the
   * shape every real birth gets: the transient candidate-a proof slot plus canonical
   * production, both off-cluster, both reconciled by Crossplane, with PRODUCTION holding the
   * generation-1 activity authority. Preview is absent — a birth must not buy a third lease.
   */
  it("mints a wizard birth on Akash via Crossplane, production-authoritative, no preview", () => {
    const out = renderCatalog("ay", 3200, 30400, {
      ownerWallet,
      sourceRepo: "https://github.com/cogni-test-org/ay.git",
      nodeId: "72aa130b-f0ad-495a-a061-9ee1f9c9525d",
    });
    const row = parse(out) as Record<string, unknown>;

    expect(row.envs).toEqual(["candidate-a", "production"]);
    expect(row.envs).not.toContain("preview");
    expect(row.activity_env).toBe("production");
    expect(row.deployment_provider).toEqual({
      "candidate-a": "akash",
      production: "akash",
    });
    expect(row.compute_api).toEqual({
      "candidate-a": "crossplane",
      production: "crossplane",
    });
  });

  /**
   * ONE_AUTHORITY_PER_WORKLOAD at birth: placement and authority are declared for exactly the
   * environments the node is born into. A cell for an env that is not in `envs` would be an
   * authority pointed at a workload that does not exist.
   */
  it("declares placement and authority for exactly the environments it is born into", () => {
    const row = parse(
      renderCatalog("ay", 3200, 30400, {
        ownerWallet,
        sourceRepo: "https://github.com/cogni-test-org/ay.git",
      })
    ) as Record<string, Record<string, string>>;

    expect(Object.keys(row.deployment_provider ?? {}).sort()).toEqual(
      [...(row.envs as unknown as string[])].sort()
    );
    expect(Object.keys(row.compute_api ?? {}).sort()).toEqual(
      [...(row.envs as unknown as string[])].sort()
    );
  });
});
