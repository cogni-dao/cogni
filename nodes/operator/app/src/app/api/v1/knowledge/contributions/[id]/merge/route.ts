// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/[id]/merge/route`
 * Purpose: POST to merge a contribution branch into main.
 * Scope: Auth-protected POST. Gated to verified human principals only (v0).
 * Invariants: VALIDATE_IO, HUMAN_GOVERNANCE_ONLY, KNOWLEDGE_MERGE_REQUIRES_ADMIN_SESSION.
 * Side-effects: IO (HTTP response, Doltgres dolt_merge + dolt_commit via container service)
 * @public
 */

import { resolveHumanRequestIdentity } from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleMerge } from "../../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.merge",
    auth: {
      mode: "required",
      getSessionUser: resolveHumanRequestIdentity,
    },
  },
  async (_ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    return handleMerge(request, id, sessionUser);
  }
);
