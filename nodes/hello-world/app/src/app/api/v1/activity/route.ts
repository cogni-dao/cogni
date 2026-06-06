// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/activity/route`
 * Purpose: API endpoint for fetching activity data.
 * Scope: Validates input via contract, delegates to ActivityFacade. Does not implement business logic.
 * Invariants:
 * - Requires authenticated user.
 * - scope=system queries system tenant billing account; scope=user (default) queries the session user's.
 * - Returns 400 for invalid cursor or input.
 * - Returns 400 for InvalidRangeError.
 * Side-effects: IO
 * Links: [ActivityFacade](../../../_facades/ai/activity.server.ts)
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

/** Synthetic session user for system-scoped activity queries. */
const SYSTEM_SESSION_USER = {
  id: COGNI_SYSTEM_PRINCIPAL_USER_ID,
  walletAddress: null,
  displayName: null,
  avatarColor: null,
} as const;

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "ai.activity",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const { searchParams } = new URL(request.url);

    // Parse and validate input
    const inputResult = aiActivityOperation.input.safeParse({
      scope: searchParams.get("scope") || undefined,
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
      if (!sessionUser) throw new Error("sessionUser required"); // Enforced by wrapper

      // Derive from/to from range preset if provided, otherwise use explicit from/to
      let from: string;
      let to: string;

      if (inputResult.data.range) {
        const { from: derivedFrom, to: derivedTo } = deriveTimeRange(
          inputResult.data.range
        );
        from = derivedFrom.toISOString();
        to = derivedTo.toISOString();
      } else {
        // Custom range (from/to explicitly provided)
        // Safe: Zod refine validates that both from and to exist when range is absent
        if (!inputResult.data.from || !inputResult.data.to) {
          return NextResponse.json(
            { error: "Missing from/to parameters" },
            { status: 400 }
          );
        }
        from = inputResult.data.from;
        to = inputResult.data.to;
      }

      const isSystemScope = inputResult.data.scope === "system";
      const effectiveUser = isSystemScope ? SYSTEM_SESSION_USER : sessionUser;

      const data = await getActivity({
        from,
        to,
        ...(inputResult.data.step && { step: inputResult.data.step }),
        ...(inputResult.data.groupBy && { groupBy: inputResult.data.groupBy }),
        ...(inputResult.data.cursor && { cursor: inputResult.data.cursor }),
        ...(inputResult.data.limit && { limit: inputResult.data.limit }),
        sessionUser: effectiveUser,
        scope: isSystemScope ? "system" : "user",
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

      throw error; // Let wrapper handle unexpected errors
    }
  }
);
