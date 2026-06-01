// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/internship-subsidy/prototype`
 * Purpose: Public endpoint returning a rail-neutral intern subsidy distribution prototype.
 * Scope: Validates query input, delegates to facade, validates output.
 * Invariants: VALIDATE_IO; PUBLIC_RATE_LIMITED; NO_TX_SIGNING.
 * Side-effects: IO (HTTP response, structured log event)
 * Links: contracts/internship.subsidy-prototype.v1.contract.ts
 * @public
 */

import { NextResponse } from "next/server";
import { getInternshipSubsidyPrototypeFacade } from "@/app/_facades/internship-subsidy/prototype.server";
import { wrapPublicRoute } from "@/bootstrap/http";
import { internshipSubsidyPrototypeOperation } from "@/contracts/internship.subsidy-prototype.v1.contract";
import { logRequestWarn } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapPublicRoute(
  {
    routeId: "internship.subsidy-prototype",
    cacheTtlSeconds: 60,
    staleWhileRevalidateSeconds: 300,
  },
  async (ctx, request) => {
    const rawInput = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parseResult =
      internshipSubsidyPrototypeOperation.input.safeParse(rawInput);
    if (!parseResult.success) {
      logRequestWarn(ctx.log, parseResult.error, "VALIDATION_ERROR");
      return NextResponse.json(
        { error: "invalid input", issues: parseResult.error.issues },
        { status: 400 }
      );
    }

    const output = await getInternshipSubsidyPrototypeFacade(
      parseResult.data,
      ctx
    );
    return NextResponse.json(
      internshipSubsidyPrototypeOperation.output.parse(output)
    );
  }
);
