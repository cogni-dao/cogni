// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.actor-identity.v1.contract`
 * Purpose: Wire contracts for governed AI beneficiary policies and automatically frozen allocations.
 * Scope: Zod schemas only. Does not persist policy state, infer a beneficiary from stewardship, billing, or OBO, or perform settlement.
 * Invariants: HUMAN_AND_AGENT_ARE_DISTINCT; EXPLICIT_BENEFICIARY; CUTOFF_FROZEN.
 * Side-effects: none
 * Links: story.5075, https://cognidao.org/knowledge/human-ai-identity-standard
 * @public
 */

import { z } from "zod";

const evidenceSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (evidence) => Object.keys(evidence).length > 0,
    "evidence must not be empty"
  );

export const actorBeneficiaryPolicyMutationSchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("propose"),
      earnedByActorId: z.string().min(1),
      beneficiaryActorId: z.string().min(1),
      stewardActorId: z.string().min(1),
      policyVersion: z.string().min(1),
      effectiveFrom: z.string().datetime(),
      evidence: evidenceSchema,
    }),
    z.object({
      action: z.literal("accept"),
      proposalId: z.string().min(1),
      role: z.enum([
        "beneficiary",
        "earner",
        "steward",
        "governance_for_earner",
        "governance_for_steward",
      ]),
      evidence: evidenceSchema,
    }),
    z.object({
      action: z.literal("revoke"),
      proposalId: z.string().min(1),
    }),
  ]
);

const acceptanceSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  role: z.enum([
    "beneficiary",
    "earner",
    "steward",
    "governance_for_earner",
    "governance_for_steward",
  ]),
  acceptedByActorId: z.string(),
  evidence: evidenceSchema,
  acceptedAt: z.string().datetime(),
});

export const actorBeneficiaryPolicyProposalSchema = z.object({
  id: z.string(),
  earnedByActorId: z.string(),
  beneficiaryActorId: z.string(),
  stewardActorId: z.string(),
  proposedByActorId: z.string(),
  policyVersion: z.string(),
  evidence: evidenceSchema,
  effectiveFrom: z.string().datetime(),
  status: z.enum(["pending", "activated", "revoked"]),
  activatedPolicyId: z.string().nullable(),
  revokedByActorId: z.string().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  acceptances: z.array(acceptanceSchema),
});

export const actorBeneficiaryPolicyOperation = {
  id: "attribution.actor-beneficiary-policy.v1",
  summary: "Run the governed AI beneficiary policy ceremony",
  input: actorBeneficiaryPolicyMutationSchema,
  output: actorBeneficiaryPolicyProposalSchema,
} as const;

export const actorAllocationReadInputSchema = z.object({
  epochId: z.string().regex(/^\d+$/),
  receiptId: z.string().min(1),
});

export const actorContributionAllocationSchema = z.object({
  allocationRef: z.string(),
  contractVersion: z.literal("actor.contribution.allocation.v1"),
  nodeId: z.string(),
  scopeId: z.string(),
  epochId: z.string(),
  receiptId: z.string(),
  earnedByActorId: z.string(),
  beneficiaryActorId: z.string().nullable(),
  beneficiaryPolicyId: z.string().nullable(),
  beneficiaryPolicyVersion: z.string().nullable(),
  contributionCutoff: z.string().datetime(),
  sourceEvidence: z.record(z.string(), z.unknown()),
  sourceEvidenceHash: z.string(),
});

export const actorAllocationRecordSchema =
  actorContributionAllocationSchema.extend({
    createdAt: z.string().datetime(),
  });

export const actorAllocationLifecycleSchema = z.object({
  allocation: actorAllocationRecordSchema,
  status: z.enum([
    "frozen",
    "pending_beneficiary",
    "pending_wallet",
    "settled",
  ]),
  tokenAmount: z.string().nullable(),
  claimantWallet: z.string().nullable(),
  liabilityId: z.string().nullable(),
  settlementId: z.string().nullable(),
});

export const actorAllocationOperation = {
  id: "attribution.actor-allocation.v1",
  summary: "Read an automatically frozen AI contribution allocation",
  readInput: actorAllocationReadInputSchema,
  recordOutput: actorAllocationRecordSchema,
  lifecycleOutput: actorAllocationLifecycleSchema,
} as const;

export type ActorBeneficiaryPolicyMutation = z.infer<
  typeof actorBeneficiaryPolicyMutationSchema
>;
