// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/node-launch-pack-read`
 * Purpose: Share authenticated owner-scoped input assembly across launch-pack versions.
 * Scope: Delivery composition and configured public-origin resolution; versioned output stays in each route.
 * Invariants: Session auth precedes input validation; owner/RLS read and JSON errors are shared.
 *   Absolute packet URLs use configured APP_BASE_URL, never internal request or forwarded headers.
 * Side-effects: IO (session, node read and correlated logs)
 * Links: owned-node-read.ts, nodes.launch-pack.v1.contract.ts, bug.5388
 * @internal
 */

import { NextResponse } from "next/server";

import { readOwnedNode } from "@/app/_lib/owned-node-read";
import { nodeLaunchPackOperation } from "@/contracts/nodes.launch-pack.v1.contract";
import {
  type NodeLaunchPackInput,
  nodeRepoUrlForSlug,
} from "@/features/nodes/launch-pack";
import { getServerSessionUser } from "@/lib/auth/server";
import type { NodeStatus } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import {
  buildNodeKnowledgeRemote,
  knowledgeRemoteWebUrl,
} from "@/shared/node-app-scaffold/knowledge-remote";

export interface NodeLaunchPackReadContext {
  readonly params: Promise<{ id: string }>;
}

export async function readNodeLaunchPackInput(
  request: Request,
  context: NodeLaunchPackReadContext
): Promise<
  | { readonly status: "ready"; readonly input: NodeLaunchPackInput }
  | { readonly status: "error"; readonly response: NextResponse }
> {
  const session = await getServerSessionUser();
  if (!session) {
    return {
      status: "error",
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  const { id } = await context.params;
  const parsed = nodeLaunchPackOperation.input.safeParse({ nodeId: id });
  if (!parsed.success) {
    return {
      status: "error",
      response: NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      ),
    };
  }
  const node = await readOwnedNode({
    id: parsed.data.nodeId,
    userId: session.id,
    routeId: "nodes.launch_pack",
    request,
  });
  if (!node) {
    return {
      status: "error",
      response: NextResponse.json({ error: "not found" }, { status: 404 }),
    };
  }
  const env = serverEnv();
  if (!env.APP_BASE_URL) {
    return {
      status: "error",
      response: NextResponse.json(
        { error: "launch pack unavailable" },
        { status: 503 }
      ),
    };
  }
  const knowledgeRemote = env.DOLTHUB_OWNER
    ? buildNodeKnowledgeRemote(node.slug, env.DOLTHUB_OWNER)
    : null;
  return {
    status: "ready",
    input: {
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
      operatorOrigin: new URL(env.APP_BASE_URL).origin,
    },
  };
}
