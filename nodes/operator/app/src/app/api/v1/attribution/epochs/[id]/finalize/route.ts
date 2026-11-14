// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/finalize/route`
 * Purpose: SIWE + approver-gated endpoint for finalizing an epoch (review → finalized) with EIP-712 signature.
 * Scope: Auth-protected POST endpoint. Finalizes IN-PROCESS on this node's own DB (story.5007 finalize-in-process) — no Temporal round-trip, no ledger-tasks queue. Returns 200 + the statement + R3 cumulative distribution. Delegates all logic to `finalizeEpochInProcess` (bootstrap) → `runFinalizeEpoch`.
 * Invariants: WRITE_ROUTES_APPROVER_GATED, FINALIZE_IN_PROCESS, EPOCH_FINALIZE_IDEMPOTENT (a re-POST repairs; fold FREEZE preserves a published manifest).
 * Side-effects: IO (HTTP response, service-DB finalize transaction, viem EIP-712 verify, in-process distribution-config read).
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger, contracts/attribution.finalize-epoch.v1.contract, bootstrap/container#finalizeEpochInProcess
 * @public
 */

import { isFinalizeEpochError } from "@cogni/attribution-pipeline-plugins";
import {
  FinalizeEpochInputSchema,
  finalizeEpochOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { checkApprover } from "@/app/api/v1/attribution/_lib/approver-guard";
import { finalizeEpochInProcess, getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.finalize-epoch",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    // Load epoch so we can check against pinned approvers (APPROVERS_PINNED_AT_REVIEW)
    const store = getContainer().attributionStore;
    const epoch = await store.getEpoch(epochId);
    if (!epoch) {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    // WRITE_ROUTES_APPROVER_GATED — checks against epoch's pinned approvers
    const denied = checkApprover(ctx, sessionUser?.walletAddress, epoch);
    if (denied) return denied;

    // Parse and validate request body
    const body = await request.json();
    const parsed = FinalizeEpochInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.format() },
        { status: 400 }
      );
    }

    const { signature } = parsed.data;
    const signerAddress = sessionUser?.walletAddress;
    if (!signerAddress) {
      return NextResponse.json(
        { error: "SIWE session missing wallet address" },
        { status: 401 }
      );
    }

    // FINALIZE_IN_PROCESS (story.5007): finalize synchronously on this node's own DB —
    // sign-verify → atomic off-chain finalize → R3 cumulative fold — instead of dispatching
    // a Temporal FinalizeEpochWorkflow. Idempotent: a re-POST on an already-finalized epoch
    // repairs; the fold FREEZE (bug.5022) preserves a published manifest.
    try {
      const result = await finalizeEpochInProcess(
        { epochId: epochId.toString(), signature, signerAddress },
        ctx.log
      );

      // Deterministic terminal (https://node-template.cognidao.org/knowledge/observability-logging-contract): exactly one of completed / rejected.
      ctx.log.info(
        {
          epochId: id,
          statementId: result.statementId,
          statementLineCount: result.statementLineCount,
          published: result.cumulativeDistribution !== null,
        },
        "ledger.finalize_completed"
      );

      return NextResponse.json(finalizeEpochOperation.output.parse(result), {
        status: 200,
      });
    } catch (err) {
      // FAULT_PARTY_BEFORE_BUCKET (https://node-template.cognidao.org/knowledge/layered-error-translation): a client-fault finalize failure
      // (wrong epoch state / unknown signer / invalid signature) is a typed FinalizeEpochError
      // → HTTP 422 with its stable `code`. It must NOT collapse into the 500 alarm bucket.
      // Anything else (data-integrity mismatch, DB fault) is rethrown → the wrapper's 500.
      if (isFinalizeEpochError(err)) {
        ctx.log.warn(
          { epochId: id, code: err.code, reason: err.message },
          "ledger.finalize_rejected"
        );
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: 422 }
        );
      }
      throw err;
    }
  }
);
