// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/vcs.review.v1`
 * Purpose: Zod contract for POST /api/v1/vcs/review — a developer-requested PR review.
 * Scope: Input/output shapes only. Does not make network calls or import the GitHub API.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: wire shape is owned by vcs.review.v1.contract.
 *   - REVIEW_IS_DEV_TRIGGERED: this verb is the only thing that starts a PR review.
 *   - NO_REPO_FROM_AGENT: owner/repo are operator-resolved from `nodeId` (resolveNodeRepo),
 *     never the request body. The agent supplies only the node and the PR number.
 *   - REVIEW_SUBJECT_IS_HOST_BOUND: the verb pins the PR head SHA it returns; the review
 *     reads code at that SHA only.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/review/route.ts, story.5102,
 *   https://cognidao.org/knowledge/pr-review-grounded-gate
 * @public
 */

import { z } from "zod";

export const reviewOperation = {
  input: z
    .object({
      /** Node UUID or slug whose repository holds the PR (operator → the parent monorepo). */
      nodeId: z.string().min(1),
      /** Pull request number in the node's repository. */
      prNumber: z.number().int().positive(),
    })
    .strict(),
  output: z.object({
    /** Stable Temporal id `pr-review:{owner}/{repo}/{pr}/{headSha}`. */
    workflowId: z.string().min(1),
    /** PR head SHA the review is pinned to. */
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    /** Unique id of this request; the check run carries it as `external_id`. */
    requestId: z.string().uuid(),
  }),
} as const;

export type ReviewRequestInput = z.infer<typeof reviewOperation.input>;
export type ReviewRequestOutput = z.infer<typeof reviewOperation.output>;
