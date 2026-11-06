// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/contracts/compute.akash-tx.exclude-providers`
 * Purpose: `excludeProviders` on the actuator v1 create wire is OPTIONAL and strict: absent parses to
 *   exactly the old shape; present must be <=16 bech32 `akash1` accounts (task.5400).
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";

import { AkashTxCreateInputSchema } from "@/contracts/compute.akash-tx.v1.contract";

const BLUE = "akash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const base = {
  cogniKey: "nd:ns:node:canary:rel:1",
  environment: "production",
  identity: {
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    compositeUid: "nd-rel",
    compositeGeneration: 1,
  },
  spec: {
    name: "canary",
    services: [
      {
        name: "canary",
        image: `x@sha256:${"a".repeat(64)}`,
        cpuUnits: 0.25,
        memoryMi: 256,
        storageMi: 256,
      },
    ],
  },
};

describe("AkashTxCreateInputSchema.excludeProviders", () => {
  it("absent: parses, and the parsed value has no excludeProviders key (old wire unchanged)", () => {
    const parsed = AkashTxCreateInputSchema.parse(base);
    expect("excludeProviders" in parsed).toBe(false);
  });

  it("present: parses and round-trips", () => {
    expect(
      AkashTxCreateInputSchema.parse({ ...base, excludeProviders: [BLUE] })
        .excludeProviders
    ).toEqual([BLUE]);
    expect(
      AkashTxCreateInputSchema.parse({ ...base, excludeProviders: [] })
        .excludeProviders
    ).toEqual([]);
  });

  it("invalid: malformed address, uppercase, wrong length, >16 entries, non-array", () => {
    const bad = [
      ["nope"],
      [BLUE.toUpperCase()],
      [`${BLUE}q`],
      [BLUE.slice(0, -1)],
      Array.from({ length: 17 }, () => BLUE),
      BLUE,
    ];
    for (const excludeProviders of bad)
      expect(
        AkashTxCreateInputSchema.safeParse({ ...base, excludeProviders })
          .success
      ).toBe(false);
    expect(
      AkashTxCreateInputSchema.safeParse({
        ...base,
        excludeProviders: Array.from({ length: 16 }, () => BLUE),
      }).success
    ).toBe(true);
  });

  it("stays strict: other unknown keys are still refused", () => {
    expect(
      AkashTxCreateInputSchema.safeParse({ ...base, excludeProvider: [BLUE] })
        .success
    ).toBe(false);
  });
});
