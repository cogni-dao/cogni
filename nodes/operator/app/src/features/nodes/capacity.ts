// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/capacity`
 * Purpose: MVP node-capacity policy — the operator's deterministic gate on birthing new wizard nodes.
 * Scope: Pure functions only. Counts deployed wizard nodes from the parent repo's `.gitmodules` and
 *   decides allow/deny against a configured ceiling. No IO, no env, no GitHub — the caller fetches
 *   `.gitmodules` text and passes the ceiling from config.
 * Invariants:
 *   - DETERMINISTIC_AUTHORIZATION (merge-authority): the decision is a gate boolean, never LLM judgment.
 *   - CAPACITY_FROM_DEPLOYMENT_SSOT: count = `nodes/<slug>` submodule gitlinks in the deployment parent
 *     repo's `.gitmodules` ("# nodes in the envs"), not the RLS-scoped operator `nodes` table.
 * Side-effects: none
 * Links: docs/spec/merge-authority.md
 * @public
 */

/** Outcome of the node-capacity gate. */
export interface NodeCapacityDecision {
  readonly allowed: boolean;
  readonly deployedNodeCount: number;
  readonly ceiling: number;
  readonly reason: string;
}

/**
 * Count wizard-born nodes deployed in the network = `nodes/<slug>` submodule gitlinks declared in the
 * deployment parent repo's `.gitmodules`. Each wizard node is pinned as one such submodule, so this is
 * the network-wide "# nodes in the envs" without touching the per-owner RLS-scoped `nodes` table.
 */
export function countSubmoduleNodes(gitmodulesText: string | null): number {
  if (!gitmodulesText) return 0;
  const matches = gitmodulesText.match(/^\s*path\s*=\s*nodes\/[^\s/]+\s*$/gm);
  return matches ? matches.length : 0;
}

/**
 * MVP capacity gate: the operator allows a new node birth only while the network is below its compute
 * ceiling. At/over the ceiling the operator stops and hands back — the explicit boundary where
 * VM-capacity planning must begin (vNext). The ceiling is config (`NODE_CAPACITY_CEILING`), never a
 * hardcoded literal.
 */
export function evaluateNodeCapacity(input: {
  readonly deployedNodeCount: number;
  readonly ceiling: number;
}): NodeCapacityDecision {
  const { deployedNodeCount, ceiling } = input;
  const allowed = deployedNodeCount < ceiling;
  return {
    allowed,
    deployedNodeCount,
    ceiling,
    reason: allowed
      ? `under capacity (${deployedNodeCount}/${ceiling} nodes)`
      : `network at node capacity (${deployedNodeCount}/${ceiling}) — needs compute/VM planning before adding nodes`,
  };
}
