// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderCatalog } from "@/shared/node-app-scaffold/gens/catalog";
import {
  CROSSPLANE_ACTUATOR_WALLET_ENVS,
  CROSSPLANE_CONTROL_PLANE_ENVS,
  canBirthOnCrossplane,
} from "@/shared/node-registry/crossplane-control-plane";

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
   * production, both off-cluster, with PRODUCTION holding the generation-1 activity authority.
   * Preview is absent from the BIRTH ENVIRONMENT set — a birth must not buy a third lease.
   *
   * AUTHORITY_REQUIRES_AN_INSTALLED_API (task.5104) + INSTALLED_IS_NOT_FUNDED (task.5097):
   * candidate-a AND production are declared `crossplane` because they are the two birth envs
   * and both carry a control plane plus a pinned actuator account. Preview keeps an installed
   * but UNFUNDED control plane — it pins no wallet, so it can never buy a lease; a single active
   * writer per test wallet (story.5016). It is also absent from `NODE_FORMATION_ENVS`.
   *
   * PRODUCTION_GOVERNS_SPAWN (Derek, story.5016): a birth's canonical slot is production on the
   * Crossplane rail from generation 1 — never "candidate-a first, then a faked catalog cutover".
   */
  it("mints a wizard birth on Akash, crossplane only where a wallet is pinned", () => {
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
    // Both facts hold for production: installed control plane AND pinned dedicated wallet.
    expect(CROSSPLANE_CONTROL_PLANE_ENVS).toContain("production");
    expect(CROSSPLANE_ACTUATOR_WALLET_ENVS).toContain("production");
    // Preview installs the composite API (dormant control plane) but pins NO wallet, so it can
    // never buy a lease — a single active writer per test wallet (story.5016).
    expect(CROSSPLANE_CONTROL_PLANE_ENVS).toContain("preview");
    expect(CROSSPLANE_ACTUATOR_WALLET_ENVS).not.toContain("preview");
  });

  /**
   * PLACEMENT_AND_AUTHORITY_ARE_DIFFERENT_AXES (task.5104). Placement is declared for exactly
   * the environments the node is born into — every birth env is genuinely off-cluster. Compute
   * authority is a strict SUBSET of those: it may only name an environment that can BOTH
   * reconcile the composite (installed control plane) and pay for its lease (pinned actuator
   * wallet), and an omitted env is `legacy` rather than unreconciled. A `compute_api` cell for
   * an env outside `envs` would still be an authority pointed at a workload that does not exist,
   * so the subset relation is asserted in both directions.
   */
  it("declares placement for every birth env and authority only where it is payable", () => {
    const row = parse(
      renderCatalog("ay", 3200, 30400, {
        ownerWallet,
        sourceRepo: "https://github.com/cogni-test-org/ay.git",
      })
    ) as Record<string, Record<string, string>>;
    const birthEnvs = [...(row.envs as unknown as string[])].sort();

    expect(Object.keys(row.deployment_provider ?? {}).sort()).toEqual(
      birthEnvs
    );

    const authorityEnvs = Object.keys(row.compute_api ?? {}).sort();
    expect(authorityEnvs.length).toBeGreaterThan(0);
    expect(authorityEnvs).toEqual(birthEnvs.filter(canBirthOnCrossplane));
    for (const env of authorityEnvs) {
      expect(birthEnvs).toContain(env);
    }
  });
});
