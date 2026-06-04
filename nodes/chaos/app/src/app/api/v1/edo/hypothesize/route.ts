// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/edo/hypothesize/route`
 * Purpose: HTTP endpoint for filing a falsifiable hypothesis with evaluate_at + evidence citations atomically.
 * Scope: Bearer + session auth. Mirrors `core__edo_hypothesize` over the same EdoCapability.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, PRINCIPAL_DERIVES_SOURCE.
 * Side-effects: IO (HTTP response, Doltgres write via container.edoCapability)
 * Links: docs/spec/knowledge-syntropy.md § The Hypothesis Loop
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleHypothesize } from "../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "edo.hypothesize",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => handleHypothesize(request, sessionUser)
);
