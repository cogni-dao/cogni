// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/adapters/node-principal`
 * Purpose: NodePrincipalResolver factories — the MVP shared-token resolver (wired, task.5034) and the fail-closed per-node resolver (the hardening seam, task.5029/5033).
 * Scope: Constructs the dispatch wire-identity resolver. Does not read a secret store, perform network I/O, or decide which resolver the container wires.
 * Invariants:
 *   - MVP_SHARED_TOKEN (task.5034): the wired resolver returns the shared SCHEDULER_API_TOKEN — IDENTICAL to the credential graph dispatch already uses in run-http.ts. NodeTask is consistent with graphs (syntropy); dispatch can actually succeed today.
 *   - PER_NODE_IS_HARDENING (task.5033 + secrets-on-spawn): the per-node credential is the hardening for BOTH paths (graph + task), not a NodeTask-only gate. The fail-closed resolver below is the seam it fills; it is built but NOT wired.
 *   - FAIL_CLOSED_WHEN_WIRED: once a per-node credential store exists, swapping to createFailClosedNodePrincipalResolver throws NodePrincipalUnprovisionedError for unprovisioned nodes (non-retryable).
 * Side-effects: none.
 * Links: docs/design/node-temporal-tenant-interface.md (story.5008, task.5033/5034), services/scheduler-worker/src/adapters/run-http.ts (shared-token graph dispatch), ports/index.ts NodePrincipalResolver
 * @internal
 */

import {
  type NodePrincipalResolver,
  NodePrincipalUnprovisionedError,
} from "../ports/index.js";

/**
 * MVP resolver (task.5034 — WIRED). Resolves the shared `SCHEDULER_API_TOKEN` for
 * every node — the SAME credential graph dispatch already authenticates with in
 * run-http.ts. This makes NodeTask dispatch consistent with the graph path
 * (syntropy) and lets a NodeTaskWorkflow actually succeed today. The per-node
 * credential is the hardening for BOTH paths (task.5033 + secrets-on-spawn), not a
 * NodeTask-only gate; until it lands, the shared token is the honest MVP identity.
 */
export function createSharedTokenNodePrincipalResolver(
  token: string
): NodePrincipalResolver {
  return {
    async resolve(_nodeId: string): Promise<{ token: string }> {
      return { token };
    },
  };
}

/**
 * The fail-closed resolver (the hardening seam, task.5033 — BUILT, NOT WIRED).
 * Every `resolve` throws — for the future where a per-node credential store exists
 * and the shared token must NOT be a fallback. When the secrets-on-spawn work
 * lands, this is swapped in (backed by the per-node secret store); the activity +
 * workflow contracts do not change.
 */
export function createFailClosedNodePrincipalResolver(): NodePrincipalResolver {
  return {
    async resolve(nodeId: string): Promise<{ token: string }> {
      throw new NodePrincipalUnprovisionedError(nodeId);
    },
  };
}
