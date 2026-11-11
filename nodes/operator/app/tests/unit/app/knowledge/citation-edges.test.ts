// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge/citation-edges`
 * Purpose: Prove the contribution diff route lists every changed citation edge, with the
 *   citing side's label, from the workspace store's `citation_*` rows.
 * Scope: Pure adapter over diff rows. Does not use a database or network.
 * Invariants: EVERY_DIFF_EDGE_LISTED, CITATION_DIFF_FOR_REVIEW.
 * Side-effects: none
 * Links: bug.0011
 * @internal
 */

import type { ContributionDiffEntry } from "@cogni/node-contracts";
import { describeCitation } from "@cogni/shared-knowledge-store";
import { describe, expect, it } from "vitest";

import { citationEdgesFromDiff } from "@/app/api/v1/knowledge/contributions/_citation-edges";

const edge = (
  changeType: "citation_added" | "citation_removed",
  citingId: string,
  citedId: string,
  citationType = "supports"
): ContributionDiffEntry => {
  const side = { citingId, citedId, citationType };
  return {
    changeType,
    rowId: `${citingId}-${citedId}`,
    before: changeType === "citation_removed" ? side : null,
    after: changeType === "citation_added" ? side : null,
  };
};

describe("citationEdgesFromDiff", () => {
  it("maps added and removed edges, ordered by citing, type, then cited", () => {
    const edges = citationEdgesFromDiff([
      edge("citation_removed", "b-entry", "z-entry"),
      edge("citation_added", "a-entry", "y-entry", "extends"),
      edge("citation_added", "a-entry", "x-entry"),
    ]);
    expect(
      edges.map((e) => [e.changeType, e.citingId, e.citationType, e.citedId])
    ).toEqual([
      ["added", "a-entry", "extends", "y-entry"],
      ["added", "a-entry", "supports", "x-entry"],
      ["removed", "b-entry", "supports", "z-entry"],
    ]);
  });

  it("reads the citing side's label and tone from the citation definition", () => {
    const [only] = citationEdgesFromDiff([
      edge("citation_added", "a-entry", "b-entry"),
    ]);
    expect(only).toMatchObject({
      ...describeCitation("supports", "out"),
      context: null,
    });
  });

  it("ignores entry rows", () => {
    expect(
      citationEdgesFromDiff([
        { changeType: "added", rowId: "e", before: null, after: { id: "e" } },
      ])
    ).toEqual([]);
  });

  it("throws on a malformed edge row instead of dropping the link", () => {
    expect(() =>
      citationEdgesFromDiff([
        {
          changeType: "citation_added",
          rowId: "bad",
          before: null,
          after: { citingId: "a-entry" },
        },
      ])
    ).toThrow(/malformed citation diff row bad/);
  });
});
