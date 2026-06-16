// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/assert-live`
 * Purpose: Move-2 LIVE end-state gate. GET asserts ONE node in ONE env is actually alive across five
 *   read-only rungs (serving, run-carries, log-in-Loki, doltgres-exists, worker-carries-UUID) and is
 *   **fail-loud**: HTTP 200 only when `live`, HTTP 422 + the failure list otherwise — so a flight
 *   done-gate (`assert-target-substrate.sh` via `curl -fsS`) fails loudly on green-but-dead.
 * Scope: Thin shell — Cogni-token auth, resolve {id} via dev1's NodeRegistryPort (for the repo-spec
 *   nodeId the worker queue + Loki labels use), delegate to the feature verifier. No cluster/GH auth.
 * Invariants: COGNI_TOKEN_ONLY; READ_ONLY_PROBES; NO_SILENT_PASS (loki-unwired ⇒ live=false).
 * Side-effects: IO (registry read, network probes)
 * Links: src/features/nodes/flight-status.ts (assertLive), src/ports/node-flight.port.ts, task.5024
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeRegistry } from "@/bootstrap/container";
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

  // Consume dev1's registry: it carries the repo-spec nodeId (UUID) the worker queue + Loki use.
  const summaries = await resolveNodeRegistry().listPublic();
  const node = summaries.find((n) => n.nodeId === id || n.slug === id);
  const slug = node?.slug ?? id;

  const apex = baseDomain(serverEnv());
  if (!apex) {
    return NextResponse.json({ error: "no_base_domain" }, { status: 503 });
  }

  const result = await assertLive(
    {
      slug,
      nodeId: node?.nodeId ?? (id.includes("-") ? id : undefined),
      primary: node?.primary ?? slug === "operator",
      env,
      baseDomain: rootDomain(apex),
    },
    createNodeProber()
  );

  // Fail-loud: non-live ⇒ 422 so a curl -fsS done-gate fails. Body carries the rung detail either way.
  return NextResponse.json(result, { status: result.live ? 200 : 422 });
}
