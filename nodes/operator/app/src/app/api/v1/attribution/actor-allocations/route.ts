// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/actor-allocations`
 * Purpose: Prepare typed data and persist beneficiary-signed actor allocations.
 * Scope: Exact-principal authenticated HTTP adapter over the attribution composition root.
 * Invariants: BENEFICIARY_SIG_REQUIRED; SOURCE_OWNER_AT_CUTOFF; NO_LEGACY_AGENT.
 * Side-effects: IO (HTTP, database, EIP-712 verification)
 * Links: story.5075, attribution.actor-identity.v1.contract
 * @public
 */

import { actorAllocationOperation } from "@cogni/node-contracts";
import { EVENT_NAMES } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { resolveRequestPrincipal } from "@/app/_lib/auth/request-identity";
import {
  persistActorAllocation,
  prepareActorAllocation,
  resolveAttributionActor,
} from "@/bootstrap/actor-attribution";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function humanActor() {
  const principal = await resolveRequestPrincipal();
  if (!principal || principal.kind !== "human") return null;
  const actorId = await resolveAttributionActor({
    kind: "human",
    userId: principal.userId,
  });
  return actorId ? { actorId, principal } : null;
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "attribution.actor-allocation.prepare", auth: { mode: "none" } },
  async (_ctx, request) => {
    const caller = await humanActor();
    if (!caller)
      return NextResponse.json(
        { error: "Human session required" },
        { status: 401 }
      );
    const url = new URL(request.url);
    const input = actorAllocationOperation.readInput.parse({
      epochId: url.searchParams.get("epochId"),
      receiptId: url.searchParams.get("receiptId"),
    });
    try {
      const prepared = await prepareActorAllocation(input);
      if (prepared.allocation.beneficiaryActorId !== caller.actorId) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      return NextResponse.json(
        actorAllocationOperation.typedDataOutput.parse(prepared)
      );
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Allocation unavailable",
        },
        { status: 409 }
      );
    }
  }
);

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "attribution.actor-allocation.sign", auth: { mode: "none" } },
  async (ctx, request) => {
    const caller = await humanActor();
    if (!caller)
      return NextResponse.json(
        { error: "Human session required" },
        { status: 401 }
      );
    const input = actorAllocationOperation.signInput.parse(
      await request.json()
    );
    try {
      const record = await persistActorAllocation({
        ...input,
        signerActorId: caller.actorId,
      });
      ctx.log.info(
        {
          event: EVENT_NAMES.LEDGER_ACTOR_ALLOCATION_SIGNED,
          allocationRef: record.allocationRef,
          epochId: record.epochId,
        },
        "actor contribution allocation signed"
      );
      return NextResponse.json(
        actorAllocationOperation.recordOutput.parse({
          ...record,
          signedAt: record.signedAt.toISOString(),
          createdAt: record.createdAt.toISOString(),
        })
      );
    } catch (error) {
      ctx.log.warn(
        {
          event: EVENT_NAMES.LEDGER_ACTOR_ALLOCATION_REJECTED,
          epochId: input.epochId,
          reason: error instanceof Error ? error.message : "unknown",
        },
        "actor contribution allocation rejected"
      );
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Allocation rejected",
        },
        { status: 409 }
      );
    }
  }
);
