// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/edo/record-outcome/route`
 * Purpose: HTTP endpoint for filing an outcome + validates/invalidates edge that closes a hypothesis.
 * Scope: Bearer + session auth. Mirrors `core__edo_record_outcome` over the same EdoCapability.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, PRINCIPAL_DERIVES_SOURCE,
 *   OUTCOME_CITES_HYPOTHESIS, RESOLVER_IDEMPOTENT (double-fire returns existing state).
 * Side-effects: IO (HTTP response, Doltgres write via container.edoCapability)
 * Links: docs/spec/knowledge-syntropy.md § The Hypothesis Loop
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleRecordOutcome } from "../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "edo.record_outcome",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) =>
    handleRecordOutcome(request, sessionUser)
);
