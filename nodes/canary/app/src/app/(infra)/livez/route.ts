// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/livez`
 * Purpose: HTTP endpoint providing fast liveness check with zero dependencies.
 * Scope: Returns alive status if process can handle HTTP requests. Does NOT validate env, secrets, DB, or external services.
 * Invariants: Always fast (<100ms); no imports from env/db/validation modules; contract test verifies isolation.
 * Side-effects: IO (HTTP response)
 * Notes: Used for pre-push CI artifact validation and K8s liveness probes. MUST NOT import serverEnv().
 * Links: `@contracts/meta.livez.read.v1.contract`, src/app/(infra)/readyz/route.ts
 * @public
 */

import { metaLivezOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  // Pure liveness: if we get here, process is alive and HTTP stack is working
  const payload = {
    status: "alive" as const,
    timestamp: new Date().toISOString(),
  };

  const parsed = metaLivezOperation.output.parse(payload);
  return NextResponse.json(parsed);
}
