// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/[id]/diff/route`
 * Purpose: GET the dolt_diff for a contribution branch versus main.
 * Scope: Auth-protected GET. Powers operator review before merge.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER.
 * Side-effects: IO (HTTP response, Doltgres dolt_diff read via container service)
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleDiff } from "../../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.diff",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    return handleDiff(id, sessionUser);
  }
);
