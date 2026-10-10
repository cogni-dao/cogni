// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/tests/actor-cumulative-fold`
 * Purpose: Prove actor beneficiary routing and exactly-once immutable liability carry-forward behavior.
 * Scope: Unit tests for the actor cumulative fold with in-memory resolver doubles; no database or network access.
 * Invariants: PINNED_WALLET_CREDITED, LIABILITY_AMOUNT_NOT_REPRICED, NON_SORTABLE_EPOCH_IDS_SAFE.
 * Side-effects: none
 * Links: packages/attribution-pipeline-plugins/src/finalize/actor-cumulative-fold.ts
 * @internal
 */

import type { ClaimantWalletResolver } from "@cogni/aragon-osx";
import type {
  ActorBeneficiaryWalletResolver,
  ActorContributionAllocationRecord,
  PendingActorDistributionLiability,
} from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";

import { buildActorCumulativeFold } from "../src/finalize/actor-cumulative-fold";

const NODE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const SCOPE_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const DEREK_WALLET = "0x1111111111111111111111111111111111111111" as const;
const EMPTY_LEGACY_RESOLVER: ClaimantWalletResolver = {
  resolveWallets: async (keys) =>
    keys.map((claimantKey) => ({ claimantKey, userId: null, wallet: null })),
};

function allocation(epochId = 91n): ActorContributionAllocationRecord {
  return {
    allocationRef: "actor-allocation-v1:not-sortable-z",
    contractVersion: "actor.contribution.allocation.v1",
    nodeId: NODE_ID,
    scopeId: SCOPE_ID,
    epochId: epochId.toString(),
    receiptId: "github:flock-leader:pr-2663",
    earnedByActorId: "actor:flock-leader",
    beneficiaryActorId: "actor:derek",
    beneficiaryPolicyId: "policy:derek-owns-flock-leader",
    beneficiaryPolicyVersion: "v1",
    contributionCutoff: "2026-10-01T00:00:00.000Z",
    sourceEvidence: {
      provider: "github",
      immutableExternalId: "flock-leader",
      payloadHash: "0xsource",
      bindingId: "binding:flock-leader",
      bindingEvidenceEventId: "event:flock-leader",
    },
    sourceEvidenceHash: "0xevidence",
    signerActorId: "actor:derek",
    signerWallet: DEREK_WALLET,
    signature: "0xsigned",
    signedAt: new Date("2026-10-02T00:00:00.000Z"),
    createdAt: new Date("2026-10-02T00:00:01.000Z"),
  };
}

const derekResolver: ActorBeneficiaryWalletResolver = {
  resolveBeneficiaryWallets: async (allocations) =>
    allocations.map((item) => ({
      allocationRef: item.allocationRef,
      beneficiaryActorId: item.beneficiaryActorId,
      wallet: DEREK_WALLET,
      bindingEvidence: {
        bindingId: "wallet-binding:derek",
        evidenceEventId: "wallet-event:derek",
        actorId: "actor:derek",
        provider: "wallet",
        externalId: DEREK_WALLET,
        bindingCreatedAt: "2026-09-01T00:00:00.000Z",
        eventType: "bound",
        authorizedByActorId: "actor:derek",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        bindingEvidence: { ceremony: "siwe" },
      },
      failureEvidence: null,
    })),
};

function currentFoldInput(actorAllocation: ActorContributionAllocationRecord) {
  return {
    distributionId: "epoch-91",
    nodeId: NODE_ID,
    scopeId: SCOPE_ID,
    foldEpochId: 91n,
    statementHash: "0xstatement",
    chainId: 8453,
    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
    totalTokenAmount: 10n * 10n ** 18n,
    receiptWeights: [{ receiptId: actorAllocation.receiptId, units: 10n }],
    lockedClaimants: [
      {
        id: "claimants:flock-leader",
        nodeId: NODE_ID,
        epochId: 91n,
        receiptId: actorAllocation.receiptId,
        status: "locked" as const,
        resolverRef: "github",
        algoRef: "claimant-shares-v0",
        inputsHash: "0xinputs",
        claimantKeys: ["identity:github:flock-leader"],
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        createdBy: null,
      },
    ],
    overrides: [],
    currentActorAllocations: [actorAllocation],
    unfoldedActorAllocations: [actorAllocation],
    pendingLiabilities: [],
    priorCumulative: [],
    legacyWalletResolver: EMPTY_LEGACY_RESOLVER,
  };
}

describe("actor cumulative fold", () => {
  it("credits a flock-leader contribution to the explicitly pinned Derek actor wallet", async () => {
    const actorAllocation = allocation();
    const result = await buildActorCumulativeFold({
      ...currentFoldInput(actorAllocation),
      actorWalletResolver: derekResolver,
    });

    expect(result.liabilities).toEqual([]);
    expect(result.settlements).toHaveLength(1);
    expect(result.settlements[0]).toMatchObject({
      allocationRef: actorAllocation.allocationRef,
      earnedByActorId: "actor:flock-leader",
      beneficiaryActorId: "actor:derek",
      claimantWallet: DEREK_WALLET,
      tokenAmount: 10n * 10n ** 18n,
    });
    expect(result.distribution?.mintDelta).toBe(10n * 10n ** 18n);
    expect(result.distribution?.leaves).toEqual([
      expect.objectContaining({
        account: DEREK_WALLET,
        cumulativeAmount: 10n * 10n ** 18n,
      }),
    ]);
  });

  it("freezes an unresolved amount and carries that exact amount into the next eligible fold", async () => {
    const actorAllocation = allocation(91n);
    const unresolvedResolver: ActorBeneficiaryWalletResolver = {
      resolveBeneficiaryWallets: async (allocations) =>
        allocations.map((item) => ({
          allocationRef: item.allocationRef,
          beneficiaryActorId: item.beneficiaryActorId,
          wallet: null,
          bindingEvidence: null,
          failureEvidence: {
            code: "beneficiary_wallet_unbound",
            beneficiaryActorId: item.beneficiaryActorId,
            observedBindingIds: [],
          },
        })),
    };
    const original = await buildActorCumulativeFold({
      ...currentFoldInput(actorAllocation),
      actorWalletResolver: unresolvedResolver,
    });
    expect(original.distribution).toBeNull();
    expect(original.liabilities).toHaveLength(1);
    expect(original.liabilities[0]?.tokenAmount).toBe(10n * 10n ** 18n);

    const frozenLiability = original.liabilities[0];
    if (!frozenLiability) throw new Error("Expected frozen actor liability");
    const pending: PendingActorDistributionLiability = {
      ...frozenLiability,
      id: "liability:not-sortable-a",
      createdAt: new Date("2026-10-03T00:00:00.000Z"),
      allocation: actorAllocation,
    };
    const carried = await buildActorCumulativeFold({
      distributionId: "epoch-4",
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      foldEpochId: 4n,
      statementHash: "0xlater-statement",
      chainId: 8453,
      tokenAddress: "0x2222222222222222222222222222222222222222",
      totalTokenAmount: 999n * 10n ** 18n,
      receiptWeights: [],
      lockedClaimants: [],
      overrides: [],
      currentActorAllocations: [],
      unfoldedActorAllocations: [],
      pendingLiabilities: [pending],
      priorCumulative: [],
      legacyWalletResolver: EMPTY_LEGACY_RESOLVER,
      actorWalletResolver: derekResolver,
    });

    expect(carried.liabilities).toEqual([]);
    expect(carried.settlements).toEqual([
      expect.objectContaining({
        allocationRef: actorAllocation.allocationRef,
        liabilityId: pending.id,
        sourceEpochId: 91n,
        foldEpochId: 4n,
        tokenAmount: 10n * 10n ** 18n,
      }),
    ]);
    expect(carried.distribution?.mintDelta).toBe(10n * 10n ** 18n);
  });
});
