// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/attribution.actor-identity.v1.contract`
 * Purpose: Wire contracts for governed AI beneficiary policies and signed allocations.
 * Scope: Zod schemas only; never infers a beneficiary from stewardship, billing, or OBO.
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
      role: z.enum(["earner", "steward", "governance"]),
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
  role: z.enum(["earner", "steward", "governance"]),
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

export const actorAllocationSignInputSchema =
  actorAllocationReadInputSchema.extend({
    signerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  });

export const actorContributionAllocationSchema = z.object({
  allocationRef: z.string(),
  contractVersion: z.literal("actor.contribution.allocation.v1"),
  nodeId: z.string(),
  scopeId: z.string(),
  epochId: z.string(),
  receiptId: z.string(),
  earnedByActorId: z.string(),
  beneficiaryActorId: z.string(),
  beneficiaryPolicyId: z.string(),
  beneficiaryPolicyVersion: z.string(),
  contributionCutoff: z.string().datetime(),
  sourceEvidence: z.record(z.string(), z.unknown()),
  sourceEvidenceHash: z.string(),
});

export const actorAllocationTypedDataSchema = z.object({
  allocation: actorContributionAllocationSchema,
  typedData: z.object({
    domain: z.object({
      name: z.literal("Cogni Actor Contribution Allocation"),
      version: z.literal("1"),
      chainId: z.number().int().positive(),
    }),
    types: z.record(
      z.string(),
      z.array(z.object({ name: z.string(), type: z.string() }))
    ),
    primaryType: z.literal("ActorContributionAllocation"),
    message: z.record(z.string(), z.unknown()),
  }),
});

export const actorAllocationRecordSchema =
  actorContributionAllocationSchema.extend({
    signerActorId: z.string(),
    signerWallet: z.string(),
    signature: z.string(),
    signedAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  });

export const actorAllocationLifecycleSchema = z.object({
  allocation: actorAllocationRecordSchema,
  status: z.enum(["signed", "pending_wallet", "settled"]),
  tokenAmount: z.string().nullable(),
  claimantWallet: z.string().nullable(),
  liabilityId: z.string().nullable(),
  settlementId: z.string().nullable(),
});

export const actorAllocationOperation = {
  id: "attribution.actor-allocation.v1",
  summary: "Prepare, sign, and read a frozen AI contribution allocation",
  readInput: actorAllocationReadInputSchema,
  signInput: actorAllocationSignInputSchema,
  typedDataOutput: actorAllocationTypedDataSchema,
  recordOutput: actorAllocationRecordSchema,
  lifecycleOutput: actorAllocationLifecycleSchema,
} as const;

export type ActorBeneficiaryPolicyMutation = z.infer<
  typeof actorBeneficiaryPolicyMutationSchema
>;
