// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/work-item-scores`
 * Purpose: Verify operator adoption accepts external Justification links without host configuration.
 * Scope: Released score parser conformance; no network or database.
 * Invariants: SOURCES_ARE_UNRESTRICTED; SAFE_HTTPS_BOUNDS_REMAIN.
 * Side-effects: none
 * Links: hub adopt-node-package-release, story.5111
 * @internal
 */
import { parseWorkItemScores } from "@cogni/work-items";
import { describe, expect, it } from "vitest";

describe("operator shared evaluation adoption", () => {
  it("accepts a future external HTTPS source without configuration", () => {
    const scores = { goal: { v: 5, ev: "https://future.example/research" } };
    expect(parseWorkItemScores(scores)).toEqual({ ok: true, value: scores });
  });
  it("retains required justification and credential URL rejection", () => {
    expect(parseWorkItemScores({ goal: { v: 5 } }).ok).toBe(false);
    expect(
      parseWorkItemScores({
        goal: { v: 5, ev: "https://user:pass@example.com/x" },
      }).ok
    ).toBe(false);
  });
});
