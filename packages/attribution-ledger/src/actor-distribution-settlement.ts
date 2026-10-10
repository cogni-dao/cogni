// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/actor-distribution-settlement`
 * Purpose: Deterministically route finalized receipt weights to frozen actor beneficiaries and legacy claimants.
 * Scope: Pure settlement arithmetic over immutable allocation and claimant inputs; does not resolve wallets or perform I/O.
 * Invariants: ACTOR_AMOUNT_FROZEN_AT_FIRST_FOLD, LARGEST_REMAINDER_DETERMINISTIC, LEGACY_RECEIPTS_PRESERVED.
 * Side-effects: none
 * Links: docs/spec/attribution-ledger.md, docs/spec/identity-model.md
 * @public
 */

import type { ReceiptUnitWeight } from "./allocation";
import {
  type AttributionClaimant,
  claimantKey,
  explodeToClaimants,
  type SubjectOverride,
} from "./claimant-shares";
import type {
  ActorContributionAllocationRecord,
  ReceiptClaimantsRecord,
} from "./store";

export interface ActorSettlementAmount {
  readonly allocation: ActorContributionAllocationRecord;
  /** Exact ERC20 base-unit amount frozen for this allocation at its first fold. */
  readonly tokenAmount: bigint;
}

export interface LegacySettlementAmount {
  readonly claimantKey: string;
  readonly claimant: AttributionClaimant;
  readonly tokenAmount: bigint;
  readonly receiptIds: readonly string[];
}

export interface ActorAwareSettlementPlan {
  readonly actorAmounts: readonly ActorSettlementAmount[];
  readonly legacyAmounts: readonly LegacySettlementAmount[];
}

interface WeightedSubject {
  readonly key: string;
  readonly units: bigint;
}

/** Largest-remainder allocation over stable subject keys. */
function allocateAmounts(
  subjects: readonly WeightedSubject[],
  totalAmount: bigint
): ReadonlyMap<string, bigint> {
  if (totalAmount < 0n)
    throw new RangeError("totalAmount must be non-negative");
  const totalUnits = subjects.reduce((sum, subject) => {
    if (subject.units < 0n) {
      throw new RangeError(`negative settlement units for ${subject.key}`);
    }
    return sum + subject.units;
  }, 0n);
  if (totalUnits === 0n || totalAmount === 0n) return new Map();

  const floors = subjects
    .filter((subject) => subject.units > 0n)
    .map((subject) => ({
      ...subject,
      floor: (subject.units * totalAmount) / totalUnits,
      remainder: (subject.units * totalAmount) % totalUnits,
    }));
  const amounts = new Map(floors.map((entry) => [entry.key, entry.floor]));
  let residual =
    totalAmount - floors.reduce((sum, entry) => sum + entry.floor, 0n);
  const remainderOrder = [...floors].sort((a, b) => {
    if (a.remainder !== b.remainder) {
      return a.remainder > b.remainder ? -1 : 1;
    }
    return a.key.localeCompare(b.key);
  });
  for (const entry of remainderOrder) {
    if (residual === 0n) break;
    amounts.set(entry.key, (amounts.get(entry.key) ?? 0n) + 1n);
    residual -= 1n;
  }
  return amounts;
}

/**
 * Route finalized receipt weights to frozen actor beneficiaries without
 * rewriting the signed legacy statement. Actor allocations are keyed by their
 * immutable allocationRef so each receives one exact base-unit amount that can
 * later become an append-only liability. Receipts without an actor allocation
 * preserve the existing locked claimant/override behavior.
 */
export function computeActorAwareSettlementPlan(input: {
  readonly receiptWeights: readonly ReceiptUnitWeight[];
  readonly lockedClaimants: readonly ReceiptClaimantsRecord[];
  readonly overrides: readonly SubjectOverride[];
  readonly actorAllocations: readonly ActorContributionAllocationRecord[];
  readonly totalTokenAmount: bigint;
}): ActorAwareSettlementPlan {
  const actorByReceipt = new Map<string, ActorContributionAllocationRecord>();
  for (const allocation of input.actorAllocations) {
    if (actorByReceipt.has(allocation.receiptId)) {
      throw new Error(
        `multiple actor allocations for receipt ${allocation.receiptId}`
      );
    }
    actorByReceipt.set(allocation.receiptId, allocation);
  }

  const actorWeightByRef = new Map<string, bigint>();
  const legacyWeights: ReceiptUnitWeight[] = [];
  for (const weight of input.receiptWeights) {
    const actorAllocation = actorByReceipt.get(weight.receiptId);
    if (!actorAllocation) {
      legacyWeights.push(weight);
      continue;
    }
    actorWeightByRef.set(actorAllocation.allocationRef, weight.units);
  }

  const legacyAllocations = explodeToClaimants(
    legacyWeights,
    input.lockedClaimants,
    input.overrides
  );
  const subjects: WeightedSubject[] = [
    ...input.actorAllocations.map((allocation) => ({
      key: `actor:${allocation.allocationRef}`,
      units: actorWeightByRef.get(allocation.allocationRef) ?? 0n,
    })),
    ...legacyAllocations.map((allocation) => ({
      key: `legacy:${claimantKey(allocation.claimant)}`,
      units: allocation.finalUnits,
    })),
  ].sort((a, b) => a.key.localeCompare(b.key));

  const amounts = allocateAmounts(subjects, input.totalTokenAmount);
  return {
    actorAmounts: [...input.actorAllocations]
      .sort((a, b) => a.allocationRef.localeCompare(b.allocationRef))
      .flatMap((allocation) => {
        const tokenAmount =
          amounts.get(`actor:${allocation.allocationRef}`) ?? 0n;
        return tokenAmount > 0n ? [{ allocation, tokenAmount }] : [];
      }),
    legacyAmounts: legacyAllocations
      .map((allocation) => {
        const key = claimantKey(allocation.claimant);
        return {
          claimantKey: key,
          claimant: allocation.claimant,
          tokenAmount: amounts.get(`legacy:${key}`) ?? 0n,
          receiptIds: [...(allocation.receiptIds ?? [])].sort(),
        };
      })
      .filter((allocation) => allocation.tokenAmount > 0n)
      .sort((a, b) => a.claimantKey.localeCompare(b.claimantKey)),
  };
}
