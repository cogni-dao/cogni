// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/actor-attribution`
 * Purpose: Compose governed beneficiary use cases for HTTP routes.
 * Scope: Server-only composition over AttributionStore and signing services.
 * Invariants: PRINCIPAL_IS_CALLER; BENEFICIARY_EXPLICIT; CUTOFF_FROZEN.
 * Side-effects: IO (database reads/writes)
 * Links: story.5075, https://cognidao.org/knowledge/human-ai-identity-standard
 * @public
 */

import type { ActorBeneficiaryPolicyProposalRecord } from "@cogni/attribution-ledger";
import type { ActorBeneficiaryPolicyMutation } from "@cogni/node-contracts";
import { getContainer } from "@/bootstrap/container";

export function serializeBeneficiaryProposal(
  proposal: ActorBeneficiaryPolicyProposalRecord
) {
  return {
    ...proposal,
    effectiveFrom: proposal.effectiveFrom.toISOString(),
    revokedAt: proposal.revokedAt?.toISOString() ?? null,
    createdAt: proposal.createdAt.toISOString(),
    acceptances: proposal.acceptances.map((acceptance) => ({
      ...acceptance,
      acceptedAt: acceptance.acceptedAt.toISOString(),
    })),
  };
}

export async function resolveAttributionActor(input: {
  readonly kind: "human" | "agent";
  readonly userId?: string;
  readonly actorId?: string;
}): Promise<string | null> {
  if (input.kind === "agent") return input.actorId ?? null;
  if (!input.userId) return null;
  return getContainer().attributionStore.resolveActiveHumanActorId(
    input.userId
  );
}

export async function mutateBeneficiaryPolicy(input: {
  readonly actorId: string;
  readonly mutation: ActorBeneficiaryPolicyMutation;
  readonly governanceOverride?: boolean;
}) {
  const store = getContainer().attributionStore;
  const now = new Date();
  if (input.mutation.action === "propose") {
    return store.proposeActorBeneficiaryPolicy({
      earnedByActorId: input.mutation.earnedByActorId,
      beneficiaryActorId: input.mutation.beneficiaryActorId,
      stewardActorId: input.mutation.stewardActorId,
      proposedByActorId: input.actorId,
      policyVersion: input.mutation.policyVersion,
      effectiveFrom: new Date(input.mutation.effectiveFrom),
      evidence: input.mutation.evidence,
    });
  }
  if (input.mutation.action === "accept") {
    return store.acceptActorBeneficiaryPolicy({
      proposalId: input.mutation.proposalId,
      role: input.mutation.role,
      acceptedByActorId: input.actorId,
      acceptedAt: now,
      evidence: input.mutation.evidence,
    });
  }
  return store.revokeActorBeneficiaryPolicy({
    proposalId: input.mutation.proposalId,
    revokedByActorId: input.actorId,
    revokedAt: now,
    ...(input.governanceOverride !== undefined
      ? { governanceOverride: input.governanceOverride }
      : {}),
  });
}
