// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { resolveNodeRequiredPlacement } from "./node-required-placement";

describe("resolveNodeRequiredPlacement", () => {
  /**
   * ABSENT_IS_UNCONSTRAINED. Every existing catalog row omits this cell, so the omission must
   * resolve to "no requirement" — the exact behaviour the fleet runs under today. If this ever
   * resolved to a non-empty set, the consumer's fail-closed filter would refuse every bid and
   * the node would present as "no provider bid", not as a policy change.
   */
  it("resolves an absent cell to no requirement", () => {
    expect(
      resolveNodeRequiredPlacement({
        catalog: { name: "beacon" },
        environment: "production",
      })
    ).toEqual([]);
    expect(
      resolveNodeRequiredPlacement({
        catalog: { required_placement_countries: { "candidate-a": ["PT"] } },
        environment: "production",
      })
    ).toEqual([]);
  });

  it("resolves each environment independently", () => {
    const catalog = {
      required_placement_countries: {
        "candidate-a": ["PT", "NL"],
        production: ["PT"],
      },
    };
    expect(
      resolveNodeRequiredPlacement({ catalog, environment: "candidate-a" })
    ).toEqual(["PT", "NL"]);
    expect(
      resolveNodeRequiredPlacement({ catalog, environment: "production" })
    ).toEqual(["PT"]);
    expect(
      resolveNodeRequiredPlacement({ catalog, environment: "preview" })
    ).toEqual([]);
  });

  /**
   * EMPTY_IS_A_TYPO_NOT_A_WILDCARD. `[]` must not parse. The consumer fails closed, so an
   * empty requirement refuses every bid — and that surfaces only as NO_ELIGIBLE_BIDS after a
   * full 90s bid window, which is the most expensive possible way to learn about a typo.
   */
  it("rejects an empty array rather than reading it as 'anywhere'", () => {
    expect(() =>
      resolveNodeRequiredPlacement({
        catalog: { required_placement_countries: { production: [] } },
        environment: "production",
      })
    ).toThrow(/Invalid catalog required_placement_countries/);
  });

  it.each([
    ["lowercase", ["pt"]],
    ["three letters", ["PRT"]],
    ["a whole country name", ["Portugal"]],
    ["a non-string", [42]],
    ["not an array", "PT"],
    ["duplicates", ["PT", "PT"]],
  ])("fails closed on %s", (_label, value) => {
    expect(() =>
      resolveNodeRequiredPlacement({
        catalog: { required_placement_countries: { production: value } },
        environment: "production",
      })
    ).toThrow(/Invalid catalog required_placement_countries/);
  });

  it("rejects an unknown environment key rather than ignoring a typo", () => {
    expect(() =>
      resolveNodeRequiredPlacement({
        catalog: { required_placement_countries: { prod: ["PT"] } },
        environment: "production",
      })
    ).toThrow(/Invalid catalog required_placement_countries/);
  });

  /** The cell is one row's policy; unrelated catalog keys must pass through untouched. */
  it("ignores the rest of the row", () => {
    expect(
      resolveNodeRequiredPlacement({
        catalog: {
          name: "poly",
          lease_generation: { production: 4 },
          required_placement_countries: { production: ["PT"] },
        },
        environment: "production",
      })
    ).toEqual(["PT"]);
  });
});
