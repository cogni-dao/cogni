// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/adapters/node-principal`
 * Purpose: Fail-closed per-node dispatch-principal resolver (G1, task.5029).
 * Scope: The seam the per-node credential provisioning (secrets-on-spawn, separate dev) fills. Today it is a STUB that THROWS for every node — a NodeTaskWorkflow cannot dispatch until a real per-node credential exists.
 * Invariants:
 *   - FAIL_CLOSED (G1): the shared SCHEDULER_API_TOKEN is NEVER a fallback. An unprovisioned node throws NodePrincipalUnprovisionedError; the dispatch activity maps it to a non-retryable ApplicationFailure. A shared-token NodeTaskWorkflow is NOT done.
 *   - NO_SHARED_TOKEN: this module does not accept or read SCHEDULER_API_TOKEN. Wiring it as a fallback here would defeat the entire G1 close (CI/review gate).
 * Side-effects: none (stub); real impl will read a per-node secret store.
 * Links: docs/design/node-temporal-tenant-interface.md (story.5008, task.5029, Gap 3 #3), ports/index.ts NodePrincipalResolver
 * @internal
 */

import {
  type NodePrincipalResolver,
  NodePrincipalUnprovisionedError,
} from "../ports/index.js";

/**
 * The fail-closed stub. Every `resolve` throws — there is no per-node credential
 * store yet, and (by design) NO fallback to the shared token. When the secrets-
 * on-spawn work lands, swap this for a resolver backed by the per-node secret
 * store; the activity + workflow contracts do not change.
 */
export function createFailClosedNodePrincipalResolver(): NodePrincipalResolver {
  return {
    async resolve(nodeId: string): Promise<{ token: string }> {
      throw new NodePrincipalUnprovisionedError(nodeId);
    },
  };
}
