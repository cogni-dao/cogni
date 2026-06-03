// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/vcs.approve-checks.v1`
 * Purpose: Zod contract for POST /api/v1/vcs/approve-checks (operator-as-maintainer auto-approval of fork-PR workflow runs).
 * Scope: Input/output shapes only. Does not make network calls or import GitHub API.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: wire shape is owned by vcs.approve-checks.v1.contract
 *   - WORK_ITEM_GATED: input carries workItemId — the route proves the PR is linked
 *     to that item by the calling principal before approving.
 * Side-effects: none
 * Links: docs/design/operator-approve-fork-checks.md,
 *   nodes/operator/app/src/app/api/v1/vcs/approve-checks/route.ts
 * @public
 */

import { z } from "zod";

export const approveChecksOperation = {
  input: z.object({
    workItemId: z.string().min(1),
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
