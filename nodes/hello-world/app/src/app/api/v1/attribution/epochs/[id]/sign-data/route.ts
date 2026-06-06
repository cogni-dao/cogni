// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/sign-data/route`
 * Purpose: SIWE + approver-gated endpoint returning EIP-712 typed data for epoch signing.
 * Scope: Auth-protected GET endpoint. Returns typed data for epochs in review status. Does not perform mutations.
 * Invariants: WRITE_ROUTES_APPROVER_GATED, SIGNATURE_SCOPE_BOUND.
 * Side-effects: IO (HTTP response, database read)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.sign-data.v1.contract
 * @public
 */

import {
  applyReceiptWeightOverrides,
  buildEIP712TypedData,
  computeFinalClaimantAllocationSetHash,
  computeReceiptWeights,
  explodeToClaimants,
  toReviewSubjectOverrides,
} from "@cogni/attribution-ledger";
import { signDataOperation } from "@cogni/node-contracts";
import { CHAIN_ID } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { checkApprover } from "@/app/api/v1/attribution/_lib/approver-guard";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId, getScopeId } from "@/shared/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.sign-data",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    const store = getContainer().attributionStore;
    const epoch = await store.getEpoch(epochId);
    if (!epoch) {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    // WRITE_ROUTES_APPROVER_GATED — check against epoch's pinned approvers
    const denied = checkApprover(ctx, sessionUser?.walletAddress, epoch);
    if (denied) return denied;

    if (epoch.status !== "review") {
      return NextResponse.json(
        { error: "Epoch must be in review status to sign" },
        { status: 409 }
      );
    }

    if (!epoch.allocationAlgoRef) {
      return NextResponse.json(
        { error: "Epoch missing allocationAlgoRef" },
        { status: 409 }
      );
    }

    // Mirror finalizeEpoch activity logic to produce identical finalAllocationSetHash

    // Pool total
    const poolComponents = await store.getPoolComponentsForEpoch(epochId);
    const poolTotal = poolComponents.reduce(
      (sum, c) => sum + c.amountCredits,
      0n
    );

    // Load locked claimants + receipt weights + overrides → explode to final allocations
    const [lockedClaimants, selections, overrideRecords] = await Promise.all([
      store.loadLockedClaimants(epochId),
      store.getSelectedReceiptsForAllocation(epochId),
      store.getReviewSubjectOverridesForEpoch(epochId),
    ]);

    const rawWeights = computeReceiptWeights(
      epoch.allocationAlgoRef,
      selections,
      epoch.weightConfig
    );
    const overrides = toReviewSubjectOverrides(overrideRecords);
    const receiptWeights = applyReceiptWeightOverrides(rawWeights, overrides);

    const claimantAllocations = explodeToClaimants(
      receiptWeights,
      lockedClaimants,
      overrides
    );

    const finalAllocationSetHash =
      await computeFinalClaimantAllocationSetHash(claimantAllocations);

    const typedData = buildEIP712TypedData({
      nodeId: getNodeId(),
      scopeId: getScopeId(),
      epochId: id,
      finalAllocationSetHash,
      poolTotalCredits: poolTotal.toString(),
      chainId: CHAIN_ID,
    });

    ctx.log.info(
      {
        epochId: id,
        finalAllocationSetHash: `${finalAllocationSetHash.slice(0, 12)}...`,
      },
      "ledger.sign-data_success"
    );

    return NextResponse.json(signDataOperation.output.parse(typedData));
  }
);
