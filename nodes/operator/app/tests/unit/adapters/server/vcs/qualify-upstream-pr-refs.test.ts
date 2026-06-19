// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/unit/adapters/server/vcs/qualify-upstream-pr-refs`
 * Purpose: Unit-prove `qualifyUpstreamPrRefs` — qualify bare `#NN` in node-template commit
 *   subjects to the source repo so a fork's upstream-merge PR body does not mis-link `#NN`
 *   to the fork's own (closed/unrelated) PR.
 * Scope: Pure function, no IO.
 * Links: src/adapters/server/vcs/github-repo-write.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import { qualifyUpstreamPrRefs } from "@/adapters/server/vcs/github-repo-write";

const O = "cogni-dao";
const R = "node-template";

describe("qualifyUpstreamPrRefs", () => {
  it("qualifies a parenthesized trailing PR ref (the conventional-commit shape)", () => {
    expect(
      qualifyUpstreamPrRefs("feat(knowledge): 3D graph view (#43)", O, R)
    ).toBe("feat(knowledge): 3D graph view (cogni-dao/node-template#43)");
  });

  it("qualifies a ref at the start of the string", () => {
    expect(qualifyUpstreamPrRefs("#25 fixes the thing", O, R)).toBe(
      "cogni-dao/node-template#25 fixes the thing"
    );
  });

  it("qualifies every ref when several appear", () => {
    expect(qualifyUpstreamPrRefs("merge #1 and #2", O, R)).toBe(
      "merge cogni-dao/node-template#1 and cogni-dao/node-template#2"
    );
  });

  it("leaves an already-qualified ref untouched (no double-qualify)", () => {
    const s = "see cogni-dao/node-template#25 for context";
    expect(qualifyUpstreamPrRefs(s, O, R)).toBe(s);
  });

  it("does not touch text without a PR ref", () => {
    expect(qualifyUpstreamPrRefs("chore: bump deps", O, R)).toBe(
      "chore: bump deps"
    );
  });

  it("does not match a bare number with no leading hash", () => {
    expect(qualifyUpstreamPrRefs("rotate to v2 25 times", O, R)).toBe(
      "rotate to v2 25 times"
    );
  });
});
