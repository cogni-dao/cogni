// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.epoch-claimants.v1.contract`
 * Purpose: Defines operation contract for retrieving claimant-based finalized attribution for an epoch.
 * Scope: Zod schemas and types for claimant line-item wire format. Does not contain business logic.
 * Invariants:
 *   - ALL_MATH_BIGINT: BigInt values serialized as strings
 *   - CLAIMANTS_ARE_PLURAL: finalized attribution is claimant-based, not user-only
 *   - Contract remains stable; breaking changes require new version
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";

export const UserClaimantSchema = z.object({
  kind: z.literal("user"),
  userId: z.string(),
});

export const IdentityClaimantSchema = z.object({
  kind: z.literal("identity"),
  provider: z.string(),
  externalId: z.string(),
  providerLogin: z.string().nullable(),
});

export const EpochClaimantSchema = z.discriminatedUnion("kind", [
  UserClaimantSchema,
  IdentityClaimantSchema,
]);

export const EpochClaimantLineItemSchema = z.object({
  claimantKey: z.string(),
  claimant: EpochClaimantSchema,
  displayName: z.string().nullable(),
  isLinked: z.boolean(),
  totalUnits: z.string(),
  share: z.string(),
  amountCredits: z.string(),
  receiptIds: z.array(z.string()),
});

export const ReviewOverrideSnapshotSchema = z.object({
  subject_ref: z.string(),
  original_units: z.string(),
  override_units: z.string().nullable(),
  reason: z.string().nullable(),
});

export const EpochClaimantsOutputSchema = z.object({
  epochId: z.string(),
  poolTotalCredits: z.string(),
  items: z.array(EpochClaimantLineItemSchema),
  reviewOverrides: z.array(ReviewOverrideSnapshotSchema).nullable().optional(),
});

export const epochClaimantsOperation = {
  id: "ledger.epoch-claimants.v1",
  summary: "Get finalized claimant attribution for an epoch",
  description:
    "Returns finalized claimant-based attribution for the specified epoch. Public endpoint for claimant-aware history and holdings.",
  input: z.object({}),
  output: EpochClaimantsOutputSchema,
} as const;

export type EpochClaimantDto = z.infer<typeof EpochClaimantSchema>;
export type EpochClaimantLineItemDto = z.infer<
  typeof EpochClaimantLineItemSchema
>;
export type EpochClaimantsOutput = z.infer<typeof EpochClaimantsOutputSchema>;
