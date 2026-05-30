// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/route`
 * Purpose: HTTP endpoints for listing and creating external-agent knowledge contributions.
 * Scope: Auth-protected POST (create new contrib branch + commit) and GET (list).
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, EXTERNAL_CONTRIB_VIA_BRANCH.
 * Side-effects: IO (HTTP response, Doltgres branch + write via container service)
 * Links: docs/design/knowledge-contribution-api.md
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleCreate, handleList } from "./_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.contributions.create",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => handleCreate(request, sessionUser)
);

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.contributions.list",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => handleList(request, sessionUser)
);
