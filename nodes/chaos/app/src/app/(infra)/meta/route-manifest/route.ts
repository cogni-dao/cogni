// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/meta/route-manifest`
 * Purpose: HTTP endpoint exposing site route manifest for e2e testing.
 * Scope: Returns JSON route manifest. Does not include sensitive/auth routes.
 * Invariants: Static response; validates against contract schema.
 * Side-effects: IO (HTTP response)
 * Notes: Hex architecture adapter using contract validation; unversioned infra endpoint.
 * Links: `@contracts/meta.route-manifest.read.v1.contract`, `@features/site-meta/routeManifest`
 * @public
 */

import { metaRouteManifestOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { routeManifest } from "@/features/site-meta/services/routeManifest";

export const dynamic = "force-static";

export function GET(): NextResponse {
  const payload = { version: 1 as const, routes: routeManifest.routes };
  const parsed = metaRouteManifestOperation.output.parse(payload);
  return NextResponse.json(parsed);
}
