// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/_citation-edges`
 * Purpose: Read the changed citation edges out of the operator's contribution diff
 *   so the inbox lists every link with the citing side's label and tone (bug.0011).
 * Scope: Pure adapter from the workspace store's `citation_added` / `citation_removed`
 *   rows to the published `ContributionCitationDiffEntry` shape. Does no IO and holds
 *   no relation wording; labels come from `describeCitation`.
 * Invariants: EVERY_DIFF_EDGE_LISTED (a malformed row throws, so the route errors
 *   visibly instead of dropping a link), CITATION_DIFF_FOR_REVIEW. The workspace diff
 *   does not report edge context or a re-contexted edge, so `context` is null and
 *   `modified` never appears until the operator reads `diffCitations` from the published store.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/knowledge-branch-design
 * @internal
 */

import type {
  ContributionCitationDiffEntry,
  ContributionDiffEntry,
} from "@cogni/node-contracts";
import { describeCitation } from "@cogni/shared-knowledge-store";

/** Edges from `citation_*` rows, ordered by citing entry, type, then cited entry. */
export function citationEdgesFromDiff(
  entries: readonly ContributionDiffEntry[]
): ContributionCitationDiffEntry[] {
  const edges: ContributionCitationDiffEntry[] = [];
  for (const entry of entries) {
    if (
      entry.changeType !== "citation_added" &&
      entry.changeType !== "citation_removed"
    ) {
      continue;
    }
    const edge = entry.after ?? entry.before;
    const citingId = edge?.citingId;
    const citedId = edge?.citedId;
    const citationType = edge?.citationType;
    if (
      typeof citingId !== "string" ||
      typeof citedId !== "string" ||
      typeof citationType !== "string"
    ) {
      // A link the reviewer cannot read is a failed diff, never a hidden edge.
      throw new Error(
        `malformed citation diff row ${entry.rowId}: citingId, citedId and citationType must be strings`
      );
    }
    edges.push({
      changeType: entry.changeType === "citation_added" ? "added" : "removed",
      citingId,
      citedId,
      citationType,
      context: null,
      ...describeCitation(citationType, "out"),
    });
  }
  return edges.sort(
    (a, b) =>
      a.citingId.localeCompare(b.citingId) ||
      a.citationType.localeCompare(b.citationType) ||
      a.citedId.localeCompare(b.citedId)
  );
}
