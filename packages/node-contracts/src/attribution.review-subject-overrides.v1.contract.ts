// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.review-subject-overrides.v1.contract`
 * Purpose: Defines operation contracts for subject-level review overrides during epoch review.
 * Scope: Zod schemas and types for subject override wire format. Does not contain business logic.
 * Invariants:
 *   - WRITE_ROUTES_AUTHED: requires SIWE session
 *   - WRITE_ROUTES_APPROVER_GATED: requires wallet in ledger approvers
 *   - Shares must sum to exactly 1_000_000 PPM
 *   - Only existing claimants allowed in override shares
 *   - Contract remains stable; breaking changes require new version
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import { z } from "zod";

const zBigint = z
  .string()
  .regex(/^\d+$/, "Must be a non-negative integer string")
  .transform(BigInt);

const ClaimantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({
    kind: z.literal("identity"),
    provider: z.string(),
    externalId: z.string(),
    providerLogin: z.string().nullable(),
  }),
]);

const ClaimantShareSchema = z.object({
  claimant: ClaimantSchema,
  sharePpm: z.number().int().min(0).max(1_000_000),
});

const SubjectOverrideInputSchema = z.object({
  subjectRef: z.string().min(1),
  overrideUnits: zBigint.nullable().optional(),
  overrideShares: z.array(ClaimantShareSchema).nullable().optional(),
  overrideReason: z.string().nullable().optional(),
});

export const PatchSubjectOverridesInputSchema = z.object({
  overrides: z.array(SubjectOverrideInputSchema).min(1),
});

export const PatchSubjectOverridesOutputSchema = z.object({
  upserted: z.number(),
});

export const GetSubjectOverridesOutputSchema = z.object({
  overrides: z.array(
    z.object({
      id: z.string(),
      subjectRef: z.string(),
      overrideUnits: z.string().nullable(),
      overrideShares: z.array(ClaimantShareSchema).nullable(),
      overrideReason: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
  ),
});

export const DeleteSubjectOverrideInputSchema = z.object({
  subjectRef: z.string().min(1),
});

export const patchReviewSubjectOverridesOperation = {
  id: "ledger.patch-review-subject-overrides.v1",
  summary: "Upsert subject-level review overrides",
  description:
    "Upserts subject-level weight/share overrides during epoch review. SIWE-protected, approver-gated.",
  input: PatchSubjectOverridesInputSchema,
  output: PatchSubjectOverridesOutputSchema,
} as const;

export const getReviewSubjectOverridesOperation = {
  id: "ledger.get-review-subject-overrides.v1",
  summary: "Get subject-level review overrides for an epoch",
  description:
    "Returns all subject-level overrides for the specified epoch. SIWE-protected.",
  output: GetSubjectOverridesOutputSchema,
} as const;

export const deleteReviewSubjectOverrideOperation = {
  id: "ledger.delete-review-subject-override.v1",
  summary: "Delete a subject-level review override",
  description:
    "Removes a subject-level override for a given subject reference during epoch review. SIWE-protected, approver-gated.",
  input: DeleteSubjectOverrideInputSchema,
} as const;

export type PatchSubjectOverridesInput = z.infer<
  typeof PatchSubjectOverridesInputSchema
>;
export type PatchSubjectOverridesOutput = z.infer<
  typeof PatchSubjectOverridesOutputSchema
>;
export type GetSubjectOverridesOutput = z.infer<
  typeof GetSubjectOverridesOutputSchema
>;
export type DeleteSubjectOverrideInput = z.infer<
  typeof DeleteSubjectOverrideInputSchema
>;
