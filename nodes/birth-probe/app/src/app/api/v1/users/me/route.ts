// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/users/me/route`
 * Purpose: API endpoint for reading and updating the current user's profile.
 * Scope: Validates input via contract, delegates to profile facade. Does not implement business logic.
 * Invariants:
 * - Requires authenticated user.
 * - GET returns profile with resolved display name (fallback chain applied).
 * - PATCH upserts user_profiles row.
 * Side-effects: IO
 * Links: src/contracts/users.profile.v1.contract.ts, src/app/_facades/users/profile.server.ts
 * @public
 */

import {
  profileReadOperation,
  profileUpdateOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import {
  readProfile,
  updateProfile,
} from "@/app/_facades/users/profile.server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "users.me",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (_ctx, _request, sessionUser) => {
    const data = await readProfile(sessionUser);
    const output = profileReadOperation.output.parse(data);
    return NextResponse.json(output);
  }
);

export const PATCH = wrapRouteHandlerWithLogging(
  {
    routeId: "users.me.update",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    const body = await request.json();
    const inputResult = profileUpdateOperation.input.safeParse(body);
    if (!inputResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: inputResult.error.format() },
        { status: 400 }
      );
    }

    const data = await updateProfile(sessionUser, inputResult.data);
    const output = profileUpdateOperation.output.parse(data);
    return NextResponse.json(output);
  }
);
