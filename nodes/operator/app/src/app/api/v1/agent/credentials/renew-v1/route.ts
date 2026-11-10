// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/renew-v1`
 * Purpose: Self-serve renewal of a v1 agent key for the SAME users.id, so
 *   operator principals (and their OpenFGA roles) survive key expiry (task.5475,
 *   S0a of task.5474).
 * Scope: Bearer-only. A currently valid v1 key (the existing resolver; expired
 *   keys 401 before this handler) mints a fresh v1 key via issueAgentApiKey,
 *   capped at the effective hard stop. Session callers and wallet users are
 *   refused. Does not touch the v1 verify path or any billing account.
 * Invariants:
 *   - V1_BEARER_ONLY: peekAgentKeyExpiry() must be non-null (cookie sessions refused).
 *   - HARD_STOP_ONLY_SHORTENS: see agent-v1-hard-stop.ts; at/after the stop -> 403 v1_hard_stop.
 *   - NO_KEY_IN_LOGS: logs carry userId and expiries, never the key.
 * Side-effects: IO (users read via service db); log events.
 * Links: agent.credentials.renew-v1.v1.contract, request-identity.ts
 * @public
 */

import { users } from "@cogni/db-schema";
import { renewAgentV1Operation } from "@cogni/node-contracts";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { effectiveAgentV1HardStop } from "@/app/_lib/auth/agent-v1-hard-stop";
import { issueAgentApiKey } from "@/app/_lib/auth/request-identity";
import { getSessionUser, peekAgentKeyExpiry } from "@/app/_lib/auth/session";
import { resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.credentials.renew_v1",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser) => {
    const refuse = (status: number, code: string, extra?: object) => {
      logEvent(ctx.log, EVENT_NAMES.AGENT_CREDENTIAL_V1_REFUSED, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        userId: sessionUser.id,
        status,
        errorCode: code,
        ...extra,
      });
      return NextResponse.json({ error: code }, { status, headers: NO_STORE });
    };

    const oldExp = await peekAgentKeyExpiry();
    if (oldExp === null) return refuse(403, "agent_key_required");

    const stop = effectiveAgentV1HardStop(serverEnv().AGENT_V1_HARD_STOP);
    if (!stop) return refuse(503, "v1_renew_disabled");
    const now = Date.now();
    if (now >= stop.hardStop.getTime()) return refuse(403, "v1_hard_stop");

    const [row] = await resolveServiceDb()
      .select({ walletAddress: users.walletAddress })
      .from(users)
      .where(eq(users.id, sessionUser.id))
      .limit(1);
    if (!row || row.walletAddress) return refuse(403, "wallet_user_refused");

    const hardStopSeconds = Math.floor(stop.hardStop.getTime() / 1000);
    const apiKey = issueAgentApiKey({
      userId: sessionUser.id,
      displayName: sessionUser.displayName,
      expiresAtCapSeconds: hardStopSeconds,
    });
    const newExp = Math.min(
      Math.floor(now / 1000) + 60 * 60 * 24 * 30,
      hardStopSeconds
    );

    logEvent(ctx.log, EVENT_NAMES.AGENT_CREDENTIAL_V1_RENEWED, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      userId: sessionUser.id,
      oldExp,
      newExp,
      hardStopClamped: stop.clamped,
    });

    return NextResponse.json(
      renewAgentV1Operation.output.parse({
        userId: sessionUser.id,
        apiKey,
        expiresAt: new Date(newExp * 1000).toISOString(),
        hardStop: stop.hardStop.toISOString(),
      }),
      { headers: NO_STORE }
    );
  }
);
