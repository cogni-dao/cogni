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
  computeSignedAllocationSetHash,
  computeReceiptWeights,
  type EIP712DeploymentEnvironment,
  explodeToClaimants,
  parseEIP712DeploymentEnvironment,
  toReviewSubjectOverrides,
} from "@cogni/attribution-ledger";
import { signDataV2Operation } from "@cogni/node-contracts";
import { CHAIN_ID, EVENT_NAMES } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { checkApprover } from "@/app/api/v1/attribution/_lib/approver-guard";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId, getScopeId } from "@/shared/config";
import { serverEnv } from "@/shared/env/server";
import { createRouteTerminalLogger } from "@/shared/observability/server";

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
    const terminal = createRouteTerminalLogger(
      ctx,
      EVENT_NAMES.LEDGER_SIGN_DATA_COMPLETE,
      performance.now()
    );
    if (!context) {
      terminal.internalError();
      throw new Error("context required for dynamic routes");
    }
    try {
      const { id } = await context.params;
      let epochId: bigint;
      try {
        epochId = BigInt(id);
      } catch {
        terminal.complete({
          status: 400,
          outcome: "error",
          errorCode: "invalid_epoch_id",
          reasonCode: "invalid_epoch_id",
        });
        return NextResponse.json(
          { error: "Invalid epoch ID" },
          { status: 400 }
        );
      }

      const store = getContainer().attributionStore;
      const epoch = await store.getEpoch(epochId);
      if (!epoch) {
        terminal.complete({
          status: 404,
          outcome: "error",
          errorCode: "epoch_not_found",
          reasonCode: "epoch_not_found",
        });
        return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
      }

      // WRITE_ROUTES_APPROVER_GATED — check against epoch's pinned approvers
      const denied = checkApprover(ctx, sessionUser?.walletAddress, epoch);
      if (denied) {
        terminal.complete({
          status: denied.status,
          outcome: "error",
          errorCode: "approver_denied",
          reasonCode: "epoch_approver_required",
        });
        return denied;
      }

      if (epoch.status !== "review") {
        terminal.complete({
          status: 409,
          outcome: "error",
          errorCode: "epoch_not_in_review",
          reasonCode: "epoch_not_in_review",
        });
        return NextResponse.json(
          { error: "Epoch must be in review status to sign" },
          { status: 409 }
        );
      }

      if (!epoch.allocationAlgoRef) {
        terminal.complete({
          status: 409,
          outcome: "error",
          errorCode: "allocation_algorithm_missing",
          reasonCode: "allocation_algorithm_missing",
        });
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

      const [existingActorAllocations, actorReceiptIds] = await Promise.all([
        store.listActorContributionAllocationsForEpoch(epochId),
        store.listUnallocatedActorReceiptIdsForEpoch(epochId),
      ]);
      const preparedActorAllocations = await Promise.all(
        actorReceiptIds.map((receiptId) =>
          store.prepareActorContributionAllocation({
            nodeId: getNodeId(),
            epochId,
            receiptId,
          })
        )
      );
      const actorAllocations = [
        ...existingActorAllocations,
        ...preparedActorAllocations,
      ];

      const finalAllocationSetHash = await computeSignedAllocationSetHash(
        claimantAllocations,
        actorAllocations
      );

      let deploymentEnvironment: EIP712DeploymentEnvironment;
      try {
        deploymentEnvironment = parseEIP712DeploymentEnvironment(
          serverEnv().DEPLOY_ENVIRONMENT
        );
      } catch {
        terminal.complete({
          status: 503,
          outcome: "error",
          errorCode: "signing_environment_invalid",
          reasonCode: "deployment_environment_invalid",
        });
        return NextResponse.json(
          {
            error:
              "Epoch signing is unavailable: deployment environment invalid",
            code: "signing_environment_invalid",
          },
          { status: 503 }
        );
      }

      const typedData = buildEIP712TypedData({
        nodeId: getNodeId(),
        scopeId: getScopeId(),
        epochId: id,
        deploymentEnvironment,
        finalAllocationSetHash,
        poolTotalCredits: poolTotal.toString(),
        chainId: CHAIN_ID,
      });

      const output = signDataV2Operation.output.parse(typedData);
      terminal.complete({ status: 200, outcome: "success" });
      return NextResponse.json(output);
    } catch (error) {
      terminal.internalError();
      throw error;
    }
  }
);
