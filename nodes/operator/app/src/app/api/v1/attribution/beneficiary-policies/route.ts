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
import { createRouteTerminalLogger } from "@/shared/observability/server";

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
  async (ctx, request) => {
    const startedAt = performance.now();
    const terminal = createRouteTerminalLogger(
      ctx,
      EVENT_NAMES.LEDGER_BENEFICIARY_POLICY_COMPLETE,
      startedAt,
      { operation: "read" }
    );
    try {
      const caller = await exactActor();
      if (!caller) {
        terminal.complete({
          status: 401,
          outcome: "error",
          errorCode: "unauthorized",
          reasonCode: "principal_not_resolved",
        });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const proposalId = new URL(request.url).searchParams.get("proposalId");
      if (!proposalId) {
        terminal.complete({
          status: 400,
          outcome: "error",
          errorCode: "invalid_request",
          reasonCode: "proposal_id_required",
        });
        return NextResponse.json(
          { error: "proposalId is required" },
          { status: 400 }
        );
      }
      const proposal =
        await getContainer().attributionStore.getActorBeneficiaryPolicyProposal(
          proposalId
        );
      if (!proposal) {
        terminal.complete({
          status: 404,
          outcome: "error",
          errorCode: "not_found",
          reasonCode: "proposal_not_found",
        });
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      if (
        caller.actorId !== proposal.earnedByActorId &&
        caller.actorId !== proposal.stewardActorId &&
        caller.actorId !== proposal.beneficiaryActorId
      ) {
        terminal.complete({
          status: 403,
          outcome: "error",
          errorCode: "forbidden",
          reasonCode: "not_policy_participant",
        });
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const output = actorBeneficiaryPolicyOperation.output.parse(
        serializeBeneficiaryProposal(proposal)
      );
      terminal.complete({
        status: 200,
        outcome: "success",
        dimensions: { policyStatus: proposal.status },
      });
      return NextResponse.json(output);
    } catch (error) {
      terminal.internalError();
      throw error;
    }
  }
);

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "attribution.beneficiary-policy.write", auth: { mode: "none" } },
  async (ctx, request) => {
    const startedAt = performance.now();
    const terminal = createRouteTerminalLogger(
      ctx,
      EVENT_NAMES.LEDGER_BENEFICIARY_POLICY_COMPLETE,
      startedAt,
      { operation: "write" }
    );
    try {
      const caller = await exactActor();
      if (!caller) {
        terminal.complete({
          status: 401,
          outcome: "error",
          errorCode: "unauthorized",
          reasonCode: "principal_not_resolved",
        });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
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
          terminal.complete({
            status: 404,
            outcome: "error",
            errorCode: "not_found",
            reasonCode: "proposal_not_found",
            dimensions: { action: mutation.action },
          });
          return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
        const participant =
          caller.actorId === proposal.earnedByActorId ||
          caller.actorId === proposal.stewardActorId ||
          caller.actorId === proposal.beneficiaryActorId;
        if (!participant) {
          if (caller.principal.kind !== "human") {
            terminal.complete({
              status: 403,
              outcome: "error",
              errorCode: "forbidden",
              reasonCode: "not_policy_participant",
              dimensions: { action: mutation.action },
            });
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
          }
          const denied = checkApprover(ctx, caller.principal.walletAddress);
          if (denied) {
            terminal.complete({
              status: denied.status,
              outcome: "error",
              errorCode: "approver_denied",
              reasonCode: "governance_approver_required",
              dimensions: { action: mutation.action },
            });
            return denied;
          }
          governanceOverride = true;
        }
      }
      try {
        const proposal = await mutateBeneficiaryPolicy({
          actorId: caller.actorId,
          mutation,
          governanceOverride,
        });
        const output = actorBeneficiaryPolicyOperation.output.parse(
          serializeBeneficiaryProposal(proposal)
        );
        terminal.complete({
          status: 200,
          outcome: "success",
          dimensions: {
            action: mutation.action,
            policyStatus: proposal.status,
            governanceOverride,
          },
        });
        return NextResponse.json(output);
      } catch (error) {
        terminal.complete({
          status: 409,
          outcome: "error",
          errorCode: "policy_mutation_rejected",
          reasonCode: "policy_invariant_rejected",
          dimensions: { action: mutation.action, governanceOverride },
        });
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Policy mutation rejected",
          },
          { status: 409 }
        );
      }
    } catch (error) {
      terminal.internalError();
      throw error;
    }
  }
);
