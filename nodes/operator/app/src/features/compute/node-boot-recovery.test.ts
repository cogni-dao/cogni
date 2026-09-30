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

  /**
   * CONSTRAINED_PLACEMENT_IMPLIES_AUTO_SEARCH — the whole reason poly needs no third change.
   * A row that narrowed its provider pool gets automatic provider search DERIVED, because a
   * second separate opt-in is one a node can forget, and forgetting it is indistinguishable
   * from the bug it prevents (bug.5325).
   */
  it("derives auto for a row that constrained its placement", () => {
    expect(
      resolveNodeBootRecovery({
        catalog: { required_placement_countries: { production: ["PT", "RO"] } },
        environment: "production",
      })
    ).toBe("auto");
    // Per-env: an unconstrained env on the SAME row stays hold.
    expect(
      resolveNodeBootRecovery({
        catalog: { required_placement_countries: { production: ["PT"] } },
        environment: "preview",
      })
    ).toBe("hold");
  });

  /** An explicit cell still wins, so a constrained row can keep forensics if it wants. */
  it("lets an explicit hold override the derivation", () => {
    expect(
      resolveNodeBootRecovery({
        catalog: {
          required_placement_countries: { production: ["PT"] },
          boot_recovery: { production: "hold" },
        },
        environment: "production",
      })
    ).toBe("hold");
  });

  /** The probe must not become a second validator of a field another module owns. */
  it("treats an unreadable placement cell as unconstrained rather than throwing", () => {
    expect(
      resolveNodeBootRecovery({
        catalog: { required_placement_countries: { production: "PT" } },
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
