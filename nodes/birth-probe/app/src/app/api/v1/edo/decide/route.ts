// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/edo/decide/route`
 * Purpose: HTTP endpoint for filing a decision that derives_from a hypothesis atomically.
 * Scope: Bearer + session auth. Mirrors `core__edo_decide` over the same EdoCapability.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, PRINCIPAL_DERIVES_SOURCE,
 *   DECISION_CITES_HYPOTHESIS (adapter rejects if cited row is not a hypothesis).
 * Side-effects: IO (HTTP response, Doltgres write via container.edoCapability)
 * Links: docs/spec/knowledge-syntropy.md § The Hypothesis Loop
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleDecide } from "../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "edo.decide",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => handleDecide(request, sessionUser)
);
