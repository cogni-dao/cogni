// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/[id]/close/route`
 * Purpose: POST to reject + close a contribution without merging.
 * Scope: Auth-protected POST. Gated to admin-session principals only (v0).
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_MERGE_REQUIRES_ADMIN_SESSION.
 * Side-effects: IO (HTTP response, Doltgres dolt_branch -D + UPDATE via container service)
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleClose } from "../../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.close",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    return handleClose(request, id, sessionUser);
  }
);
