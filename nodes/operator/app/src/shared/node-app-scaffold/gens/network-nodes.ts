// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/network-nodes`
 * Purpose: Pure splice for the operator's committed web-node roster, so node-formation PRs that add
 *   `infra/catalog/<slug>.yaml` also keep `NETWORK_NODES` drift-clean.
 * Scope: Given current `network-nodes.data.ts` text and a new node identity, append one roster entry.
 * Side-effects: none
 * Links: src/adapters/server/node-registry/network-nodes.data.ts,
 *   tests/unit/adapters/node-registry/network-nodes-catalog-drift.test.ts
 * @public
 */

export function insertNetworkNode(
  current: string,
  slug: string,
  nodeId: string
): string {
  const entry = `  { name: "${slug}", nodeId: "${nodeId}" },`;
  const existing = new RegExp(
    String.raw`\{\s*name:\s*"${slug}",\s*nodeId:\s*"([^"]+)"`
  ).exec(current);
  if (existing) {
    const [, existingNodeId] = existing;
    if (existingNodeId === nodeId) return current;
    throw new Error(
      `insertNetworkNode: ${slug} already exists with nodeId ${existingNodeId}`
    );
  }

  const end = "\n];";
  const index = current.lastIndexOf(end);
  if (index === -1) {
    throw new Error(
      "insertNetworkNode: NETWORK_NODES array terminator not found"
    );
  }

  const prefix = current.slice(0, index).replace(/\s+$/, "");
  const suffix = current.slice(index);
  return `${prefix}\n${entry}${suffix}`;
}
