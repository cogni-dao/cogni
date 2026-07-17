// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@shared/node-app-scaffold/gens/network-nodes`
 * Purpose: Single-file splice that adds a newly-published node to the committed web-node ROSTER
 *   (`src/adapters/server/node-registry/network-nodes.data.ts`). The operator runtime image ships only
 *   its own `.cogni` — NOT `infra/catalog/` — so the roster is a hand-lifted catalog projection kept
 *   honest by the drift guard `tests/unit/adapters/node-registry/network-nodes-catalog-drift.test.ts`
 *   (roster slug set MUST equal the catalog's `type: node` set). Before this splice the roster was
 *   maintained BY HAND, so every wizard publish PR (which adds the node to the catalog) failed the drift
 *   test and was un-mergeable. `buildFootprintEntries` now calls this so the publish PR is born drift-green
 *   — exactly like `insertCaddyBlock` / `insertSchedulerEndpoint`.
 * Scope: Pure string transform over the roster file's text — no IO, no env.
 * Invariants:
 *   - IDEMPOTENT_REFUSE: re-adding an already-present slug throws (mirrors insertSchedulerEndpoint); the
 *     publish caller only ever adds a brand-new node.
 *   - BYTE_STYLE: emits the exact one-line `{ name: "<slug>", nodeId: "<id>" },` shape of the committed
 *     entries (biome-conformant), appended just before the array's `];`.
 * Links: src/adapters/server/node-registry/network-nodes.data.ts (the roster this edits),
 *   tests/unit/adapters/node-registry/network-nodes-catalog-drift.test.ts (the gate this satisfies),
 *   src/shared/node-app-scaffold/gens/scheduler-endpoints.ts (the splice this mirrors)
 * @public
 */

const ARRAY_OPEN = "export const NETWORK_NODES: readonly NetworkNode[] = [";
const ARRAY_CLOSE = "\n];";

/**
 * Insert `{ name: slug, nodeId }` into the `NETWORK_NODES` array of the roster file's text, just before
 * the closing `];`. Returns the new file text. Throws if the array can't be located or the slug is
 * already present (the publish caller only adds new nodes).
 */
export function insertNetworkNode(
  currentFile: string,
  slug: string,
  nodeId: string
): string {
  const openIdx = currentFile.indexOf(ARRAY_OPEN);
  if (openIdx === -1) {
    throw new Error(
      "network-nodes.data.ts is missing the NETWORK_NODES array opener"
    );
  }
  const closeIdx = currentFile.indexOf(ARRAY_CLOSE, openIdx);
  if (closeIdx === -1) {
    throw new Error(
      "network-nodes.data.ts NETWORK_NODES array is not closed with '];'"
    );
  }

  // Idempotency: refuse to double-insert (mirrors insertSchedulerEndpoint's guard).
  const block = currentFile.slice(openIdx, closeIdx);
  if (new RegExp(`name:\\s*${JSON.stringify(slug)}`).test(block)) {
    throw new Error(`network-nodes roster already contains node '${slug}'`);
  }

  const entry = `  { name: ${JSON.stringify(slug)}, nodeId: ${JSON.stringify(nodeId)} },`;
  return `${currentFile.slice(0, closeIdx)}\n${entry}${currentFile.slice(closeIdx)}`;
}
