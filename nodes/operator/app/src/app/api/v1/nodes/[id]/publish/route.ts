// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/publish`
 * Purpose: Build the governance-only repo-spec YAML and open a PR against the target repo via the GitHub App.
 * Scope: Owner-gated. Advances dao_formed → published when the PR is opened. Idempotent: re-opening
 *   yields the existing PR.
 * Invariants: GH_APP_INSTALL_REQUIRED, NODE_SOVEREIGNTY (PR only; never force-push), STATE_MACHINE_TOTAL.
 * Side-effects: IO (GitHub REST API, Postgres)
 * Links: src/adapters/server/vcs/github-repo-write.ts, task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { resolveAppDb } from "@/bootstrap/container";
import { transition } from "@/features/nodes/state-machine";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, ctx: RouteParams) {
  const session = await getServerSessionUser();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const env = serverEnv();
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    return NextResponse.json(
      {
        error: "operator not configured for repo write",
        reason: "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
      },
      { status: 503 }
    );
  }
  // Mint owner + template home are env-scoped and FAIL CLOSED — never derived from the operator's
  // own monorepo org. A test/candidate operator must have zero access to Cogni-DAO; deriving the
  // mint target from repoOwner would let it mint into the real org. So both are required explicitly.
  const mintOwner = env.NODE_MINT_OWNER;
  const templateOwner = env.NODE_TEMPLATE_OWNER;
  if (!mintOwner || !templateOwner) {
    return NextResponse.json(
      {
        error: "operator not configured for node minting",
        reason:
          "NODE_MINT_OWNER + NODE_TEMPLATE_OWNER required (env-scoped; must not derive from the operator's own monorepo org)",
      },
      { status: 503 }
    );
  }

  const { id } = await ctx.params;
  const db = resolveAppDb();

  const existing = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .limit(1)
  );
  const node = existing[0];
  if (!node) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Idempotent: if already published, return the existing PR.
  if (
    ["published", "wallet_ready", "payments_ready", "active"].includes(
      node.status
    ) &&
    node.publishPrUrl
  ) {
    return NextResponse.json({ node, alreadyPublished: true });
  }

  const t = transition(node.status as NodeStatus, { type: "spec_published" });
  if (!t.ok) {
    return NextResponse.json(
      {
        error: "invalid state for publish",
        reason: t.reason,
        currentStatus: node.status,
      },
      { status: 409 }
    );
  }

  if (
    !node.chainId ||
    !node.daoAddress ||
    !node.pluginAddress ||
    !node.signalAddress
  ) {
    return NextResponse.json(
      { error: "node row missing required addresses for repo-spec emission" },
      { status: 409 }
    );
  }

  // Submodule birth: mint the node's own repo from the node-template template (its ~1100 files live
  // there, not inlined into the operator), then the operator authors a PR pinning it as a git
  // submodule at `nodes/<slug>` + the footprint gens — one App-authored commit, PR URL synchronous.
  const writer = createNodeRepoWriter(env);
  const identity = {
    nodeId: node.id,
    chainId: node.chainId,
    daoContract: node.daoAddress,
    pluginContract: node.pluginAddress,
    signalContract: node.signalAddress,
  };
  let pr: { prNumber: number; prUrl: string };
  try {
    const minted = await writer.generateFromTemplate({
      templateOwner,
      owner: mintOwner,
      slug: node.slug,
      ...identity,
    });
    // Submodule-PR target = the operator monorepo (nodes live at nodes/<slug> there). Non-negotiable.
    pr = await writer.openNodeSubmodulePr({
      owner: node.repoOwner,
      repo: node.repoName,
      slug: node.slug,
      ...identity,
      nodeRepoUrl: minted.cloneUrl,
      nodeRepoHeadSha: minted.headSha,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: "node-app PR authoring failed", reason: message },
      { status: 502 }
    );
  }

  const [updated] = await withTenantScope(
    db,
    userActor(session.id as UserId),
    async (tx) =>
      tx
        .update(nodes)
        .set({
          status: t.nextStatus,
          publishPrUrl: pr.prUrl,
          updatedAt: new Date(),
        })
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .returning()
  );

  return NextResponse.json({ node: updated, pr });
}
