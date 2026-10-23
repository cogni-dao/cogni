// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/accounts/[id]`
 * Purpose: Let a durable agent read one exact billing account after OpenFGA authorization.
 * Scope: Durable agent bearer, server-bound steward fallback, minimal account projection.
 * Invariants: EXACT_ACCOUNT_ONLY; SUBJECT_NOT_CALLER_SUPPLIED; AUTHZ_BEFORE_READ; FAIL_CLOSED.
 * Side-effects: Agent credential DB read, OpenFGA check, billing-account read, logging.
 * Links: task.5263, docs/spec/rbac.md
 * @public
 */

import {
  authzBillingAccountResource,
  authzNodeUserPrincipal,
} from "@cogni/authorization-core";
import { NextResponse } from "next/server";

import {
  RequestIdentityUnavailableError,
  resolveRequestPrincipal,
} from "@/app/_lib/auth/request-identity";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { readAgentBillingAccountOperation } from "@/contracts/agent-account-access.v1.contract";
import { EVENT_NAMES } from "@/shared/observability";
import { createRouteTerminalLogger } from "@/shared/observability/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "accounts.agent_read", auth: { mode: "none" } },
  async (ctx, _request, _sessionUser, routeContext) => {
    const startedAt = performance.now();
    const terminal = createRouteTerminalLogger(
      ctx,
      EVENT_NAMES.AGENT_ACCOUNT_READ_COMPLETE,
      startedAt
    );
    const complete = (
      status: number,
      outcome: "success" | "error",
      errorCode?: string,
      accessMode?: "direct" | "on_behalf_of"
    ) => {
      terminal.complete({
        status,
        outcome,
        ...(errorCode ? { errorCode, reasonCode: errorCode } : {}),
        ...(accessMode ? { dimensions: { accessMode } } : {}),
      });
    };

    try {
      if (!routeContext) throw new Error("context required for dynamic routes");
      const { id } = await routeContext.params;
      const parsed = readAgentBillingAccountOperation.input.safeParse({
        billingAccountId: id,
      });
      if (!parsed.success) {
        complete(400, "error", "invalid_request");
        return NextResponse.json({ error: "invalid_request" }, { status: 400 });
      }

      let principal: Awaited<ReturnType<typeof resolveRequestPrincipal>>;
      try {
        principal = await resolveRequestPrincipal();
      } catch (error) {
        if (error instanceof RequestIdentityUnavailableError) {
          complete(503, "error", "identity_unavailable");
          return NextResponse.json(
            { error: "identity_unavailable" },
            { status: 503 }
          );
        }
        throw error;
      }
      if (!principal) {
        complete(401, "error", "unauthorized");
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      if (principal.kind !== "agent") {
        complete(403, "error", "agent_required");
        return NextResponse.json({ error: "agent_required" }, { status: 403 });
      }

      const container = getContainer();
      const authorization = container.billingAccountAuthorization;
      if (!authorization) {
        complete(503, "error", "authz_unavailable");
        return NextResponse.json(
          { error: "authz_unavailable" },
          { status: 503 }
        );
      }

      const billingAccountId = parsed.data.billingAccountId;
      const baseCheck = {
        actorId: principal.principalId,
        action: "billing_account.read" as const,
        resource: authzBillingAccountResource(
          container.nodeId,
          billingAccountId
        ),
        context: { tenantId: billingAccountId, nodeId: container.nodeId },
      };
      const direct = await authorization.check(baseCheck);
      let accessMode: "direct" | "on_behalf_of" = "direct";
      let decision = direct;
      if (direct.code === "authz_denied") {
        const stewardship =
          await container.agentIdentity.getAcceptedStewardship(
            principal.actorId
          );
        if (stewardship?.billingAccountId === billingAccountId) {
          accessMode = "on_behalf_of";
          decision = await authorization.check({
            ...baseCheck,
            subjectId: authzNodeUserPrincipal(
              container.nodeId,
              stewardship.stewardUserId
            ),
          });
        }
      }
      if (decision.decision !== "allow") {
        const status = decision.code === "authz_unavailable" ? 503 : 403;
        complete(status, "error", decision.code, accessMode);
        return NextResponse.json({ error: decision.code }, { status });
      }

      const account =
        await container.serviceAccountService.getBillingAccountById(
          billingAccountId
        );
      if (!account) {
        complete(404, "error", "account_not_found", accessMode);
        return NextResponse.json(
          { error: "account_not_found" },
          { status: 404 }
        );
      }
      const output = readAgentBillingAccountOperation.output.parse({
        billingAccountId: account.id,
        balanceCredits: account.balanceCredits,
        accessMode,
      });
      complete(200, "success", undefined, accessMode);
      return NextResponse.json(output);
    } catch (error) {
      terminal.internalError();
      throw error;
    }
  }
);
