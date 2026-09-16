// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { resolveNodeLeaseGeneration } from "./node-lease-generation";

describe("resolveNodeLeaseGeneration", () => {
  /**
   * ZERO_IS_DEFAULT. Every row in infra/catalog today omits `lease_generation`, so this is the
   * assertion that adding the field changed nothing for the running fleet: an absent cell
   * resolves to 0, the exact value every existing workload already runs under via the XRD
   * default. If this ever resolves nonzero, an idempotence key silently changes and a
   * promote mints a SECOND PAID LEASE.
   */
  it("resolves an absent field to zero, the generation every workload already runs under", () => {
    expect(
      resolveNodeLeaseGeneration({
        catalog: { name: "beacon" },
        environment: "production",
      })
    ).toBe(0);
    expect(
      resolveNodeLeaseGeneration({
        catalog: { lease_generation: { "candidate-a": 3 } },
        environment: "production",
      })
    ).toBe(0);
  });

  it("resolves each environment independently, so a replacement is per-(node, env) atomic", () => {
    const catalog = { lease_generation: { "candidate-a": 2, production: 1 } };
    expect(
      resolveNodeLeaseGeneration({ catalog, environment: "candidate-a" })
    ).toBe(2);
    expect(
      resolveNodeLeaseGeneration({ catalog, environment: "production" })
    ).toBe(1);
    expect(
      resolveNodeLeaseGeneration({ catalog, environment: "preview" })
    ).toBe(0);
  });

  /**
   * The generation is the idempotence key's only varying component, so a value the XRD would
   * reject must fail closed HERE — a materialized manifest the API server bounces would
   * leave the deploy branch carrying desired state nothing can apply.
   */
  it("fails closed on a value outside the XRD's bounds", () => {
    for (const value of [-1, 1.5, 1000001, "2"]) {
      expect(() =>
        resolveNodeLeaseGeneration({
          catalog: { lease_generation: { production: value } },
          environment: "production",
        })
      ).toThrow(/Invalid catalog lease_generation/);
    }
  });

  it("rejects an unknown environment key rather than ignoring a typo", () => {
    expect(() =>
      resolveNodeLeaseGeneration({
        catalog: { lease_generation: { canidate: 1 } },
        environment: "candidate-a",
      })
    ).toThrow(/Invalid catalog lease_generation/);
  });

  it("accepts the XRD's exact bounds, including an explicit zero", () => {
    expect(
      resolveNodeLeaseGeneration({
        catalog: { lease_generation: { production: 0 } },
        environment: "production",
      })
    ).toBe(0);
    expect(
      resolveNodeLeaseGeneration({
        catalog: { lease_generation: { production: 1000000 } },
        environment: "production",
      })
    ).toBe(1000000);
  });
});
