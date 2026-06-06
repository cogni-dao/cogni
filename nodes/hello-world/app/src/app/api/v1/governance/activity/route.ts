// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/governance/activity/route`
 * Purpose: API endpoint for governance account activity metrics (spend, tokens, requests).
 * Scope: Reuses getActivity facade scoped to system tenant account. Does not implement business logic.
 * Invariants:
 * - AUTH_REQUIRED: Requires authenticated user
 * - SYSTEM_TENANT_SCOPED: Always queries the system principal billing account, never the session user's
 * Side-effects: IO
 * Links: [ActivityFacade](../../../../_facades/ai/activity.server.ts), docs/spec/governance-status-api.md
 * @public
 */

import { aiActivityOperation } from "@cogni/node-contracts";
import {
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
  deriveTimeRange,
} from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getActivity } from "@/app/_facades/ai/activity.server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

/** Synthetic session user representing the system tenant account. */
const SYSTEM_SESSION_USER = {
  id: COGNI_SYSTEM_PRINCIPAL_USER_ID,
  walletAddress: null,
  displayName: null,
  avatarColor: null,
} as const;

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "governance.activity.v1",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, _sessionUser) => {
    const { searchParams } = new URL(request.url);

    const inputResult = aiActivityOperation.input.safeParse({
      range: searchParams.get("range") || undefined,
      from: searchParams.get("from") || undefined,
      to: searchParams.get("to") || undefined,
      step: searchParams.get("step") || undefined,
      groupBy: searchParams.get("groupBy") || undefined,
      cursor: searchParams.get("cursor") || undefined,
      limit: searchParams.has("limit")
        ? Number.parseInt(searchParams.get("limit") || "20", 10)
        : undefined,
    });

    if (!inputResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: inputResult.error.format() },
        { status: 400 }
      );
    }

    try {
      let from: string;
      let to: string;

      if (inputResult.data.range) {
        const { from: derivedFrom, to: derivedTo } = deriveTimeRange(
          inputResult.data.range
        );
        from = derivedFrom.toISOString();
        to = derivedTo.toISOString();
      } else {
        if (!inputResult.data.from || !inputResult.data.to) {
          return NextResponse.json(
            { error: "Missing from/to parameters" },
            { status: 400 }
          );
        }
        from = inputResult.data.from;
        to = inputResult.data.to;
      }

      const data = await getActivity({
        from,
        to,
        ...(inputResult.data.step && { step: inputResult.data.step }),
        ...(inputResult.data.groupBy && { groupBy: inputResult.data.groupBy }),
        ...(inputResult.data.cursor && { cursor: inputResult.data.cursor }),
        ...(inputResult.data.limit && { limit: inputResult.data.limit }),
        sessionUser: SYSTEM_SESSION_USER,
        reqId: ctx.reqId,
      });

      return NextResponse.json(data);
    } catch (error) {
      if (error instanceof Error && error.name === "InvalidCursorError") {
        return NextResponse.json(
          { error: "Invalid cursor", details: error.message },
          { status: 400 }
        );
      }

      if (error instanceof Error && error.name === "InvalidRangeError") {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }

      throw error;
    }
  }
);
