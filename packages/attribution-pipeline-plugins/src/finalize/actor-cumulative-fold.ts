// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/finalize/actor-cumulative-fold`
 * Purpose: Fold frozen actor allocations and pending liabilities into a cumulative token distribution.
 * Scope: Pure orchestration over injected wallet resolvers; does not persist rows, mutate prior manifests, or send funds.
 * Invariants: LIABILITY_AMOUNT_IMMUTABLE, LIABILITY_SETTLED_ONCE, LEGACY_BYTES_UNCHANGED, FROZEN_BENEFICIARY_ONLY.
 * Side-effects: Calls injected read-only wallet resolvers.
 * Links: docs/spec/attribution-ledger.md, docs/spec/identity-model.md
 * @public
 */

import {
  buildDaoTokenCumulativeDistribution,
  type ClaimantWalletResolver,
  type CumulativeEpochDelta,
  type DaoTokenCumulativeDistribution,
  type HexAddress,
  type PriorCumulativeBalance,
} from "@cogni/aragon-osx";
import {
  type ActorBeneficiaryWalletResolver,
  type ActorContributionAllocationRecord,
  type ActorDistributionLiabilityRecord,
  type ActorDistributionSettlementRecord,
  computeActorAwareSettlementPlan,
  type PendingActorDistributionLiability,
  type ReceiptClaimantsRecord,
  type ReceiptUnitWeight,
  type SubjectOverride,
} from "@cogni/attribution-ledger";

type NewLiability = Omit<ActorDistributionLiabilityRecord, "id" | "createdAt">;
type NewSettlement = Omit<
  ActorDistributionSettlementRecord,
  "id" | "createdAt"
>;

export interface ActorCumulativeFoldResult {
  readonly distribution: DaoTokenCumulativeDistribution | null;
  readonly liabilities: readonly NewLiability[];
  readonly settlements: readonly NewSettlement[];
  readonly unresolvedClaimantKeys: readonly string[];
}

function missingResolution(allocation: ActorContributionAllocationRecord) {
  return {
    code: "beneficiary_wallet_unbound" as const,
    beneficiaryActorId: allocation.beneficiaryActorId,
    observedBindingIds: [],
  };
}

/**
 * Build one cumulative fold from immutable actor allocations. Current actor
 * amounts are priced exactly once from the original finalized receipt weights;
 * pending liabilities contribute their already-frozen amount without repricing.
 */
export async function buildActorCumulativeFold(input: {
  readonly distributionId: string;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly foldEpochId: bigint;
  readonly statementHash: string;
  readonly chainId: number;
  readonly tokenAddress: HexAddress;
  readonly totalTokenAmount: bigint;
  readonly receiptWeights: readonly ReceiptUnitWeight[];
  readonly lockedClaimants: readonly ReceiptClaimantsRecord[];
  readonly overrides: readonly SubjectOverride[];
  /** All current allocations are required to keep their receipts off the legacy path. */
  readonly currentActorAllocations: readonly ActorContributionAllocationRecord[];
  /** Only these current allocations may create a new outcome on this attempt. */
  readonly unfoldedActorAllocations: readonly ActorContributionAllocationRecord[];
  readonly pendingLiabilities: readonly PendingActorDistributionLiability[];
  readonly priorCumulative: readonly PriorCumulativeBalance[];
  readonly legacyWalletResolver: ClaimantWalletResolver;
  readonly actorWalletResolver: ActorBeneficiaryWalletResolver;
}): Promise<ActorCumulativeFoldResult> {
  const plan = computeActorAwareSettlementPlan({
    receiptWeights: input.receiptWeights,
    lockedClaimants: input.lockedClaimants,
    overrides: input.overrides,
    actorAllocations: input.currentActorAllocations,
    totalTokenAmount: input.totalTokenAmount,
  });
  const unfoldedRefs = new Set(
    input.unfoldedActorAllocations.map((allocation) => allocation.allocationRef)
  );
  const currentAmounts = plan.actorAmounts.filter(({ allocation }) =>
    unfoldedRefs.has(allocation.allocationRef)
  );

  const [legacyResolutions, actorResolutions] = await Promise.all([
    input.legacyWalletResolver.resolveWallets(
      plan.legacyAmounts.map((amount) => amount.claimantKey)
    ),
    input.actorWalletResolver.resolveBeneficiaryWallets([
      ...currentAmounts.map(({ allocation }) => allocation),
      ...input.pendingLiabilities.map(({ allocation }) => allocation),
    ]),
  ]);
  const legacyWalletByKey = new Map(
    legacyResolutions.map((resolution) => [
      resolution.claimantKey,
      resolution.wallet,
    ])
  );
  const actorResolutionByRef = new Map(
    actorResolutions.map((resolution) => [resolution.allocationRef, resolution])
  );

  const epochDeltas: CumulativeEpochDelta[] = [];
  const liabilities: NewLiability[] = [];
  const settlements: NewSettlement[] = [];
  const unresolved = new Set<string>();

  for (const amount of plan.legacyAmounts) {
    const wallet = legacyWalletByKey.get(amount.claimantKey) ?? null;
    if (!wallet) {
      unresolved.add(amount.claimantKey);
      continue;
    }
    epochDeltas.push({
      claimantKey: amount.claimantKey,
      account: wallet,
      deltaAmount: amount.tokenAmount,
      receiptIds: amount.receiptIds,
    });
  }

  for (const { allocation, tokenAmount } of currentAmounts) {
    if (
      allocation.nodeId !== input.nodeId ||
      allocation.scopeId !== input.scopeId ||
      BigInt(allocation.epochId) !== input.foldEpochId
    ) {
      throw new Error(
        `Actor allocation ${allocation.allocationRef} does not belong to the current fold`
      );
    }
    const resolution = actorResolutionByRef.get(allocation.allocationRef);
    if (resolution?.wallet && resolution.bindingEvidence) {
      epochDeltas.push({
        claimantKey: `actor:${allocation.beneficiaryActorId}`,
        account: resolution.wallet,
        deltaAmount: tokenAmount,
        receiptIds: [allocation.receiptId],
      });
      settlements.push({
        allocationRef: allocation.allocationRef,
        liabilityId: null,
        nodeId: allocation.nodeId,
        scopeId: allocation.scopeId,
        sourceEpochId: BigInt(allocation.epochId),
        foldEpochId: input.foldEpochId,
        earnedByActorId: allocation.earnedByActorId,
        beneficiaryActorId: allocation.beneficiaryActorId,
        tokenAmount,
        claimantWallet: resolution.wallet,
        resolverEvidence: resolution.bindingEvidence,
      });
      continue;
    }
    const failure =
      resolution?.failureEvidence ?? missingResolution(allocation);
    liabilities.push({
      allocationRef: allocation.allocationRef,
      nodeId: allocation.nodeId,
      scopeId: allocation.scopeId,
      sourceEpochId: BigInt(allocation.epochId),
      earnedByActorId: allocation.earnedByActorId,
      beneficiaryActorId: allocation.beneficiaryActorId,
      contributionCutoff: new Date(allocation.contributionCutoff),
      tokenAmount,
      sourceEvidenceHash: allocation.sourceEvidenceHash,
      signerActorId: allocation.signerActorId,
      resolverFailure: failure,
    });
    unresolved.add(`actor:${allocation.allocationRef}`);
  }

  for (const pending of input.pendingLiabilities) {
    if (
      pending.nodeId !== input.nodeId ||
      pending.scopeId !== input.scopeId ||
      pending.sourceEpochId === input.foldEpochId
    ) {
      throw new Error(
        `Pending actor liability ${pending.allocationRef} is not eligible for this fold`
      );
    }
    const resolution = actorResolutionByRef.get(pending.allocationRef);
    if (!resolution?.wallet || !resolution.bindingEvidence) {
      unresolved.add(`actor:${pending.allocationRef}`);
      continue;
    }
    epochDeltas.push({
      claimantKey: `actor:${pending.beneficiaryActorId}`,
      account: resolution.wallet,
      deltaAmount: pending.tokenAmount,
      receiptIds: [pending.allocation.receiptId],
    });
    settlements.push({
      allocationRef: pending.allocationRef,
      liabilityId: pending.id,
      nodeId: pending.nodeId,
      scopeId: pending.scopeId,
      sourceEpochId: pending.sourceEpochId,
      foldEpochId: input.foldEpochId,
      earnedByActorId: pending.earnedByActorId,
      beneficiaryActorId: pending.beneficiaryActorId,
      tokenAmount: pending.tokenAmount,
      claimantWallet: resolution.wallet,
      resolverEvidence: resolution.bindingEvidence,
    });
  }

  const distribution =
    epochDeltas.length === 0 && input.priorCumulative.length === 0
      ? null
      : buildDaoTokenCumulativeDistribution({
          distributionId: input.distributionId,
          nodeId: input.nodeId,
          scopeId: input.scopeId,
          statementHash: input.statementHash,
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          priorCumulative: input.priorCumulative,
          epochDeltas,
        });

  return {
    distribution,
    liabilities,
    settlements,
    unresolvedClaimantKeys: [...unresolved].sort(),
  };
}
