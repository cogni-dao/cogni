// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/governing`
 * Purpose: The one definition of "governing guidance" — the hub rows an agent designs, builds and reviews against — and the pure selector that turns hub rows into the governing index.
 * Scope: Pure predicate + selection + row shape. Does not perform I/O; the SQL reads live in each adapter's `listGoverningIndex`.
 * Invariants:
 *   - GOVERNING_SET_DEFINED_ONCE: a row is governing iff its entryType is in
 *     `GOVERNING_ENTRY_TYPES`, it has a non-blank useWhen, and it is not the
 *     target of a `supersedes` edge. No other module defines this set.
 *   - NO_USEWHEN_NO_ROUTE: a row without a useWhen has not stated its
 *     situation, so it never routes.
 *   - SUPERSEDED_EXCLUDED: a row cited by an inbound `supersedes` edge is
 *     retired and never routes.
 *   - INDEX_CARRIES_NO_CONTENT: index rows carry id, domain, entryType and
 *     useWhen — never title or body.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/guidance-routing-design
 * @public
 */

/**
 * Entry types an agent designs, builds and reviews against. Findings,
 * observations, hypotheses, scorecards and `html` are evidence or human views,
 * not instructions, so they never route.
 */
export const GOVERNING_ENTRY_TYPES = [
  "skill",
  "guide",
  "playbook",
  "rule",
  "design",
  "decision",
  "reference",
] as const;
export type GoverningEntryType = (typeof GOVERNING_ENTRY_TYPES)[number];

const GOVERNING_TYPE_SET: ReadonlySet<string> = new Set(GOVERNING_ENTRY_TYPES);

/** True when rows of this entry type can govern a task. */
export function isGoverningEntryType(
  entryType: string | null | undefined
): entryType is GoverningEntryType {
  return GOVERNING_TYPE_SET.has(entryType ?? "");
}

/** One governing index row: the routing metadata an agent selects from, never a body. */
export interface GoverningIndexRow {
  readonly id: string;
  readonly domain: string;
  readonly entryType: string;
  readonly useWhen: string;
}

/** The row fields governing selection needs; both adapters project to this. */
export interface GoverningCandidateRow {
  readonly id: string;
  readonly domain: string;
  readonly entryType?: string | null | undefined;
  readonly useWhen?: string | null | undefined;
}

/** The edge fields governing selection needs (inbound edges to a candidate). */
export interface GoverningCandidateEdge {
  readonly citedId: string;
  readonly citationType: string;
}

/**
 * Select the governing index from candidate rows and citation edges, sorted by
 * domain then id so every adapter returns identical rows for the same hub state.
 */
export function selectGoverningIndex(
  rows: readonly GoverningCandidateRow[],
  edges: readonly GoverningCandidateEdge[]
): GoverningIndexRow[] {
  const superseded = new Set(
    edges.filter((e) => e.citationType === "supersedes").map((e) => e.citedId)
  );
  const out: GoverningIndexRow[] = [];
  for (const r of rows) {
    if (!isGoverningEntryType(r.entryType)) continue;
    const useWhen = r.useWhen?.trim();
    if (!useWhen) continue;
    if (superseded.has(r.id)) continue;
    out.push({ id: r.id, domain: r.domain, entryType: r.entryType, useWhen });
  }
  return out.sort((a, b) =>
    a.domain === b.domain
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.domain < b.domain
        ? -1
        : 1
  );
}
