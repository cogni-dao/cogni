// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/repo-index`
 * Purpose: Builds the git-attribution routing index that maps each declared `owner/repo` source-ref to its owning nodeId.
 *   The index is the routing key for multi-node webhook attribution: the ONE cogni-operator GitHub App receives every
 *   repo's webhooks and each is routed to the node whose declared profile claims that repo.
 * Scope: Pure data transform over declared source_refs; does not perform I/O, caching, or env access. Worker-importable
 *   (task.5067 reuse: the scheduler-worker builds the same index to select which receipts belong to an epoch).
 * Invariants:
 *   - REFS_ARE_CASE_INSENSITIVE: GitHub `owner/repo` full-names are case-insensitive; keys are
 *     lowercased so `Cogni-DAO/cogni` and `cogni-dao/cogni` route identically.
 *   - FIRST_WRITER_WINS: if two nodes declare the same ref, the first entry keeps it and the
 *     collision is reported (never silently overwritten) — a repo attributes to exactly one node.
 * Side-effects: none
 * Links: packages/repo-spec/src/accessors.ts (extractLedgerConfig → sourceRefs),
 *   docs/spec/attribution-ledger.md
 * @public
 */

/** One node's declared git source-refs. */
export interface RepoIndexEntry {
  readonly nodeId: string;
  readonly sourceRefs: readonly string[];
}

/** A ref claimed by more than one node — the loser (later entry) is dropped. */
export interface RepoIndexCollision {
  /** The lowercased `owner/repo` ref that was double-claimed. */
  readonly ref: string;
  /** The node that KEPT the ref (first writer). */
  readonly ownerNodeId: string;
  /** The node whose claim was DROPPED. */
  readonly droppedNodeId: string;
}

export interface BuildRepoIndexResult {
  /** Lowercased `owner/repo` → owning nodeId. */
  readonly repoToNode: Map<string, string>;
  /** Refs claimed by 2+ nodes; first-writer kept, later claims recorded here. */
  readonly collisions: RepoIndexCollision[];
}

/**
 * Build the ref→nodeId routing index from each routable node's declared source-refs.
 *
 * First-writer-wins on collision: the first node to declare a ref keeps it; any later node
 * declaring the same (case-insensitive) ref is recorded in `collisions` and does NOT overwrite.
 * Blank/whitespace-only refs are skipped.
 */
export function buildRepoIndex(
  entries: readonly RepoIndexEntry[]
): BuildRepoIndexResult {
  const repoToNode = new Map<string, string>();
  const collisions: RepoIndexCollision[] = [];

  for (const { nodeId, sourceRefs } of entries) {
    for (const rawRef of sourceRefs) {
      const ref = rawRef.trim().toLowerCase();
      if (ref === "") continue;
      const existing = repoToNode.get(ref);
      if (existing !== undefined) {
        // FIRST_WRITER_WINS — keep the incumbent, record the dropped claim.
        if (existing !== nodeId) {
          collisions.push({
            ref,
            ownerNodeId: existing,
            droppedNodeId: nodeId,
          });
        }
        continue;
      }
      repoToNode.set(ref, nodeId);
    }
  }

  return { repoToNode, collisions };
}
