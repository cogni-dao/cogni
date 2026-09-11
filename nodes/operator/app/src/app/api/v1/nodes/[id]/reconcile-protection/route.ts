// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/reconcile-protection`
 * Purpose: Node protection-reconcile verb (bug.5123) — re-apply the birth-path `main`
 *   protection ruleset (PR + standard-CI required checks, zero bypass actors) onto an EXISTING
 *   registered node's repo. Nodes minted before the #1797/task.5028 backstop carry no
 *   required-check protection, so the operator merge gate fail-closes every PR on them
 *   (`not_green` on an empty required-context set); this verb heals that without a hand-run
 *   admin script.
 * Scope: Session auth + a single MANAGE_ENVS authz-gate on the resolved node (repo-governance —
 *   the SAME scope as the sibling deployment-block verb; deliberately no new RBAC rung).
 *   Resolves the node's own repo from catalog `source_repo` via `resolveNodeRepo`, then
 *   delegates to `GitHubRepoWriter.reconcileNodeMainProtection` — the same policy +
 *   `ensureNodeMainPolicyRuleset` write/readback path formation uses (PROTECTION_HAS_ONE_SSOT).
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED; MANAGE_ENVS_GATED (503 authz_unavailable / 403 authz_denied,
 *     fail-closed, no owner bypass).
 *   - IDEMPOTENT_READ_MOSTLY: an already-compliant repo returns `compliant` with zero writes;
 *     a write carries the mismatches that justified it (never a silent mutation).
 *   - PROTECTION_UNAVAILABLE_IS_DISTINCT: the App lacking repo administration surfaces as a
 *     typed 502 `protection_unavailable`, never a generic 500. The fail-closed merge gate
 *     itself is untouched.
 *   - REMOTE_SOURCE_ONLY: an IN-REPO node (no catalog `source_repo`) fails closed with a typed
 *     422 `in_repo_node_unsupported` — the parent monorepo's protection is admin-owned.
 * Side-effects: IO (GitHub REST API, Postgres read)
 * Links: src/adapters/server/vcs/github-repo-write.ts (reconcileNodeMainProtection,
 *   ensureNodeMainPolicyRuleset), src/features/vcs/merge-gate.ts, bug.5123, story.5016
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

  // MANAGE_ENVS_GATED: reconciling a node repo's protection is repo-governance — the same
  // narrow scope as the deployment-block verb, NOT flight/promote. Fail-closed (503 if no
  // authority configured), no owner bypass.
  const gate = await resolveNodeAndAuthorize({
    id,
    userId: sessionUser.id,
    action: "node.manage_envs",
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
  let result: Awaited<ReturnType<typeof writer.reconcileNodeMainProtection>>;
  try {
    const { owner, repo } = await writer.resolveNodeRepo({
      parentOwner,
      parentRepo,
      slug: node.slug,
    });
    // resolveNodeRepo's IN-REPO shortcut returns exactly {owner: parentOwner, repo: parentRepo}
    // for a catalog row with no `source_repo` — the writer fails closed on that flag
    // (REMOTE_SOURCE_ONLY on reconcileNodeMainProtection).
    const isInRepoNode = owner === parentOwner && repo === parentRepo;
    result = await writer.reconcileNodeMainProtection({
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
        error: "node protection reconcile failed",
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
