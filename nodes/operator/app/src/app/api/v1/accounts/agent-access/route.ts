// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/accounts/agent-access`
 * Purpose: Let a human steward grant or revoke one durable agent's account read access.
 * Scope: Human session, owned account, accepted stewardship, semantic authz mutation.
 * Invariants: HUMAN_SESSION_ONLY; ACCOUNT_FROM_SESSION; NO_RAW_TUPLES; SAME_NODE_AGENT.
 * Side-effects: Billing-account initialization, actor lookup, mediated OpenFGA mutation, logging.
 * Links: task.5263, docs/spec/rbac.md
 * @public
 */

import type { UserId } from "@cogni/ids";
import { NextResponse } from "next/server";

import { readBoundedJson } from "@/app/_lib/bounded-json-body";
import { isSameOriginMutation } from "@/app/api/v1/agent/_shared";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { mutateAgentAccountAccessOperation } from "@/contracts/agent-account-access.v1.contract";
import { getServerSessionUser } from "@/lib/auth/server";
import { isBillingAccountOwnerBootstrapPortError } from "@/ports";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 8 * 1024;

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "accounts.agent_access.mutate",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    let completed = false;
    const complete = (
      status: number,
      outcome: "success" | "error",
      errorCode?: string,
      fields: Record<string, unknown> = {}
    ) => {
      completed = true;
      logEvent(ctx.log, EVENT_NAMES.AGENT_ACCOUNT_ACCESS_MUTATION_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status,
        durationMs: Math.round(performance.now() - startedAt),
        outcome,
        ...(errorCode ? { errorCode } : {}),
        ...fields,
      });
    };

    try {
      if (!isSameOriginMutation(request)) {
        complete(403, "error", "csrf_denied");
        return NextResponse.json({ error: "csrf_denied" }, { status: 403 });
      }
      const body = await readBoundedJson(request, MAX_REQUEST_BYTES);
      const parsed = mutateAgentAccountAccessOperation.input.safeParse(
        body.ok ? body.value : undefined
      );
      if (!parsed.success) {
        const status = body.ok ? 400 : body.reason === "too_large" ? 413 : 400;
        complete(status, "error", "invalid_request");
        return NextResponse.json({ error: "invalid_request" }, { status });
      }

      const container = getContainer();
      const account = await container
        .accountsForUser(sessionUser.id as UserId)
        .getOrCreateBillingAccountForUser({
          userId: sessionUser.id,
          requireAuthorizationOwner: true,
          ...(sessionUser.displayName
            ? { displayName: sessionUser.displayName }
            : {}),
        });
      const stewardship = await container.agentIdentity.getAcceptedStewardship(
        parsed.data.agentActorId
      );
      if (
        !stewardship ||
        stewardship.stewardUserId !== sessionUser.id ||
        stewardship.billingAccountId !== account.id
      ) {
        complete(403, "error", "stewardship_denied", {
          operation: parsed.data.operation,
          mode: parsed.data.mode,
        });
        return NextResponse.json(
          { error: "stewardship_denied" },
          { status: 403 }
        );
      }

      if (!container.billingAccountAuthorization) {
        complete(503, "error", "authz_unavailable", {
          operation: parsed.data.operation,
          mode: parsed.data.mode,
        });
        return NextResponse.json(
          { error: "authz_unavailable" },
          { status: 503 }
        );
      }

      const decision =
        await container.billingAccountAuthorization.mutateAgentAccountAccess({
          ...parsed.data,
          grantorUserId: sessionUser.id,
          billingAccountId: account.id,
          requestId: ctx.reqId,
        });
      if (decision.decision !== "success") {
        const status =
          decision.code === "authz_write_denied" ? 403 : 503;
        complete(status, "error", decision.code, {
          operation: parsed.data.operation,
          mode: parsed.data.mode,
        });
        return NextResponse.json({ error: decision.code }, { status });
      }

      const output = mutateAgentAccountAccessOperation.output.parse({
        billingAccountId: account.id,
        agentActorId: parsed.data.agentActorId,
        mode: parsed.data.mode,
        operation: parsed.data.operation,
      });
      complete(200, "success", undefined, {
        operation: parsed.data.operation,
        mode: parsed.data.mode,
      });
      return NextResponse.json(output);
    } catch (error) {
      if (isBillingAccountOwnerBootstrapPortError(error)) {
        complete(503, "error", "authz_write_unavailable");
        return NextResponse.json(
          { error: "authz_write_unavailable" },
          { status: 503 }
        );
      }
      if (!completed) complete(500, "error", "internal_error");
      throw error;
    }
  }
);
