// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/flight-status`
 * Purpose: Per-node, per-env LIVENESS view — GET proof that a node not only deployed (serving) but
 *   actually carries a real graph run. Lets a node's DEVELOPER catch the "green-but-dead" class
 *   (200-but-no-Temporal-poller, stale routing, worker-401) that Argo health can't see.
 * Scope: Thin HTTP shell — Cogni-token auth, developer-RBAC gate, resolve {id} via dev1's registry,
 *   delegate to the feature verifier with a public-surface prober. No cluster/GH/Grafana auth.
 * Invariants:
 *   - COGNI_TOKEN_ONLY (getSessionUser = Bearer-first); NO_CLUSTER_AUTH; read-only.
 *   - DEVELOPER_GATED: requires `node.flight` (→ `can_flight from developer`) — the SAME tuple as flight,
 *     not world-readable. Fail-closed when the authz store is unavailable.
 * Side-effects: IO (registry read, authz check, network probes)
 * Links: src/features/nodes/flight-status.ts, vcs/flight/route.ts (same tuple), task.5024
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer, resolveNodeRegistry } from "@/bootstrap/container";
import { createNodeProber } from "@/bootstrap/node-flight.factory";
import { rootDomain, verifyFlightStatus } from "@/features/nodes/flight-status";
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

  // Consume dev1's registry: match {id} as either the repo-spec nodeId (UUID) or the slug.
  const summaries = await resolveNodeRegistry().listPublic();
  const node = summaries.find((n) => n.nodeId === id || n.slug === id);
  if (!node?.nodeId) {
    return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  }

  // Developer-gated: the SAME `node.flight` tuple as flight. Fail-closed (deny) without a store.
  const authorization = getContainer().authorization;
  if (!authorization) {
    return NextResponse.json({ error: "authz_unavailable" }, { status: 503 });
  }
  const decision = await authorization.check({
    actorId: `user:${sessionUser.id}`,
    action: "node.flight",
    resource: `node:${node.nodeId}`,
    context: { tenantId: node.nodeId, nodeId: node.nodeId },
  });
  if (decision.decision !== "allow") {
    const code: AuthzDecisionCode = decision.code;
    return NextResponse.json(
      { error: code },
      { status: code === "authz_unavailable" ? 503 : 403 }
    );
  }

  const slug = node.slug;
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
      nodeId: node.nodeId,
      slug,
      primary: node.primary ?? slug === "operator",
      baseDomain: rootDomain(apex),
    },
    createNodeProber()
  );

  return NextResponse.json(status);
}
