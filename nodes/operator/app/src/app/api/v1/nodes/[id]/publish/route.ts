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
import { buildPendingActivationRepoSpecYaml } from "@/features/nodes/repo-spec-builder";
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

  const yamlContent = buildPendingActivationRepoSpecYaml({
    nodeId: node.id,
    chainId: node.chainId,
    daoAddress: node.daoAddress,
    pluginAddress: node.pluginAddress,
    signalAddress: node.signalAddress,
  });

  const writer = createNodeRepoWriter(env);

  const headBranch = `cogni-operator/node-bootstrap-${node.slug}`;
  // v0 monorepo-internal: the node lives at nodes/<slug>/ in Cogni-DAO/cogni.
  const specPath = `nodes/${node.slug}/.cogni/repo-spec.yaml`;

  let result: Awaited<ReturnType<typeof writer.commitFileAndOpenPr>>;
  try {
    result = await writer.commitFileAndOpenPr({
      owner: node.repoOwner,
      repo: node.repoName,
      baseRef: "main",
      headBranch,
      path: specPath,
      content: yamlContent,
      commitMessage: `chore(cogni): bootstrap ${specPath} via operator`,
      prTitle: `cogni-operator: bootstrap node '${node.slug}'`,
      prBody:
        "This PR was opened by the Cogni operator setup wizard.\n\n" +
        `It writes \`${specPath}\` containing the verified DAO formation ` +
        "addresses for this node. Payment activation remains pending and must " +
        "run from the child node's own trust domain.\n\n" +
        `- DAO: \`${node.daoAddress}\`\n` +
        `- TokenVoting plugin: \`${node.pluginAddress}\`\n` +
        `- CogniSignal: \`${node.signalAddress}\`\n` +
        `- Chain: \`${node.chainId}\`\n\n` +
        "Review and merge to register this node in the monorepo.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: "publish failed", reason: message },
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
          publishPrUrl: result.prUrl,
          updatedAt: new Date(),
        })
        .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
        .returning()
  );

  return NextResponse.json({ node: updated, pr: result });
}
