// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/launch-pack`
 * Purpose: Authenticated node-launch handoff JSON for external personal AI
 *   assistants. The response is intentionally derived from the node row and
 *   live URLs, not from saved orchestration state.
 * Scope: Owner-gated read route. No CI polling, no flight dispatch.
 * Links: src/features/nodes/launch-pack.ts, node-launch-handoff
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { resolveAppDb } from "@/bootstrap/container";
import { buildNodeLaunchPack } from "@/features/nodes/launch-pack";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, ctx: RouteParams) {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const db = resolveAppDb();

  const rows = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .limit(1)
  );

  const node = rows[0];
  if (!node) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(
    buildNodeLaunchPack({
      nodeId: node.id,
      slug: node.slug,
      status: node.status as NodeStatus,
      publishPrUrl: node.publishPrUrl,
      operatorOrigin: new URL(request.url).origin,
    })
  );
}
