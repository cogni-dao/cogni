// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  CROSSPLANE_CONTROL_PLANE_ENVS,
  crossplaneCompositeApplicationPath,
  hasCrossplaneControlPlane,
} from "@/shared/node-registry/crossplane-control-plane";

import { resolveNodeComputeApi } from "./node-compute-api";
import { deploymentEnvironmentSchema } from "./node-deployment-provider";

describe("resolveNodeComputeApi", () => {
  /**
   * LEGACY_IS_DEFAULT. Every row in infra/catalog today omits `compute_api`, so this is the
   * assertion that adding the field changed nothing for the running fleet. If this ever flips
   * to `crossplane`, twelve existing workloads silently change reconciliation authority.
   */
  it("resolves an absent field to the pre-existing bespoke controller", () => {
    expect(
      resolveNodeComputeApi({
        catalog: { name: "beacon" },
        environment: "production",
      })
    ).toBe("legacy");
    expect(
      resolveNodeComputeApi({
        catalog: { compute_api: { "candidate-a": "crossplane" } },
        environment: "production",
      })
    ).toBe("legacy");
  });

  it("resolves each environment independently, so a cutover is per-(node, env) atomic", () => {
    const catalog = {
      compute_api: { "candidate-a": "crossplane", production: "legacy" },
    };
    expect(resolveNodeComputeApi({ catalog, environment: "candidate-a" })).toBe(
      "crossplane"
    );
    expect(resolveNodeComputeApi({ catalog, environment: "production" })).toBe(
      "legacy"
    );
  });

  /**
   * The value is single-valued by type, so "both authorities" is unrepresentable rather than
   * merely discouraged — an unknown string fails closed instead of being coerced to a default.
   */
  it("fails closed on an unknown authority instead of silently defaulting", () => {
    expect(() =>
      resolveNodeComputeApi({
        catalog: { compute_api: { production: "kubernetes" } },
        environment: "production",
      })
    ).toThrow(/Invalid catalog compute_api/);
  });

  it("rejects an unknown environment key rather than ignoring a typo", () => {
    expect(() =>
      resolveNodeComputeApi({
        catalog: { compute_api: { canidate: "crossplane" } },
        environment: "candidate-a",
      })
    ).toThrow(/Invalid catalog compute_api/);
  });

  /**
   * AUTHORITY_REQUIRES_AN_INSTALLED_API (task.5104). `crossplane` is resolvable exactly where a
   * `crossplane-xcomputeworkload-application.yaml` exists under
   * infra/k8s/argocd/control-plane/<env>/ — task.5097 staged that for preview and production, so
   * all three now resolve. Without this guard, a row naming an env with no control plane renders
   * an XComputeWorkload into a cluster where that CRD does not exist, reconciled by nobody.
   *
   * RESOLVABLE IS NOT SELECTED. Widening the constant did not flip a single row: the selector is
   * the per-row `compute_api.<env>` cell, and the very first test above proves an absent cell
   * still resolves `legacy` in every environment.
   */
  it("resolves crossplane in every environment whose control plane is installed", () => {
    for (const environment of CROSSPLANE_CONTROL_PLANE_ENVS) {
      expect(
        resolveNodeComputeApi({
          catalog: { compute_api: { [environment]: "crossplane" } },
          environment,
        })
      ).toBe("crossplane");
    }
  });

  /**
   * NO_SILENT_DOWNGRADE, restated for the post-task.5097 world. The refusal in
   * `resolveNodeComputeApi` — throw, never degrade to `legacy`, because the two authorities mint
   * Akash leases under disjoint idempotence keys and a quiet downgrade buys a SECOND PAID LEASE —
   * is now UNREACHABLE from any catalog row, because every environment
   * `deploymentEnvironmentSchema` admits has a control plane. The test that used to drive it with
   * `{production: "crossplane"}` was therefore deleted rather than weakened: that input is now
   * legitimately `crossplane`, so the old assertion asserted the opposite of the truth.
   *
   * What replaces it is the invariant that MAKES it unreachable, plus proof the guard still fires
   * for an environment outside the set. If a fourth environment is ever added to the schema, this
   * is the assertion that breaks first — before a row can render a composite nothing reconciles.
   */
  it("keeps the refusal armed for an environment with no control plane", () => {
    for (const environment of deploymentEnvironmentSchema.options) {
      expect(hasCrossplaneControlPlane(environment), environment).toBe(true);
    }
    expect(hasCrossplaneControlPlane("canary")).toBe(false);
    expect(crossplaneCompositeApplicationPath("canary")).toBe(
      "infra/k8s/argocd/control-plane/canary/crossplane-xcomputeworkload-application.yaml"
    );
  });

  /**
   * The guard is scoped to the `crossplane` VALUE, not to the environment: an env with no
   * control plane still resolves `legacy` normally, so every un-migrated fleet row is
   * untouched by this change.
   */
  it("leaves an explicit legacy cell resolvable in every environment", () => {
    for (const environment of [
      "candidate-a",
      "preview",
      "production",
    ] as const) {
      expect(
        resolveNodeComputeApi({
          catalog: { compute_api: { [environment]: "legacy" } },
          environment,
        })
      ).toBe("legacy");
    }
  });
});
