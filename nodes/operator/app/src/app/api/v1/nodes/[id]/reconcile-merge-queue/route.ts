// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/reconcile-merge-queue`
 * Purpose: Converge a node repo's live GitHub merge queue to the git-owned operator policy.
 * Scope: Required auth + node.manage_envs authorization, node-to-repo resolution, and delegation
 *   to the GitHub App-backed repo writer. The route carries no GitHub policy of its own.
 * Invariants:
 *   - POLICY_FROM_GIT: desired state is `infra/github/merge-queue-ruleset.json` on parent `main`.
 *   - APP_IS_PRIVILEGE_BRIDGE: callers hold node-scoped RBAC, never GitHub administration tokens.
 *   - SERIALIZATION_PRESERVED: the adapter rejects non-ALLGREEN policy or any bypass actor.
 *   - READBACK_OR_FAIL: a successful response means GitHub returned the desired active policy.
 * Side-effects: GitHub ruleset write only when live state differs from committed policy.
 * Links: task.5141, docs/spec/merge-queue-config.md
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  {
    routeId: "nodes.reconcile-merge-queue",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, sessionUser, routeArgs) => {
    if (!routeArgs) throw new Error("context required for dynamic routes");
    const { id } = await routeArgs.params;
    const env = serverEnv();
    if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
      return NextResponse.json(
        {
          error: "operator not configured for repo write",
          reason:
            "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
        },
        { status: 503 }
      );
    }

    const gate = await resolveNodeAndAuthorize({
      id,
      userId: sessionUser.id,
      action: "node.manage_envs",
    });
    if (!gate.ok) {
      const error =
        gate.errorCode === "node_not_found"
          ? "not found"
          : gate.errorCode === "authz_unavailable"
            ? "authorization not configured"
            : "not authorized";
      return NextResponse.json(
        { error, errorCode: gate.errorCode },
        { status: gate.status }
      );
    }

    const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER;
    const parentRepo = env.NODE_SUBMODULE_PARENT_REPO;
    if (!parentOwner || !parentRepo) {
      return NextResponse.json(
        {
          error: "operator not configured for repository policy",
          reason:
            "NODE_SUBMODULE_PARENT_OWNER + NODE_SUBMODULE_PARENT_REPO required",
        },
        { status: 503 }
      );
    }

    const writer = createNodeRepoWriter(env);
    try {
      const target = await writer.resolveNodeRepo({
        parentOwner,
        parentRepo,
        slug: gate.node.slug,
      });
      const result = await writer.reconcileMergeQueuePolicy({
        policyOwner: parentOwner,
        policyRepo: parentRepo,
        policyRef: "main",
        targetOwner: target.owner,
        targetRepo: target.repo,
      });
      return NextResponse.json({
        node: { id: gate.node.nodeId, slug: gate.node.slug },
        repository: `${target.owner}/${target.repo}`,
        result,
      });
    } catch (error) {
      const status = (error as { status?: number })?.status;
      const code = (error as { code?: string })?.code;
      const reason = error instanceof Error ? error.message : "unknown";
      return NextResponse.json(
        {
          error: "merge-queue policy reconcile failed",
          errorCode: code,
          reason,
        },
        { status: typeof status === "number" ? status : 502 }
      );
    }
  }
);
