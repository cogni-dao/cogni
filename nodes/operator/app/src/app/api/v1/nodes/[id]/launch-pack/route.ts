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
import { nodeLaunchPackOperation } from "@/contracts/nodes.launch-pack.v1.contract";
import {
  buildNodeLaunchPack,
  nodeRepoUrlForSlug,
} from "@/features/nodes/launch-pack";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import {
  buildNodeKnowledgeRemote,
  knowledgeRemoteWebUrl,
} from "@/shared/node-app-scaffold/knowledge-remote";

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
  const parsed = nodeLaunchPackOperation.input.safeParse({ nodeId: id });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = resolveAppDb();

  const rows = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.id, parsed.data.nodeId),
            eq(nodes.ownerUserId, session.id)
          )
        )
        .limit(1)
  );

  const node = rows[0];
  if (!node) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const env = serverEnv();
  const knowledgeRemote = env.DOLTHUB_OWNER
    ? buildNodeKnowledgeRemote(node.slug, env.DOLTHUB_OWNER)
    : null;

  return NextResponse.json(
    nodeLaunchPackOperation.output.parse(
      buildNodeLaunchPack({
        nodeId: node.id,
        slug: node.slug,
        status: node.status as NodeStatus,
        nodeRepoUrl: nodeRepoUrlForSlug({
          slug: node.slug,
          mintOwner: env.NODE_MINT_OWNER,
          publishPrUrl: node.publishPrUrl,
        }),
        knowledgeRepoUrl: knowledgeRemote
          ? knowledgeRemoteWebUrl(knowledgeRemote)
          : null,
        publishPrUrl: node.publishPrUrl,
        operatorOrigin: new URL(request.url).origin,
      })
    )
  );
}
