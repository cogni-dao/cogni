// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/reconcile-actions`
 * Purpose: Node GitHub-Actions-permissions reconcile verb (bug.5482) — re-apply the
 *   birth-path `ensureActionsEnabled` config (PUT actions/permissions `allowed_actions:"all"`
 *   + workflow `default_workflow_permissions:"write"`) onto an EXISTING registered node's
 *   repo. The formation step runs ONLY at mint and has no reconcile path (unlike
 *   reconcile-protection / reconcile-merge-queue); a node minted before it sits at GitHub's
 *   restrictive Actions default, so its own PR workflows never start (0 runs → required
 *   checks never report → operator merge fail-closes `not_green`). This verb heals that
 *   without reformation or a hand-run admin script.
 * Scope: Session auth + a single `node.administer` authz-gate on the resolved node
 *   (hub-admin / node-owner scope — deliberately ABOVE env_manager, since flipping a repo's
 *   Actions permissions is repo-admin authority). `node.administer` maps to the directly-
 *   assignable `admin` relation already present on `type node` (no model/bootstrap change).
 *   Resolves the node's own repo from catalog `source_repo` via `resolveNodeRepo`, then
 *   delegates to `GitHubRepoWriter.reconcileNodeActionsPermissions`.
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED; ADMIN_GATED (503 authz_unavailable / 403 authz_denied,
 *     fail-closed, no owner bypass).
 *   - IDEMPOTENT: `ensureActionsEnabled` is the same formation step; re-running converges.
 *   - REMOTE_SOURCE_ONLY: an IN-REPO node (no catalog `source_repo`) fails closed with a
 *     typed 422 `in_repo_node_unsupported` — the parent monorepo's Actions config is
 *     admin-owned.
 * Side-effects: IO (GitHub REST API, Postgres read)
 * Links: src/adapters/server/vcs/github-repo-write.ts (reconcileNodeActionsPermissions,
 *   ensureActionsEnabled), bug.5482, story.5016
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { serverEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, routeArgs: RouteParams) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await routeArgs.params;

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

  // ADMIN_GATED: flipping a node repo's GitHub Actions permissions is repo-admin authority —
  // the node-owner (`admin`) scope, deliberately above env_manager. Fail-closed, no bypass.
  const gate = await resolveNodeAndAuthorize({
    id,
    userId: sessionUser.id,
    action: "node.administer",
  });
  if (!gate.ok) {
    const payload =
      gate.errorCode === "node_not_found"
        ? { error: "not found" }
        : gate.errorCode === "authz_unavailable"
          ? { error: "authorization not configured", errorCode: gate.errorCode }
          : { error: "not authorized", errorCode: gate.errorCode };
    return NextResponse.json(payload, { status: gate.status });
  }
  const node = gate.node;

  // Resolve the node's OWN repo from the operator monorepo catalog (`source_repo` presence
  // discriminator) — same env-scoped parent resolution as the sibling node verbs; FAIL CLOSED.
  const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER;
  const parentRepo = env.NODE_SUBMODULE_PARENT_REPO;
  if (!parentOwner || !parentRepo) {
    return NextResponse.json(
      {
        error: "operator not configured for catalog read",
        reason:
          "NODE_SUBMODULE_PARENT_OWNER + NODE_SUBMODULE_PARENT_REPO required (env-scoped deployment parent)",
      },
      { status: 503 }
    );
  }

  const writer = createNodeRepoWriter(env);
  let result: Awaited<
    ReturnType<typeof writer.reconcileNodeActionsPermissions>
  >;
  try {
    const { owner, repo } = await writer.resolveNodeRepo({
      parentOwner,
      parentRepo,
      slug: node.slug,
    });
    // resolveNodeRepo's IN-REPO shortcut returns {owner: parentOwner, repo: parentRepo} for a
    // catalog row with no `source_repo` — the writer fails closed on that flag.
    const isInRepoNode = owner === parentOwner && repo === parentRepo;
    result = await writer.reconcileNodeActionsPermissions({
      owner,
      repo,
      slug: node.slug,
      isInRepoNode,
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const code = (err as { code?: string })?.code;
    const reason = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      {
        error: "node actions reconcile failed",
        errorCode: code,
        reason,
      },
      { status: typeof status === "number" ? status : 502 }
    );
  }

  return NextResponse.json({
    node: { id: node.nodeId, slug: node.slug },
    result,
  });
}
