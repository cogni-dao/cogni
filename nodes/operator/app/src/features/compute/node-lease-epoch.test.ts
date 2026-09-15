// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { resolveNodeLeaseEpoch } from "./node-lease-epoch";

describe("resolveNodeLeaseEpoch", () => {
  /**
   * ZERO_IS_DEFAULT. Every row in infra/catalog today omits `lease_epoch`, so this is the
   * assertion that adding the field changed nothing for the running fleet: an absent cell
   * resolves to 0, the exact value every existing workload already runs under via the XRD
   * default. If this ever resolves nonzero, an idempotence key silently changes and a
   * promote mints a SECOND PAID LEASE.
   */
  it("resolves an absent field to zero, the epoch every workload already runs under", () => {
    expect(
      resolveNodeLeaseEpoch({
        catalog: { name: "beacon" },
        environment: "production",
      })
    ).toBe(0);
    expect(
      resolveNodeLeaseEpoch({
        catalog: { lease_epoch: { "candidate-a": 3 } },
        environment: "production",
      })
    ).toBe(0);
  });

  it("resolves each environment independently, so a replacement is per-(node, env) atomic", () => {
    const catalog = { lease_epoch: { "candidate-a": 2, production: 1 } };
    expect(resolveNodeLeaseEpoch({ catalog, environment: "candidate-a" })).toBe(
      2
    );
    expect(resolveNodeLeaseEpoch({ catalog, environment: "production" })).toBe(
      1
    );
    expect(resolveNodeLeaseEpoch({ catalog, environment: "preview" })).toBe(0);
  });

  /**
   * The epoch is the idempotence key's only varying component, so a value the XRD would
   * reject must fail closed HERE — a materialized manifest the API server bounces would
   * leave the deploy branch carrying desired state nothing can apply.
   */
  it("fails closed on a value outside the XRD's bounds", () => {
    for (const value of [-1, 1.5, 1000001, "2"]) {
      expect(() =>
        resolveNodeLeaseEpoch({
          catalog: { lease_epoch: { production: value } },
          environment: "production",
        })
      ).toThrow(/Invalid catalog lease_epoch/);
    }
  });

  it("rejects an unknown environment key rather than ignoring a typo", () => {
    expect(() =>
      resolveNodeLeaseEpoch({
        catalog: { lease_epoch: { canidate: 1 } },
        environment: "candidate-a",
      })
    ).toThrow(/Invalid catalog lease_epoch/);
  });

  it("accepts the XRD's exact bounds, including an explicit zero", () => {
    expect(
      resolveNodeLeaseEpoch({
        catalog: { lease_epoch: { production: 0 } },
        environment: "production",
      })
    ).toBe(0);
    expect(
      resolveNodeLeaseEpoch({
        catalog: { lease_epoch: { production: 1000000 } },
        environment: "production",
      })
    ).toBe(1000000);
  });
});
