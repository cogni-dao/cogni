// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/flight-status`
 * Purpose: The substrate VERIFICATION GATE endpoint — GET per-node, per-env proof that a node not only
 *   deployed (serving) but actually carries a real graph run. Lets a dev (or /validate-candidate) catch
 *   the "green-but-dead" class — 200-but-no-Temporal-poller, stale routing, worker-401 — that Argo can't see.
 * Scope: Thin HTTP shell — Cogni-token auth, resolve {id}→slug, derive the root zone, delegate to the
 *   feature verifier with a real-fetch prober. No cluster/GH auth, no business logic here.
 * Invariants: COGNI_TOKEN_ONLY (getSessionUser = Bearer-first); NO_CLUSTER_AUTH; read-only (no mutation).
 * Side-effects: IO (DB read for slug, network probes via the prober)
 * Links: src/features/nodes/flight-status.ts, src/adapters/server/node-flight/node-prober.adapter.ts, task.5021
 * @public
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveServiceDb } from "@/bootstrap/container";
import { createNodeProber } from "@/bootstrap/node-flight.factory";
import { rootDomain, verifyFlightStatus } from "@/features/nodes/flight-status";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import { baseDomain } from "@/shared/node-registry/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Probing three envs (each: serving + a poet completion that may take seconds) can exceed the default.
export const maxDuration = 120;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: Request,
  ctx: RouteParams
): Promise<NextResponse> {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  // Resolve {id} → slug. Accept either the registry UUID or the slug directly (a freshly-formed node
  // may not be in the registry at main yet — see beacon). Read-only, service-scoped, not owner-gated:
  // flight status only exposes a node's PUBLIC surface, no secrets.
  const db = resolveServiceDb();
  const rows = await db
    .select({ slug: nodes.slug })
    .from(nodes)
    .where(eq(nodes.id, id))
    .limit(1);
  const slug = rows[0]?.slug ?? id;

  const apex = baseDomain(serverEnv());
  if (!apex) {
    return NextResponse.json(
      {
        error: "no_base_domain",
        message: "operator DOMAIN/APP_BASE_URL unset",
      },
      { status: 503 }
    );
  }

  const status = await verifyFlightStatus(
    {
      nodeId: id,
      slug,
      primary: slug === "operator",
      baseDomain: rootDomain(apex),
    },
    createNodeProber()
  );

  return NextResponse.json(status);
}
