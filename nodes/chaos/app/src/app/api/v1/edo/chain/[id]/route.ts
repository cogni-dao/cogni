// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/edo/chain/[id]/route`
 * Purpose: GET /api/v1/edo/chain/:id — walk the citation DAG anchored at one entry.
 * Scope: Bearer + session auth. Returns `{ root, chain }` per `EdoCapability.getChain`.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER.
 *   Query params: ?direction=out|in|both (default both), ?maxDepth=1..10 (default 5).
 * Side-effects: IO (HTTP response, Doltgres reads via container.edoCapability)
 * Links: docs/spec/knowledge-syntropy.md § Chain Read API
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleChainGet } from "../../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "edo.chain",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    return handleChainGet(request, sessionUser, id);
  }
);
