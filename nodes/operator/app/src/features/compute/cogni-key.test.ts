// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/cogni-key` (test)
 * Purpose: Pin GENERATION_IS_THE_GEN_COMPONENT — the flagship regression is a bounded-recovery
 *   key `xcw:ns:node:0:recover:2` parsing to generation 0 (the gen segment) and recoveryOrdinal 2,
 *   never generation 2. The old greedy `/^xcw:.+:(0|[1-9]\d*)$/` read it as generation 2 and would
 *   pin a live lease's derived generation to its ordinal (double-pay, LIVE_KEEPS_ITS_GENERATION).
 * Side-effects: none
 * Links: src/features/compute/cogni-key.ts, src/features/compute/lease-reactivation.ts
 * @public
 */

import { describe, expect, it } from "vitest";

import { parseCogniKey, RECOVERY_SUFFIX_PATTERN } from "./cogni-key";

const NODE = "f66b260b-4633-41e2-8711-b7c1b8449cc1";

describe("parseCogniKey", () => {
  it("parses a base key into its four segments", () => {
    expect(parseCogniKey(`xcw:cogni-production:${NODE}:5`)).toEqual({
      namespace: "cogni-production",
      nodeId: NODE,
      generation: 5,
      recoveryOrdinal: 0,
      baseKey: `xcw:cogni-production:${NODE}:5`,
    });
  });

  it("reads the generation from the base, NOT the recovery ordinal (double-pay regression)", () => {
    const parsed = parseCogniKey(`xcw:cogni-production:${NODE}:0:recover:2`);
    // The bug: a greedy suffix regex captured `2`. The generation is `0`.
    expect(parsed.generation).toBe(0);
    expect(parsed.recoveryOrdinal).toBe(2);
    // baseKey strips the recovery suffix, so it re-states the LIVE lease's key exactly.
    expect(parsed.baseKey).toBe(`xcw:cogni-production:${NODE}:0`);
  });

  it("keeps a two-digit generation whole under a recovery suffix", () => {
    expect(
      parseCogniKey(`xcw:cogni-preview:${NODE}:12:recover:3`).generation
    ).toBe(12);
  });

  it("treats a base key as recovery ordinal 0", () => {
    expect(
      parseCogniKey(`xcw:cogni-candidate-a:${NODE}:0`).recoveryOrdinal
    ).toBe(0);
  });

  it("throws on a key that is not the xcw grammar", () => {
    expect(() => parseCogniKey("akash-console:akash1abc")).toThrow(
      /invalid cogniKey/
    );
    expect(() => parseCogniKey(`xcw:cogni-production:${NODE}`)).toThrow(
      /invalid cogniKey/
    );
    expect(() => parseCogniKey(`xcw:cogni-production:${NODE}:01`)).toThrow(
      /invalid cogniKey/
    );
  });
});

describe("RECOVERY_SUFFIX_PATTERN", () => {
  it("matches only a trailing :recover:<n> suffix", () => {
    expect(
      RECOVERY_SUFFIX_PATTERN.test(`xcw:cogni-production:${NODE}:0:recover:2`)
    ).toBe(true);
    expect(RECOVERY_SUFFIX_PATTERN.test(`xcw:cogni-production:${NODE}:0`)).toBe(
      false
    );
  });
});
