// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-registry/fleet-ownership`
 * Purpose: Decide whether a node's catalog row belongs to THIS operator's fleet (story.5137 CD4). A fleet is
 *   the GitHub org that owns its nodes' source repos: the canonical fleet is `cogni-dao`, the isolated test
 *   fleet is `cogni-test-org`. The route and the sequencer apply this SAME predicate, so the test operator can
 *   never record or deploy a canonical node such as toks5, even though the canonical catalog is baked into its
 *   image.
 * Scope: Pure string parsing of a parsed catalog row. No IO.
 * Invariants:
 *   - SAME_FILTER_ROUTE_AND_SEQUENCER: `isFleetOwnedRow` is the one predicate; both call it.
 *   - OWNER_IS_THE_SOURCE_REPO_ORG: a remote-source row (`source_repo` set) is owned iff its repo's owner
 *     equals the fleet owner, compared case-insensitively. An unparseable `source_repo` is not owned.
 *   - IN_REPO_ROW_IS_THE_FLEETS_OWN: a row with no `source_repo` lives in the fleet's own monorepo (the
 *     operator); it is owned.
 *   - NO_OWNER_NO_REMOTE_NODES: with no fleet owner configured a remote-source row is NOT owned (fail
 *     closed), so a sequencer that was never told its fleet deploys no remote node.
 * Side-effects: none
 * Links: app/api/v1/deploy/workloads/_lib/lane.ts, adapters/server/node-deploy/image-catalog.adapter.ts
 * @public
 */

const GITHUB_REPO_URL =
  /^https:\/\/github\.com\/([^/\s]+)\/[^/\s]+?(?:\.git)?\/?$/iu;

/** The GitHub org (lowercased) that owns the row's `source_repo`; undefined for an in-repo or bad row. */
function sourceRepoOwner(row: unknown): string | undefined {
  const url =
    typeof row === "object" && row !== null
      ? (row as { source_repo?: unknown }).source_repo
      : undefined;
  if (typeof url !== "string") return undefined;
  return GITHUB_REPO_URL.exec(url.trim())?.[1]?.toLowerCase();
}

/** True when `row` belongs to the fleet whose source-repo org is `fleetOwner`. */
export function isFleetOwnedRow(
  row: unknown,
  fleetOwner: string | undefined
): boolean {
  if (typeof row !== "object" || row === null) return false;
  if ((row as { source_repo?: unknown }).source_repo === undefined) return true;
  const owner = fleetOwner?.trim().toLowerCase();
  if (!owner) return false;
  return sourceRepoOwner(row) === owner;
}
