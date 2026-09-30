// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { resolveNodeBootRecovery } from "./node-boot-recovery";

describe("resolveNodeBootRecovery", () => {
  /**
   * HOLD_IS_DEFAULT. Every existing catalog row omits this cell, so the omission must resolve to
   * today's behaviour. If it ever defaulted to `auto`, every production lane in the fleet would
   * start CLOSING leases that fail to boot — turning a held forensic artifact into a paid retry
   * loop nobody asked for.
   */
  it("resolves an absent cell to hold", () => {
    expect(
      resolveNodeBootRecovery({
        catalog: { name: "poly" },
        environment: "production",
      })
    ).toBe("hold");
    expect(
      resolveNodeBootRecovery({
        catalog: { boot_recovery: { "candidate-a": "auto" } },
        environment: "production",
      })
    ).toBe("hold");
  });

  it("resolves each environment independently", () => {
    const catalog = { boot_recovery: { production: "auto", preview: "hold" } };
    expect(
      resolveNodeBootRecovery({ catalog, environment: "production" })
    ).toBe("auto");
    expect(resolveNodeBootRecovery({ catalog, environment: "preview" })).toBe(
      "hold"
    );
    expect(
      resolveNodeBootRecovery({ catalog, environment: "candidate-a" })
    ).toBe("hold");
  });

  it.each([
    ["unknown value", "Replace"],
    ["a boolean", true],
    ["capitalised", "Auto"],
  ])("fails closed on %s rather than guessing a posture", (_label, value) => {
    expect(() =>
      resolveNodeBootRecovery({
        catalog: { boot_recovery: { production: value } },
        environment: "production",
      })
    ).toThrow(/Invalid catalog boot_recovery/);
  });

  it("rejects an unknown environment key rather than ignoring a typo", () => {
    expect(() =>
      resolveNodeBootRecovery({
        catalog: { boot_recovery: { prod: "auto" } },
        environment: "production",
      })
    ).toThrow(/Invalid catalog boot_recovery/);
  });
});
