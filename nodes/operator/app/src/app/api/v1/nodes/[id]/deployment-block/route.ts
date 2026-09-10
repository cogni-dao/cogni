// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/deployment-block`
 * Purpose: Node deployment-declaration verb (story.5016 T6) — mint the stock `cogni-node-app-v1`
 *   `deployment:` block into an existing node's OWN `.cogni/repo-spec.yaml` by opening an
 *   operator-authored PR on the node repo. Existing nodes predate the deployment contract and ride
 *   the legacy secret-free default, which external-compute placement refuses
 *   (`assertDeclaredNodeDeployment`); this route closes that gap with zero hand-edited YAML.
 * Scope: Session auth + a single MANAGE_ENVS authz-gate on the resolved node (deploy-topology
 *   governance — the SAME scope as env membership; deliberately no new RBAC rung). Resolves the
 *   node's own repo from catalog `source_repo` via `resolveNodeRepo`, then delegates the splice +
 *   PR to `GitHubRepoWriter.openNodeDeploymentBlockPr`. The T5 placement flow may later call the
 *   writer directly; this route stays the self-contained, testable surface.
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED, PR_AGAINST_MAIN (never force-push to a node repo's main).
 *   - MANAGE_ENVS_GATED: minting the deployment declaration is a deploy-topology change and
 *     requires `node.manage_envs` (can_manage_envs). Fail-closed with a distinct code
 *     (503 authz_unavailable / 403 authz_denied), no owner bypass.
 *   - IDEMPOTENT: a node whose repo-spec already declares ANY `deployment:` block returns
 *     `no_changes` (a node's own hand-authored declaration is never overwritten).
 *   - SINGLE_HOME: writes ONLY the node's own `.cogni/repo-spec.yaml`, never a `nodes/<x>/` path.
 * Side-effects: IO (GitHub REST API, Postgres read)
 * Links: src/adapters/server/vcs/github-repo-write.ts (openNodeDeploymentBlockPr),
 *   packages/repo-spec/src/deployment-activation.ts, task.5083, story.5016
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

  // MANAGE_ENVS_GATED: minting a node's deployment declaration is a deploy-topology change —
  // the same narrow governance scope as env membership, NOT flight/promote. Fail-closed
  // (503 if no authority configured), no owner bypass.
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

  // The node's OWN repo is resolved from the operator monorepo catalog (`source_repo` presence
  // discriminator) — resolve the env-scoped deployment parent exactly like the envs verb does
  // (never derived from persisted node rows; FAIL CLOSED).
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
  let result: Awaited<ReturnType<typeof writer.openNodeDeploymentBlockPr>>;
  try {
    const { owner, repo } = await writer.resolveNodeRepo({
      parentOwner,
      parentRepo,
      slug: node.slug,
    });
    result = await writer.openNodeDeploymentBlockPr({
      owner,
      repo,
      slug: node.slug,
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const code = (err as { code?: string })?.code;
    const reason = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: "node deployment-block write failed", errorCode: code, reason },
      { status: typeof status === "number" ? status : 502 }
    );
  }

  return NextResponse.json({
    node: { id: node.nodeId, slug: node.slug },
    result,
  });
}
