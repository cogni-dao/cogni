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
import { EVENT_NAMES } from "@/shared/observability";
import { createRouteTerminalLogger } from "@/shared/observability/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ allocationRef: string }> };

export const GET = wrapRouteHandlerWithLogging<RouteContext>(
  { routeId: "attribution.actor-allocation.read", auth: { mode: "none" } },
  async (ctx, _request, _sessionUser, context) => {
    const startedAt = performance.now();
    const terminal = createRouteTerminalLogger(
      ctx,
      EVENT_NAMES.LEDGER_ACTOR_ALLOCATION_READ_COMPLETE,
      startedAt
    );
    try {
      const principal = await resolveRequestPrincipal();
      if (!principal || principal.kind !== "human") {
        terminal.complete({
          status: 401,
          outcome: "error",
          errorCode: "human_session_required",
          reasonCode: "human_session_required",
        });
        return NextResponse.json(
          { error: "Human session required" },
          { status: 401 }
        );
      }
      const actorId = await resolveAttributionActor({
        kind: "human",
        userId: principal.userId,
      });
      if (!actorId || !context) {
        terminal.complete({
          status: 401,
          outcome: "error",
          errorCode: "unauthorized",
          reasonCode: "actor_not_resolved",
        });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const { allocationRef } = await context.params;
      const lifecycle =
        await getContainer().attributionStore.getActorContributionAllocationLifecycle(
          allocationRef
        );
      if (!lifecycle) {
        terminal.complete({
          status: 404,
          outcome: "error",
          errorCode: "not_found",
          reasonCode: "allocation_not_found",
        });
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      if (lifecycle.resolvedBeneficiaryActorId !== actorId) {
        terminal.complete({
          status: 403,
          outcome: "error",
          errorCode: "forbidden",
          reasonCode: "beneficiary_only",
        });
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const output = actorAllocationOperation.lifecycleOutput.parse({
        ...lifecycle,
        tokenAmount: lifecycle.tokenAmount?.toString() ?? null,
        allocation: {
          ...lifecycle.allocation,
          createdAt: lifecycle.allocation.createdAt.toISOString(),
        },
      });
      terminal.complete({ status: 200, outcome: "success" });
      return NextResponse.json(output);
    } catch (error) {
      terminal.internalError();
      throw error;
    }
  }
);
