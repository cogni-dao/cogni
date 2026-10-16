// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/actor-contribution-allocation`
 * Purpose: Deterministic v1 actor-allocation envelope frozen by epoch finalization.
 * Scope: Pure functions only. Does not alter existing AttributionStatement v2 bytes.
 * Invariants:
 * - AI_EARNER_PRESERVED: earnedByActorId is retained even when beneficiary resolution is pending.
 * - BENEFICIARY_CUTOFF_FROZEN: an accepted policy present at cutoff is immutable; absence stays explicit.
 * - ACTOR_ALLOCATION_DETERMINISTIC: identical facts produce the same allocationRef.
 * Side-effects: none (Web Crypto hashing only).
 * Links: story.5075, task.5219
 * @public
 */

import { sha256OfCanonicalJson } from "./hashing";
export const ACTOR_CONTRIBUTION_ALLOCATION_VERSION =
  "actor.contribution.allocation.v1" as const;

export interface ActorContributionAllocationFacts {
  readonly nodeId: string;
  readonly scopeId: string;
  readonly epochId: string;
  readonly receiptId: string;
  readonly earnedByActorId: string;
  readonly beneficiaryActorId: string | null;
  readonly beneficiaryPolicyId: string | null;
  readonly beneficiaryPolicyVersion: string | null;
  /** Canonical receipt event_time, not allocation or read time. */
  readonly contributionCutoff: string;
  readonly sourceEvidence: Readonly<Record<string, unknown>>;
}

export interface FrozenActorContributionAllocation
  extends ActorContributionAllocationFacts {
  readonly allocationRef: string;
  readonly contractVersion: typeof ACTOR_CONTRIBUTION_ALLOCATION_VERSION;
  readonly sourceEvidenceHash: string;
}

/** Freeze all identity and effective-time facts into a content-addressed input. */
export async function freezeActorContributionAllocation(
  facts: ActorContributionAllocationFacts
): Promise<FrozenActorContributionAllocation> {
  const contributionCutoff = new Date(facts.contributionCutoff);
  if (
    Number.isNaN(contributionCutoff.getTime()) ||
    contributionCutoff.toISOString() !== facts.contributionCutoff
  ) {
    throw new Error("contributionCutoff must be a canonical ISO-8601 instant");
  }
  const sourceEvidenceHash = await sha256OfCanonicalJson(facts.sourceEvidence);
  const allocationIdentity = {
    contractVersion: ACTOR_CONTRIBUTION_ALLOCATION_VERSION,
    nodeId: facts.nodeId,
    scopeId: facts.scopeId,
    epochId: facts.epochId,
    receiptId: facts.receiptId,
    earnedByActorId: facts.earnedByActorId,
    beneficiaryActorId: facts.beneficiaryActorId,
    beneficiaryPolicyId: facts.beneficiaryPolicyId,
    beneficiaryPolicyVersion: facts.beneficiaryPolicyVersion,
    contributionCutoff: facts.contributionCutoff,
    sourceEvidenceHash,
  };
  const allocationHash = await sha256OfCanonicalJson(allocationIdentity);
  return {
    ...facts,
    allocationRef: `actor-allocation-v1:${allocationHash}`,
    contractVersion: ACTOR_CONTRIBUTION_ALLOCATION_VERSION,
    sourceEvidenceHash,
  };
}
