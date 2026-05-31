// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/attribution/claimants.server`
 * Purpose: Server-only facade helpers for claimant-aware attribution reads.
 * Scope: Loads claimant allocations from finalized epoch data (statement lines, final allocations, or locked claimants + receipt weights) and maps to contract output. Does not handle HTTP transport.
 * Invariants:
 * - FINALIZED_ONLY: readFinalizedEpochClaimants requires epoch status='finalized'
 * - THREE_TIER_FALLBACK: statement lines → final claimant allocations → locked claimants + receipt weights
 * - NO_LEGACY_SHIM: old ClaimantSharesSubject model fully pruned (bug.0125)
 * Side-effects: IO (database reads)
 * Links: src/contracts/attribution.epoch-claimants.v1.contract.ts
 * @public
 */

import {
  type AttributionClaimant,
  type AttributionEpoch,
  type AttributionStore,
  claimantKey,
  computeAttributionStatementLines,
  computeReceiptWeights,
  explodeToClaimants,
} from "@cogni/attribution-ledger";
import type {
  EpochClaimantLineItemDto,
  EpochClaimantsOutput,
} from "@cogni/node-contracts";
import { getContainer } from "@/bootstrap/container";

function toLineItemDto(params: {
  claimant: AttributionClaimant;
  displayName: string | null;
  isLinked: boolean;
  totalUnits: bigint;
  share: string;
  amountCredits: bigint;
  receiptIds: readonly string[];
}): EpochClaimantLineItemDto {
  return {
    claimantKey: claimantKey(params.claimant),
    claimant: params.claimant,
    displayName: params.displayName,
    isLinked: params.isLinked,
    totalUnits: params.totalUnits.toString(),
    share: params.share,
    amountCredits: params.amountCredits.toString(),
    receiptIds: [...params.receiptIds],
  };
}

function parseClaimantItemsFromStatement(
  statementLines: ReadonlyArray<{
    claimant_key: string;
    claimant: AttributionClaimant;
    final_units: string;
    pool_share: string;
    credit_amount: string;
    receipt_ids: readonly string[];
  }>
): EpochClaimantLineItemDto[] | null {
  const parsedItems: EpochClaimantLineItemDto[] = [];

  for (const item of statementLines) {
    let totalUnits: bigint;
    let amountCredits: bigint;
    try {
      totalUnits = BigInt(item.final_units);
      amountCredits = BigInt(item.credit_amount);
    } catch {
      return null;
    }

    parsedItems.push({
      claimantKey: claimantKey(item.claimant),
      claimant: item.claimant,
      displayName: null,
      isLinked: item.claimant.kind === "user",
      totalUnits: totalUnits.toString(),
      share: item.pool_share,
      amountCredits: amountCredits.toString(),
      receiptIds: [...item.receipt_ids],
    });
  }

  return parsedItems;
}

async function enrichClaimantPresentation(
  store: AttributionStore,
  epoch: AttributionEpoch,
  items: readonly EpochClaimantLineItemDto[]
): Promise<EpochClaimantLineItemDto[]> {
  const receipts = await store.getReceiptsForWindow(
    epoch.nodeId,
    epoch.periodStart,
    epoch.periodEnd
  );
  const receiptsById = new Map(
    receipts.map((receipt) => [receipt.receiptId, receipt])
  );

  const githubIdentityIds = items
    .filter(
      (
        item
      ): item is EpochClaimantLineItemDto & {
        claimant: {
          kind: "identity";
          provider: "github";
          externalId: string;
          providerLogin: string | null;
        };
      } =>
        item.claimant.kind === "identity" && item.claimant.provider === "github"
    )
    .map((item) => item.claimant.externalId);

  const resolvedIdentities = await store.resolveIdentities(
    "github",
    githubIdentityIds
  );
  const userIds = new Set<string>();
  for (const item of items) {
    if (item.claimant.kind === "user") {
      userIds.add(item.claimant.userId);
      continue;
    }
    if (item.claimant.provider !== "github") continue;
    const resolvedUserId = resolvedIdentities.get(item.claimant.externalId);
    if (resolvedUserId) {
      userIds.add(resolvedUserId);
    }
  }

  const userDisplayNames = await store.getUserDisplayNames([...userIds]);

  return items.map((item) => {
    const receiptLogin =
      item.receiptIds
        .map(
          (receiptId) =>
            receiptsById.get(receiptId)?.platformLogin?.trim() ?? null
        )
        .find((login) => login && login.length > 0) ?? null;

    if (item.claimant.kind === "user") {
      return {
        ...item,
        displayName:
          userDisplayNames.get(item.claimant.userId) ?? receiptLogin ?? null,
        isLinked: true,
      };
    }

    if (item.claimant.provider !== "github") {
      return {
        ...item,
        displayName: item.claimant.providerLogin ?? receiptLogin ?? null,
        isLinked: false,
      };
    }

    const resolvedUserId = resolvedIdentities.get(item.claimant.externalId);
    if (!resolvedUserId) {
      return {
        ...item,
        displayName: item.claimant.providerLogin ?? receiptLogin ?? null,
        isLinked: false,
      };
    }

    return {
      ...item,
      displayName:
        userDisplayNames.get(resolvedUserId) ??
        item.claimant.providerLogin ??
        receiptLogin ??
        null,
      isLinked: true,
    };
  });
}

export async function readFinalizedEpochClaimants(
  epochId: bigint
): Promise<EpochClaimantsOutput> {
  const store = getContainer().attributionStore;
  const epoch = await store.getEpoch(epochId);
  if (!epoch) {
    throw new Error(
      `readFinalizedEpochClaimants: epoch ${epochId.toString()} not found`
    );
  }
  if (epoch.status !== "finalized") {
    throw new Error(
      `readFinalizedEpochClaimants: epoch ${epochId.toString()} is '${epoch.status}', expected 'finalized'`
    );
  }
  if (epoch.poolTotalCredits === null) {
    throw new Error(
      `readFinalizedEpochClaimants: epoch ${epochId.toString()} missing poolTotalCredits`
    );
  }

  const statement = await store.getStatementForEpoch(epoch.id);
  const statementLines = statement
    ? parseClaimantItemsFromStatement(statement.statementLines)
    : null;
  if (statement && statementLines) {
    return {
      epochId: epoch.id.toString(),
      poolTotalCredits: statement.poolTotalCredits.toString(),
      items: await enrichClaimantPresentation(store, epoch, statementLines),
      reviewOverrides:
        statement.reviewOverrides?.map((o) => ({
          subject_ref: o.subject_ref,
          original_units: o.original_units,
          override_units: o.override_units ?? null,
          reason: o.reason ?? null,
        })) ?? null,
    };
  }

  const finalClaimantAllocations =
    await store.getFinalClaimantAllocationsForEpoch(epoch.id);
  if (finalClaimantAllocations.length > 0) {
    const items = computeAttributionStatementLines(
      finalClaimantAllocations.map((allocation) => ({
        claimant: allocation.claimant,
        finalUnits: allocation.finalUnits,
        receiptIds: allocation.receiptIds,
      })),
      epoch.poolTotalCredits
    ).map((item) =>
      toLineItemDto({
        claimant: item.claimant,
        displayName: null,
        isLinked: item.claimant.kind === "user",
        totalUnits: item.finalUnits,
        share: item.poolShare,
        amountCredits: item.creditAmount,
        receiptIds: item.receiptIds,
      })
    );

    return {
      epochId: epoch.id.toString(),
      poolTotalCredits: epoch.poolTotalCredits.toString(),
      items: await enrichClaimantPresentation(store, epoch, items),
    };
  }

  // Fallback: recompute from locked claimants + receipt weights
  const [lockedClaimants, receipts] = await Promise.all([
    store.loadLockedClaimants(epoch.id),
    store.getSelectedReceiptsForAllocation(epoch.id),
  ]);

  if (!epoch.allocationAlgoRef) {
    throw new Error(
      `readFinalizedEpochClaimants: epoch ${epochId.toString()} missing allocationAlgoRef`
    );
  }

  const receiptWeights = computeReceiptWeights(
    epoch.allocationAlgoRef,
    receipts,
    epoch.weightConfig
  );
  const claimantAllocations = explodeToClaimants(
    receiptWeights,
    lockedClaimants
  );

  const items = computeAttributionStatementLines(
    claimantAllocations,
    epoch.poolTotalCredits
  ).map((item) =>
    toLineItemDto({
      claimant: item.claimant,
      displayName: null,
      isLinked: item.claimant.kind === "user",
      totalUnits: item.finalUnits,
      share: item.poolShare,
      amountCredits: item.creditAmount,
      receiptIds: item.receiptIds,
    })
  );

  return {
    epochId: epoch.id.toString(),
    poolTotalCredits: epoch.poolTotalCredits.toString(),
    items: await enrichClaimantPresentation(store, epoch, items),
  };
}
