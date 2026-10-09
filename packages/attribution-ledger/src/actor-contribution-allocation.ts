// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/actor-contribution-allocation`
 * Purpose: Deterministic v1 actor-allocation envelope and EIP-712 signing data.
 * Scope: Pure functions only. Does not alter existing AttributionStatement v2 bytes.
 * Invariants:
 * - AI_EARNER_PRESERVED: earnedByActorId and beneficiaryActorId are separate signed facts.
 * - BENEFICIARY_CUTOFF_FROZEN: policy id/version and receipt cutoff are signed.
 * - ACTOR_ALLOCATION_DETERMINISTIC: identical facts produce the same allocationRef and typed data.
 * Side-effects: none (Web Crypto hashing only).
 * Links: story.5075, task.5219
 * @public
 */

import { sha256OfCanonicalJson } from "./hashing";
import {
  type EIP712DeploymentEnvironment,
  parseEIP712DeploymentEnvironment,
} from "./signing";

export const ACTOR_CONTRIBUTION_ALLOCATION_VERSION =
  "actor.contribution.allocation.v1" as const;
export const ACTOR_ALLOCATION_DOMAIN_NAME =
  "Cogni Actor Contribution Allocation" as const;
export const ACTOR_ALLOCATION_DOMAIN_VERSION = "1" as const;

export const ACTOR_CONTRIBUTION_ALLOCATION_TYPES = {
  ActorContributionAllocation: [
    { name: "allocationRef", type: "string" },
    { name: "nodeId", type: "string" },
    { name: "scopeId", type: "string" },
    { name: "epochId", type: "string" },
    { name: "receiptId", type: "string" },
    { name: "contractVersion", type: "string" },
    { name: "deploymentEnvironment", type: "string" },
    { name: "earnedByActorId", type: "string" },
    { name: "beneficiaryActorId", type: "string" },
    { name: "beneficiaryPolicyId", type: "string" },
    { name: "beneficiaryPolicyVersion", type: "string" },
    { name: "contributionCutoff", type: "string" },
    { name: "sourceEvidenceHash", type: "string" },
  ],
} as const;

export interface ActorContributionAllocationFacts {
  readonly nodeId: string;
  readonly scopeId: string;
  readonly epochId: string;
  readonly receiptId: string;
  readonly earnedByActorId: string;
  readonly beneficiaryActorId: string;
  readonly beneficiaryPolicyId: string;
  readonly beneficiaryPolicyVersion: string;
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

export interface ActorContributionAllocationTypedData {
  readonly domain: {
    readonly name: typeof ACTOR_ALLOCATION_DOMAIN_NAME;
    readonly version: typeof ACTOR_ALLOCATION_DOMAIN_VERSION;
    readonly chainId: number;
  };
  readonly types: typeof ACTOR_CONTRIBUTION_ALLOCATION_TYPES;
  readonly primaryType: "ActorContributionAllocation";
  readonly message: {
    readonly allocationRef: string;
    readonly nodeId: string;
    readonly scopeId: string;
    readonly epochId: string;
    readonly receiptId: string;
    readonly contractVersion: typeof ACTOR_CONTRIBUTION_ALLOCATION_VERSION;
    readonly deploymentEnvironment: EIP712DeploymentEnvironment;
    readonly earnedByActorId: string;
    readonly beneficiaryActorId: string;
    readonly beneficiaryPolicyId: string;
    readonly beneficiaryPolicyVersion: string;
    readonly contributionCutoff: string;
    readonly sourceEvidenceHash: string;
  };
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

/** Build a wallet-visible EIP-712 message without changing legacy statement v2. */
export function buildActorContributionAllocationTypedData(input: {
  readonly allocation: FrozenActorContributionAllocation;
  readonly chainId: number;
  readonly deploymentEnvironment: string | undefined;
}): ActorContributionAllocationTypedData {
  const deploymentEnvironment = parseEIP712DeploymentEnvironment(
    input.deploymentEnvironment
  );
  const allocation = input.allocation;
  return {
    domain: {
      name: ACTOR_ALLOCATION_DOMAIN_NAME,
      version: ACTOR_ALLOCATION_DOMAIN_VERSION,
      chainId: input.chainId,
    },
    types: ACTOR_CONTRIBUTION_ALLOCATION_TYPES,
    primaryType: "ActorContributionAllocation",
    message: {
      allocationRef: allocation.allocationRef,
      nodeId: allocation.nodeId,
      scopeId: allocation.scopeId,
      epochId: allocation.epochId,
      receiptId: allocation.receiptId,
      contractVersion: allocation.contractVersion,
      deploymentEnvironment,
      earnedByActorId: allocation.earnedByActorId,
      beneficiaryActorId: allocation.beneficiaryActorId,
      beneficiaryPolicyId: allocation.beneficiaryPolicyId,
      beneficiaryPolicyVersion: allocation.beneficiaryPolicyVersion,
      contributionCutoff: allocation.contributionCutoff,
      sourceEvidenceHash: allocation.sourceEvidenceHash,
    },
  };
}
