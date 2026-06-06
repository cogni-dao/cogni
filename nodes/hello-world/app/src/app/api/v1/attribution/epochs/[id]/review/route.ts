// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/review/route`
 * Purpose: SIWE + approver-gated endpoint for transitioning an epoch from open → review.
 * Scope: Auth-protected POST endpoint. Pins approver list and hash at close. Does not accept a request body.
 * Invariants: WRITE_ROUTES_APPROVER_GATED, APPROVERS_PINNED_AT_REVIEW, INGESTION_CLOSED_ON_REVIEW.
 * Side-effects: IO (HTTP response, database write)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.review-epoch.v1.contract
 * @public
 */

import {
  computeApproverSetHash,
  computeWeightConfigHash,
  deriveAllocationAlgoRef,
  validateWeightConfig,
} from "@cogni/attribution-ledger";
import { reviewEpochOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { checkApprover } from "@/app/api/v1/attribution/_lib/approver-guard";
import { toEpochDto } from "@/app/api/v1/public/attribution/_lib/attribution-dto";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getLedgerApprovers } from "@/shared/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.review-epoch",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    // WRITE_ROUTES_APPROVER_GATED
    const denied = checkApprover(ctx, sessionUser?.walletAddress);
    if (denied) return denied;

    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    // APPROVERS_PINNED_AT_REVIEW: pin current approver set + hash on the epoch
    const approvers = getLedgerApprovers();
    const approverSetHash = await computeApproverSetHash(approvers);

    const store = getContainer().attributionStore;

    // Load epoch to get weightConfig for CONFIG_LOCKED_AT_REVIEW
    const existing = await store.getEpoch(epochId);
    if (!existing) {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    // Validate and lock config at review
    validateWeightConfig(existing.weightConfig);
    const weightConfigHash = await computeWeightConfigHash(
      existing.weightConfig
    );
    // V0: derive from first source's attribution_pipeline or default
    const allocationAlgoRef = deriveAllocationAlgoRef("cogni-v0.0");

    const epoch = await store.closeIngestion(
      epochId,
      approvers,
      approverSetHash,
      allocationAlgoRef,
      weightConfigHash
    );

    ctx.log.info(
      { epochId: id, approverSetHash: `${approverSetHash.slice(0, 12)}...` },
      "ledger.review-epoch_success"
    );

    return NextResponse.json(
      reviewEpochOperation.output.parse({ epoch: toEpochDto(epoch) })
    );
  }
);
