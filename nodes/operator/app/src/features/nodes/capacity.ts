// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/capacity`
 * Purpose: MVP node-capacity policy — the operator's deterministic gate on birthing new wizard nodes.
 * Scope: Pure decision only. `evaluateNodeCapacity` decides allow/deny against a configured ceiling;
 *   the deployed-node count is supplied by the caller (the GitHub deploy plane reads the catalog).
 *   No IO, no env, no GitHub here.
 * Invariants:
 *   - DETERMINISTIC_AUTHORIZATION (merge-authority): the decision is a gate boolean, never LLM judgment.
 *   - CAPACITY_FROM_CATALOG_SSOT: the network node-count = `infra/catalog/*.yaml` entries with
 *     `type: node` + `source_repo` (wizard-born remote-source nodes) in the deployment parent repo —
 *     NOT `.gitmodules` (retired by #1647, CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN) and NOT the
 *     RLS-scoped operator `nodes` table. Counting lives in `GitHubRepoWriter.countDeployedWizardNodes`.
 * Side-effects: none
 * Links: docs/spec/merge-authority.md, docs/spec/node-submodule-retirement.md
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
