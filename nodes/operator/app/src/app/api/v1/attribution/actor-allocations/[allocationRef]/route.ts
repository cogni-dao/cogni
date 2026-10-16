// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/actor-allocations/[allocationRef]`
 * Purpose: Beneficiary-only read of one frozen allocation and settlement lifecycle.
 * Scope: Returns persisted IDs/evidence hashes and payout status, never wallet auth material.
 * Invariants: BENEFICIARY_ONLY; FROZEN_FACTS; PRIVACY_SAFE.
 * Side-effects: IO (HTTP and attribution store read)
 * Links: story.5075, attribution.actor-identity.v1.contract
 * @public
 */

import { actorAllocationOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { resolveRequestPrincipal } from "@/app/_lib/auth/request-identity";
import { resolveAttributionActor } from "@/bootstrap/actor-attribution";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ allocationRef: string }> };

export const GET = wrapRouteHandlerWithLogging<RouteContext>(
  { routeId: "attribution.actor-allocation.read", auth: { mode: "none" } },
  async (_ctx, _request, context) => {
    const principal = await resolveRequestPrincipal();
    if (!principal || principal.kind !== "human") {
      return NextResponse.json({ error: "Human session required" }, { status: 401 });
    }
    const actorId = await resolveAttributionActor({
      kind: "human",
      userId: principal.userId,
    });
    if (!actorId || !context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { allocationRef } = await context.params;
    const lifecycle =
      await getContainer().attributionStore.getActorContributionAllocationLifecycle(
        allocationRef
      );
    if (!lifecycle) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (lifecycle.allocation.beneficiaryActorId !== actorId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(
      actorAllocationOperation.lifecycleOutput.parse({
        ...lifecycle,
        tokenAmount: lifecycle.tokenAmount?.toString() ?? null,
        allocation: {
          ...lifecycle.allocation,
          signedAt: lifecycle.allocation.signedAt.toISOString(),
          createdAt: lifecycle.allocation.createdAt.toISOString(),
        },
      })
    );
  }
);
