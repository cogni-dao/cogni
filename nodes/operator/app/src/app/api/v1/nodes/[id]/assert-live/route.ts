// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/assert-live`
 * Purpose: Single-env LIVENESS gate. GET asserts ONE node in ONE env is actually alive across the two
 *   PUBLIC rungs (serving + run-carries) and is **fail-loud**: HTTP 200 only when `live`, HTTP 422 +
 *   the failure list otherwise — so a `curl -fsS` done-gate fails loudly on green-but-dead.
 * Scope: Thin shell — Cogni-token auth, developer-RBAC gate, resolve {id} via dev1's NodeRegistryPort,
 *   delegate to the feature verifier with a public-surface prober. No cluster/GH/Grafana auth.
 * Invariants:
 *   - COGNI_TOKEN_ONLY; READ_ONLY_PROBES; NO_SILENT_PASS (a non-carrying run ⇒ live=false, HTTP 422).
 *   - DEVELOPER_GATED: requires `node.flight` (→ `can_flight from developer`); fail-closed without a store.
 * Side-effects: IO (registry read, authz check, network probes)
 * Links: src/features/nodes/flight-status.ts (assertLive), vcs/flight/route.ts (same tuple), task.5024
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createNodeProber } from "@/bootstrap/node-flight.factory";
import {
  assertLive,
  FLIGHT_ENVS,
  rootDomain,
} from "@/features/nodes/flight-status";
import type { FlightEnv } from "@/ports";
import { serverEnv } from "@/shared/env";
import { baseDomain } from "@/shared/node-registry/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface RouteParams {
  params: Promise<{ id: string }>;
}

function isFlightEnv(v: string | null): v is FlightEnv {
  return v !== null && (FLIGHT_ENVS as readonly string[]).includes(v);
}

export async function GET(
  request: Request,
  ctx: RouteParams
): Promise<NextResponse> {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const env = new URL(request.url).searchParams.get("env");
  if (!isFlightEnv(env)) {
    return NextResponse.json(
      {
        error: "invalid_env",
        message: `env must be one of ${FLIGHT_ENVS.join(", ")}`,
      },
      { status: 400 }
    );
  }

  const { id } = await ctx.params;

  // Resolve {id} (UUID or slug) + developer-gate (`node.flight`) via the shared
  // node-rbac seam — fail-closed without a store.
  const gate = await resolveNodeAndAuthorize({
    id,
    userId: sessionUser.id,
    action: "node.flight",
  });
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.errorCode },
      { status: gate.status }
    );
  }
  const node = gate.node;

  const apex = baseDomain(serverEnv());
  if (!apex) {
    return NextResponse.json({ error: "no_base_domain" }, { status: 503 });
  }

  const result = await assertLive(
    {
      slug: node.slug,
      nodeId: node.nodeId,
      primary: node.slug === "operator",
      env,
      baseDomain: rootDomain(apex),
    },
    createNodeProber()
  );

  // Fail-loud: non-live ⇒ 422 so a curl -fsS done-gate fails. Body carries the rung detail either way.
  return NextResponse.json(result, { status: result.live ? 200 : 422 });
}
