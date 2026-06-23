// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/vcs.merge.v1`
 * Purpose: Zod contract for the operator-executed PR merge request (POST /api/v1/vcs/merge).
 * Scope: Input/output shapes only. Does not make network calls or import the GitHub API.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: wire shape is owned by vcs.merge.v1.contract.
 *   - NO_REPO_FROM_AGENT: owner/repo are operator-resolved (never request body, anti-spoof). With
 *     `nodeId`, the target is the node's catalog `source_repo`; without it, the operator's own
 *     monorepo (the KEPT LEGACY lane). The agent supplies only the PR number (+ optional nodeId).
 *   - NODE_SCOPED_OR_LEGACY: optional `nodeId` (id-or-slug) selects RBAC + merge target. Present →
 *     `node.flight` on THAT node + merge the node's repo. Absent → operator node + monorepo (legacy).
 *   - SQUASH_ONLY: V0 merges with a single, predictable strategy.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/merge/route.ts, docs/spec/development-lifecycle.md
 * @public
 */

import { z } from "zod";

export const mergeOperation = {
  input: z.object({
    prNumber: z.number().int().positive(),
    method: z.literal("squash").default("squash"),
    /**
     * Optional node id-or-slug. Present → node-scoped (RBAC + merge target = the node's
     * `source_repo`). Absent → legacy operator-monorepo lane (operator-node RBAC + env repo).
     */
    nodeId: z.string().min(1).optional(),
  }),

  output: z.object({
    merged: z.literal(true),
    prNumber: z.number().int().positive(),
    sha: z.string(),
    baseBranch: z.literal("main"),
    method: z.literal("squash"),
    message: z.string(),
  }),
} as const;
