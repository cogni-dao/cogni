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
 *   - MERGED_XOR_ENQUEUED: exactly one of `merged` (direct, synchronous, carries `sha`) or
 *     `enqueued` (added to the merge queue, async — no `sha` yet) is true. Enforced by `.refine`.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/merge/route.ts, https://node-template.cognidao.org/knowledge/work-item-status-machine
 * @public
 */

import { z } from "zod";

export const mergeOperation = {
  input: z.object({
    prNumber: z.number().int().positive(),
    method: z.literal("squash").default("squash"),
    /**
     * Required node id-or-slug — every merge is node-scoped (RBAC on the named node + merge target
     * resolved by `resolveNodeRepo`). The operator's own monorepo PRs pass `nodeId:"operator"` (it is
     * the in-repo node → resolves to the parent monorepo). There is no `nodeId`-less lane.
     */
    nodeId: z.string().min(1),
  }),

  /**
   * MERGED_XOR_ENQUEUED: the operator merges directly when no merge queue is
   * required on the base branch (`merged: true` + a `sha`, synchronous), or adds
   * the PR to the queue when one is (`enqueued: true`, async — the real merge
   * happens later on the queue's rebased candidate, so there is NO `sha` yet).
   * Exactly one of the two booleans is true; a consumer that needs the merged SHA
   * must poll the PR/queue after an `enqueued` result.
   */
  output: z
    .object({
      merged: z.boolean(),
      enqueued: z.boolean(),
      prNumber: z.number().int().positive(),
      sha: z.string().optional(),
      baseBranch: z.literal("main"),
      method: z.literal("squash"),
      message: z.string(),
    })
    .refine((d) => d.merged !== d.enqueued, {
      message: "exactly one of `merged` | `enqueued` must be true",
    })
    .refine((d) => !d.merged || typeof d.sha === "string", {
      message: "a `merged` result must carry a `sha`",
    }),
} as const;
