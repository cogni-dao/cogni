// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/catalog-registry-reconcile-backoff`
 * Purpose: A permanently failing catalog reconcile must back off, not retry every 15 seconds (bug.5596).
 * Side-effects: none
 * Links: src/bootstrap/catalog-registry-reconcile.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import { nextRetryDelayMs } from "@/bootstrap/catalog-registry-reconcile";

describe("nextRetryDelayMs", () => {
  it("starts fast, doubles, and caps at the ten-minute poll cadence", () => {
    expect([1, 2, 3, 4].map(nextRetryDelayMs)).toEqual([
      15_000, 30_000, 60_000, 120_000,
    ]);
    expect(nextRetryDelayMs(7)).toBe(600_000);
    expect(nextRetryDelayMs(1000)).toBe(600_000);
  });

  it("never returns less than the first retry delay", () => {
    expect(nextRetryDelayMs(0)).toBe(15_000);
  });
});
