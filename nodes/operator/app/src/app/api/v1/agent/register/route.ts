// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/register`
 * Purpose: Machine-actor registration endpoint — mints a user row with its
 *   external agent principal row, a billing account, and a 30-day HMAC-signed API key for agents that can reach the
 *   node without a browser session.
 * Scope: Instrumented via wrapRouteHandlerWithLogging so every attempt hits
 *   the structured log envelope (request received / request complete) and
 *   the http_requests_total / http_request_duration_ms metrics like every
 *   other /api/v1/* route. auth.mode=none because the endpoint is the
 *   onboarding seam itself — callers can't present credentials they haven't
 *   been issued yet. Security hardening (invitation token) tracked in bug.0297.
 * Links: bug.0297
 * @public
 */

import { randomUUID } from "node:crypto";
import { registerAgentOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import { registerAgentUser } from "@/bootstrap/agent-credentials";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.register", auth: { mode: "none" } },
  async (_ctx, request) => {
    const parsed = registerAgentOperation.input.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const input = parsed.data;

    const id = randomUUID();

    // The user row and its external principal row land together (one transaction); key upgrade refuses a user without it.
    await registerAgentUser({ userId: id, name: input.name });

    const container = getContainer();
    const billingAccount =
      await container.serviceAccountService.getOrCreateBillingAccountForUser({
        userId: id,
        displayName: input.name,
      });

    const apiKey = issueAgentApiKey({
      userId: id,
      displayName: input.name,
    });

    return NextResponse.json(
      registerAgentOperation.output.parse({
        userId: id,
        apiKey,
        billingAccountId: billingAccount.id,
      }),
      { status: 201 }
    );
  }
);
