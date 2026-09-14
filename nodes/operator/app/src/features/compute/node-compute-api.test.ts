// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

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
});
