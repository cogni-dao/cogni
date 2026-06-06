// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/governance/status/route`
 * Purpose: API endpoint for DAO governance transparency dashboard data.
 * Scope: Validates output via contract, delegates to feature service. Does not access database directly.
 * Invariants:
 * - AUTH_REQUIRED: Requires authenticated user
 * - FEATURE_SERVICE_LAYER: Delegates to getGovernanceStatus, never queries DB
 * - CONTRACT_FIRST: Output validated against governance.status.v1 contract
 * Side-effects: IO (reads via feature service → ports)
 * Links: docs/spec/governance-status-api.md, src/contracts/governance.status.v1.contract.ts
 * @public
 */

import { toUserId } from "@cogni/ids";
import { governanceStatusOperation } from "@cogni/node-contracts";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getGovernanceStatus } from "@/features/governance/services/get-governance-status";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "governance.status.v1",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (_ctx, _request, _sessionUser) => {
    const container = getContainer();

    const accountService = container.accountsForUser(
      toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID)
    );

    const status = await getGovernanceStatus({
      accountService,
      governanceStatusPort: container.governanceStatus,
    });

    return NextResponse.json(governanceStatusOperation.output.parse(status));
  }
);
