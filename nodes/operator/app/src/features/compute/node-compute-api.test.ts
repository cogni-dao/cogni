// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import { CROSSPLANE_CONTROL_PLANE_ENVS } from "@/shared/node-registry/crossplane-control-plane";

import { resolveNodeComputeApi } from "./node-compute-api";

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
   * AUTHORITY_REQUIRES_AN_INSTALLED_API (task.5104). Crossplane is installed on candidate-a
   * ONLY — there is no `crossplane-*-application.yaml` under
   * infra/k8s/argocd/control-plane/{preview,production}/ — so `crossplane` is resolvable there
   * and nowhere else. Without this, a wizard-born row's production promote renders an
   * XComputeWorkload into a cluster where that CRD does not exist, and nothing reconciles it.
   */
  it("resolves crossplane only where a control plane is installed", () => {
    expect(CROSSPLANE_CONTROL_PLANE_ENVS).toEqual(["candidate-a"]);
    expect(
      resolveNodeComputeApi({
        catalog: { compute_api: { "candidate-a": "crossplane" } },
        environment: "candidate-a",
      })
    ).toBe("crossplane");

    for (const environment of ["preview", "production"] as const) {
      expect(() =>
        resolveNodeComputeApi({
          catalog: { compute_api: { [environment]: "crossplane" } },
          environment,
        })
      ).toThrow(
        `infra/k8s/argocd/control-plane/${environment}/crossplane-xcomputeworkload-application.yaml`
      );
    }
  });

  /**
   * NO_SILENT_DOWNGRADE. Degrading an un-installable `crossplane` cell to `legacy` would hand
   * the row to the retiring bespoke controller, whose Akash idempotence key is DISJOINT from
   * the Crossplane one — that buys a SECOND PAID LEASE rather than colliding safely. The guard
   * must throw, and the message must say why a fallback is not on the table.
   */
  it("throws rather than degrading an uninstallable authority to legacy", () => {
    let thrown: unknown;
    try {
      resolveNodeComputeApi({
        catalog: { compute_api: { production: "crossplane" } },
        environment: "production",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("SECOND PAID LEASE");
    expect((thrown as Error).message).toContain(
      "Refusing to fall back to 'legacy'"
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
