// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/beneficiary-policies`
 * Purpose: Principal-aware governed beneficiary proposal, acceptance, revoke, and read.
 * Scope: Authenticates the exact human/agent caller; business rules live below the route.
 * Invariants: NO_LEGACY_AGENT; DIRECT_ROLE_ACCEPTANCE; NO_IMPLICIT_BENEFICIARY.
 * Side-effects: IO (HTTP and attribution store)
 * Links: story.5075, attribution.actor-identity.v1.contract
 * @public
 */

import { actorBeneficiaryPolicyOperation } from "@cogni/node-contracts";
import { EVENT_NAMES } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { resolveRequestPrincipal } from "@/app/_lib/auth/request-identity";
import { checkApprover } from "@/app/api/v1/attribution/_lib/approver-guard";
import {
  mutateBeneficiaryPolicy,
  resolveAttributionActor,
  serializeBeneficiaryProposal,
} from "@/bootstrap/actor-attribution";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function exactActor() {
  const principal = await resolveRequestPrincipal();
  if (!principal || principal.kind === "legacy_agent") return null;
  const actorId = await resolveAttributionActor(
    principal.kind === "agent"
      ? { kind: "agent", actorId: principal.actorId }
      : { kind: "human", userId: principal.userId }
  );
  return actorId ? { actorId, principal } : null;
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "attribution.beneficiary-policy.read", auth: { mode: "none" } },
  async (_ctx, request) => {
    const caller = await exactActor();
    if (!caller)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const proposalId = new URL(request.url).searchParams.get("proposalId");
    if (!proposalId) {
      return NextResponse.json(
        { error: "proposalId is required" },
        { status: 400 }
      );
    }
    const proposal =
      await getContainer().attributionStore.getActorBeneficiaryPolicyProposal(
        proposalId
      );
    if (!proposal)
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (
      caller.actorId !== proposal.earnedByActorId &&
      caller.actorId !== proposal.stewardActorId &&
      caller.actorId !== proposal.beneficiaryActorId
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(
      actorBeneficiaryPolicyOperation.output.parse(
        serializeBeneficiaryProposal(proposal)
      )
    );
  }
);

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "attribution.beneficiary-policy.write", auth: { mode: "none" } },
  async (ctx, request) => {
    const caller = await exactActor();
    if (!caller)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const mutation = actorBeneficiaryPolicyOperation.input.parse(
      await request.json()
    );
    let governanceOverride = false;
    if (mutation.action === "revoke") {
      const proposal =
        await getContainer().attributionStore.getActorBeneficiaryPolicyProposal(
          mutation.proposalId
        );
      if (!proposal) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const participant =
        caller.actorId === proposal.earnedByActorId ||
        caller.actorId === proposal.stewardActorId ||
        caller.actorId === proposal.beneficiaryActorId;
      if (!participant) {
        if (caller.principal.kind !== "human") {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        const denied = checkApprover(ctx, caller.principal.walletAddress);
        if (denied) return denied;
        governanceOverride = true;
      }
    }
    try {
      const proposal = await mutateBeneficiaryPolicy({
        actorId: caller.actorId,
        mutation,
        governanceOverride,
      });
      ctx.log.info(
        {
          event: EVENT_NAMES.LEDGER_BENEFICIARY_POLICY_MUTATED,
          action: mutation.action,
          proposalId: proposal.id,
          status: proposal.status,
        },
        "governed beneficiary policy changed"
      );
      return NextResponse.json(
        actorBeneficiaryPolicyOperation.output.parse(
          serializeBeneficiaryProposal(proposal)
        )
      );
    } catch (error) {
      ctx.log.warn(
        {
          event: EVENT_NAMES.LEDGER_BENEFICIARY_POLICY_REJECTED,
          action: mutation.action,
          reason: error instanceof Error ? error.message : "unknown",
        },
        "governed beneficiary policy rejected"
      );
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Policy mutation rejected",
        },
        { status: 409 }
      );
    }
  }
);
