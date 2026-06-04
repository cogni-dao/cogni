// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/scope-filters`
 * Purpose: Pin `insertScopeFilter` to a byte-exact before→after ci.yaml case.
 * Scope: Pure unit test — the golden mirrors `render-scope-filters.sh --write` output.
 * Invariants: BLOCK_IS_SSOT — 12-space indent, ASCII slug sort, per-node filter + negation.
 * Side-effects: none
 * Links: src/shared/node-app-scaffold/gens/scope-filters, scripts/ci/render-scope-filters.sh
 * @public
 */

import { describe, expect, it } from "vitest";

import { insertScopeFilter } from "./scope-filters";

// A minimal ci.yaml carrying the GENERATED sentinel block (canary/node-template/resy),
// surrounded by representative leading/trailing context the splice must leave untouched.
const BEFORE = `name: ci
jobs:
  scope:
    steps:
      - uses: dorny/paths-filter@v3
        with:
          filters: |
            # >>> GENERATED scope-filters (scripts/ci/render-scope-filters.sh) — DO NOT EDIT BY HAND
            canary:
              - 'nodes/canary/**'
            node-template:
              - 'nodes/node-template/**'
            resy:
              - 'nodes/resy/**'
            operator:
              - '**'
              - '!nodes/canary/**'
              - '!nodes/node-template/**'
              - '!nodes/resy/**'
            # <<< GENERATED scope-filters
  next-job:
    steps: []
`;

const AFTER_ZERG = `name: ci
jobs:
  scope:
    steps:
      - uses: dorny/paths-filter@v3
        with:
          filters: |
            # >>> GENERATED scope-filters (scripts/ci/render-scope-filters.sh) — DO NOT EDIT BY HAND
            canary:
              - 'nodes/canary/**'
            node-template:
              - 'nodes/node-template/**'
            resy:
              - 'nodes/resy/**'
            zerg:
              - 'nodes/zerg/**'
            operator:
              - '**'
              - '!nodes/canary/**'
              - '!nodes/node-template/**'
              - '!nodes/resy/**'
              - '!nodes/zerg/**'
            # <<< GENERATED scope-filters
  next-job:
    steps: []
`;

describe("insertScopeFilter", () => {
  it("splices a new node byte-exactly, ASCII-sorted, leaving context untouched", () => {
    expect(insertScopeFilter(BEFORE, "zerg")).toBe(AFTER_ZERG);
  });

  it("is idempotent when the slug is already present (Set dedupe)", () => {
    expect(insertScopeFilter(AFTER_ZERG, "zerg")).toBe(AFTER_ZERG);
  });

  it("inserts in ASCII order, not append order", () => {
    // 'aaa' sorts before the existing slugs; the negation list mirrors the order.
    const out = insertScopeFilter(BEFORE, "aaa");
    expect(out).toContain("            aaa:\n              - 'nodes/aaa/**'\n");
    expect(out.indexOf("aaa:")).toBeLessThan(out.indexOf("canary:"));
  });

  it("throws when the sentinels are missing", () => {
    expect(() => insertScopeFilter("name: ci\njobs: {}\n", "zerg")).toThrow(
      /sentinels/
    );
  });
});
