// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.review-epoch.v1.contract`
 * Purpose: Defines operation contract for the open → review epoch transition.
 * Scope: Zod schemas and types for review-epoch wire format. Does not contain business logic.
 * Invariants:
 *   - ALL_MATH_BIGINT: BigInt values serialized as strings
 *   - WRITE_ROUTES_AUTHED: requires SIWE session
 *   - WRITE_ROUTES_APPROVER_GATED: requires wallet in ledger approvers
 *   - Contract remains stable; breaking changes require new version
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";
import { EpochSchema } from "./attribution.list-epochs.v1.contract";

export const ReviewEpochOutputSchema = z.object({
  epoch: EpochSchema,
});

export const reviewEpochOperation = {
  id: "ledger.review-epoch.v1",
  summary: "Transition epoch to review",
  description:
    "Transitions an epoch from open → review. Pins the approver set hash. Stops ingestion. SIWE-protected, approver-gated.",
  output: ReviewEpochOutputSchema,
} as const;

export type ReviewEpochOutput = z.infer<typeof ReviewEpochOutputSchema>;
