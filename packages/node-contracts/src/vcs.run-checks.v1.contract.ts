// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/vcs.run-checks.v1`
 * Purpose: Zod contract for the node-scoped operator-executed fork-PR check approval (POST /api/v1/vcs/run-checks), which releases GitHub's `action_required` hold on a fork contributor's `pull_request` workflow runs so the node's own CI can run.
 * Scope: Input/output shapes only. Does not make network calls or import the GitHub API.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: wire shape is owned by vcs.run-checks.v1.contract.
 *   - NODE_ID_OR_SLUG: the agent supplies the NODE (id or slug) + PR number; owner/repo are
 *     operator-resolved from the node's catalog `source_repo` (anti-spoof, never the body).
 *   - RBAC_IS_THE_GATE: `node.flight` on the named node authorizes the approval — no work-item
 *     linkage, no self-merge / probation check (the owner-granted RBAC tuple IS the trust boundary).
 *   - SAFE_BY_STRUCTURE: only standard `pull_request` runs are approved (never
 *     `pull_request_target` / secret-bearing runs).
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/run-checks/route.ts, docs/spec/node-ci-cd-contract.md
 * @public
 */

import { z } from "zod";

export const runChecksOperation = {
  input: z.object({
    nodeId: z.string().min(1),
    prNumber: z.number().int().positive(),
  }),

  output: z.object({
    approved: z.number().int().nonnegative(),
    prNumber: z.number().int().positive(),
    headSha: z.string().nullable(),
    runIds: z.array(z.number().int()),
    message: z.string(),
  }),
} as const;
