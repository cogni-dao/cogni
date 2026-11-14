// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/attribution.distribution-lifecycle.v1.contract`
 * Purpose: Contract for the page-level epoch distribution lifecycle read.
 * Scope: Pure Zod schemas for persisted fold evidence. Does not read RPC, access storage, or infer
 *   publication from unreconciled evidence; reports the cumulative epoch whose root is live.
 * Invariants: ALL_MATH_BIGINT, FOLD_FROM_PERSISTED_MANIFEST, PUBLISH_FROM_ON_CHAIN_EVIDENCE.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/distribution-lifecycle, bug.5042
 * @public
 */

import { z } from "zod";

export const DistributionPublicationEvidenceSchema = z.enum([
  "matched",
  "not_published",
  "unknown",
]);

export const DistributionLifecycleOutputSchema = z.object({
  /** Epoch ids with a persisted, frozen cumulative distribution manifest. */
  foldedEpochIds: z.array(z.string()),
  /** Newest persisted manifest, or null before the first fold. */
  latestFoldedEpochId: z.string().nullable(),
  /**
   * Epoch whose persisted cumulative root equals the distributor's live root. All folded epochs
   * through this id are covered by that cumulative root. Null unless publicationEvidence=matched.
   */
  publishedThroughEpochId: z.string().nullable(),
  publicationEvidence: DistributionPublicationEvidenceSchema,
});

export const distributionLifecycleOperation = {
  id: "ledger.distribution-lifecycle.v1",
  summary: "Read epoch distribution lifecycle evidence",
  description:
    "Returns persisted fold evidence and the cumulative epoch proven live by the distributor's on-chain root. Unknown RPC or unmatched non-zero roots remain unknown.",
  output: DistributionLifecycleOutputSchema,
} as const;

export type DistributionPublicationEvidence = z.infer<
  typeof DistributionPublicationEvidenceSchema
>;
export type DistributionLifecycleOutput = z.infer<
  typeof DistributionLifecycleOutputSchema
>;
