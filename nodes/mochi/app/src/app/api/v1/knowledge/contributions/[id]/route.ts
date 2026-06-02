// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/[id]/route`
 * Purpose: GET a single contribution record.
 * Scope: Auth-protected GET. Returns metadata; the diff lives at /diff.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER.
 * Side-effects: IO (HTTP response, Doltgres read via container service)
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleGetById } from "../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.get",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    return handleGetById(id, sessionUser);
  }
);
