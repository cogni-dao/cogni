// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/[id]/commits/route`
 * Purpose: Append and list Dolt commits for an open knowledge contribution branch.
 * Scope: Auth-protected POST/GET wrappers. Delegates contribution policy and Dolt I/O to the shared service.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, CONTRIBUTION_OWNER_CAN_APPEND.
 * Side-effects: IO (HTTP response, Doltgres branch writes via container service)
 * Links: docs/design/knowledge-contribution-api.md
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleAppendCommit, handleListCommits } from "../../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.commits.append",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    return handleAppendCommit(request, id, sessionUser);
  }
);

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.commits.list",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    return handleListCommits(id, sessionUser);
  }
);
