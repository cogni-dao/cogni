// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/users/ownership.server`
 * Purpose: Computes an ownership summary for the authenticated user from receipt-claimant attribution and linked identities.
 * Scope: Reads current user's bindings plus epoch locked claimants + receipt weights. Does not handle HTTP transport or persistence writes.
 * Invariants:
 * - CLAIMANTS_ARE_PLURAL: multi-claimant receipts are treated as first-class
 * - OWNERSHIP_MATCHES_LINKED_IDENTITIES: identity claimants resolve through the
 *   user's current bindings at read time
 * - ALL_MATH_BIGINT: ownership totals stay bigint until final JSON conversion
 * - OPEN_EPOCHS_SKIPPED: open epochs have no locked claimants — omitted from computation (bug.0125)
 * Side-effects: IO (database reads)
 * Links: src/contracts/users.ownership.v1.contract.ts
 * @public
 */

import {
  type AttributionClaimant,
  type AttributionEpoch,
  type AttributionStore,
  claimantKey,
  computeReceiptWeights,
  explodeToClaimants,
  type FinalClaimantAllocation,
} from "@cogni/attribution-ledger";
import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import type { OwnershipSummaryOutput } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { eq } from "drizzle-orm";
import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { getNodeId } from "@/shared/config";
import { userBindings } from "@/shared/db/schema";

const MAX_RECENT_ATTRIBUTIONS = 12;

type AttributionMatch = OwnershipSummaryOutput["recentAttributions"][number];

function toBindingKey(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}

function matchClaimantToUser(
  claimant: AttributionClaimant,
  userId: string,
  bindingKeys: Set<string>
): string | null {
  if (claimant.kind === "user") {
    return claimant.userId === userId ? "user_id" : null;
  }

  const key = toBindingKey(claimant.provider, claimant.externalId);
  if (!bindingKeys.has(key)) return null;
  return claimant.provider;
}

function computeFinalizedSharePercent(
  numerator: bigint,
  denominator: bigint
): number {
  if (denominator <= 0n || numerator <= 0n) return 0;
  const basisPoints = Number(
    (numerator * 10_000n + denominator / 2n) / denominator
  );
  return basisPoints / 100;
}

async function loadAllocationsForEpoch(
  store: AttributionStore,
  epoch: AttributionEpoch
): Promise<FinalClaimantAllocation[] | null> {
  // Open epochs have no locked claimants or allocationAlgoRef — skip
  if (!epoch.allocationAlgoRef) return null;

  const [lockedClaimants, receipts] = await Promise.all([
    store.loadLockedClaimants(epoch.id),
    store.getSelectedReceiptsForAllocation(epoch.id),
  ]);

  if (lockedClaimants.length === 0) return null;

  const receiptWeights = computeReceiptWeights(
    epoch.allocationAlgoRef,
    receipts,
    epoch.weightConfig
  );
  return explodeToClaimants(receiptWeights, lockedClaimants);
}

export async function readOwnershipSummary(
  sessionUser: SessionUser
): Promise<OwnershipSummaryOutput> {
  const db = resolveAppDb();
  const actorId = userActor(sessionUser.id as UserId);

  const bindings = await withTenantScope(db, actorId, async (tx) =>
    tx
      .select({
        provider: userBindings.provider,
        externalId: userBindings.externalId,
      })
      .from(userBindings)
      .where(eq(userBindings.userId, sessionUser.id))
  );

  const bindingKeys = new Set(
    bindings.map((binding) =>
      toBindingKey(binding.provider, binding.externalId)
    )
  );

  const store = getContainer().attributionStore;
  const epochs = await store.listEpochs(getNodeId());
  const epochsDesc = [...epochs].sort((a, b) => Number(b.id - a.id));

  let finalizedUnits = 0n;
  let pendingUnits = 0n;
  let finalizedUniverseUnits = 0n;
  let matchedAttributionCount = 0;
  const matchedEpochs = new Set<string>();
  const recentAttributions: AttributionMatch[] = [];

  for (const epoch of epochsDesc) {
    const allocations = await loadAllocationsForEpoch(store, epoch);
    if (!allocations) continue;

    if (epoch.status === "finalized") {
      finalizedUniverseUnits += allocations.reduce(
        (sum, a) => sum + a.finalUnits,
        0n
      );
    }

    for (const allocation of allocations) {
      const matchedBy = matchClaimantToUser(
        allocation.claimant,
        sessionUser.id,
        bindingKeys
      );
      if (!matchedBy) continue;

      matchedAttributionCount++;
      matchedEpochs.add(epoch.id.toString());

      if (epoch.status === "finalized") {
        finalizedUnits += allocation.finalUnits;
      } else {
        pendingUnits += allocation.finalUnits;
      }

      if (recentAttributions.length < MAX_RECENT_ATTRIBUTIONS) {
        recentAttributions.push({
          epochId: epoch.id.toString(),
          epochStatus: epoch.status,
          subjectRef: claimantKey(allocation.claimant),
          source: null,
          eventType: null,
          units: allocation.finalUnits.toString(),
          matchedBy,
          eventTime: null,
          artifactUrl: null,
        });
      }
    }
  }

  return {
    totalUnits: (finalizedUnits + pendingUnits).toString(),
    finalizedUnits: finalizedUnits.toString(),
    pendingUnits: pendingUnits.toString(),
    finalizedSharePercent: computeFinalizedSharePercent(
      finalizedUnits,
      finalizedUniverseUnits
    ),
    epochsMatched: matchedEpochs.size,
    matchedAttributionCount,
    linkedIdentityCount: bindings.length,
    recentAttributions,
  };
}
