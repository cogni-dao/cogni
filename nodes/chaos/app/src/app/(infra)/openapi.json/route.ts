// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/openapi.json`
 * Purpose: HTTP endpoint serving OpenAPI v3 specification for API documentation.
 * Scope: Returns JSON OpenAPI document. Does not include sensitive/internal operations.
 * Invariants: Static response; matches ts-rest router exactly.
 * Side-effects: IO (HTTP response)
 * Notes: Generated from ts-rest contracts; used by API documentation tools.
 * Links: `@contracts/http/openapi.v1`, ts-rest router
 * @public
 */

import { OpenAPIV1 } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

export const dynamic = "force-static";

export function GET(): NextResponse {
  return NextResponse.json(OpenAPIV1);
}
