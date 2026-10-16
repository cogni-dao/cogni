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
 * Scope: Session auth + a single `node.administer` authz-gate on the resolved node — the
 *   node-administrator (`admin`) role, which is now grantable through the standard
 *   request→approve flow (`NODE_ACCESS_ROLES` + CHECK), so an agent requests it and the
 *   owner approves the single tuple. Deliberately ABOVE env_manager: flipping a repo's
 *   Actions permissions is node-admin authority. Resolves the node's own repo from catalog
 *   `source_repo` via `resolveNodeRepo`, then delegates to
 *   `GitHubRepoWriter.reconcileNodeActionsPermissions`.
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED; ADMIN_GATED (503 authz_unavailable / 403 authz_denied,
 *     fail-closed, no owner bypass).
 *   - IDEMPOTENT: `ensureActionsEnabled` is the same formation step; re-running converges.
 *   - REMOTE_SOURCE_ONLY: an IN-REPO node (no catalog `source_repo`) fails closed with a
 *     typed 422 `in_repo_node_unsupported`.
 *   - OBSERVABLE: one terminal `NODE_RECONCILE_ACTIONS_COMPLETE` event per call (every
 *     outcome), so the handler is Loki-attributable at a SHA.
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
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, routeArgs: RouteParams) {
  const ctx = createRequestContext({ baseLog, clock }, request, {
    routeId: "nodes.reconcileActions",
  });
  const startTime = performance.now();
  const complete = (
    outcome: string,
    status: number,
    extra: Record<string, unknown> = {}
  ) =>
    logEvent(
      ctx.log,
      EVENT_NAMES.NODE_RECONCILE_ACTIONS_COMPLETE,
      {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        outcome,
        status,
        durationMs: Math.round(performance.now() - startTime),
        ...extra,
      },
      EVENT_NAMES.NODE_RECONCILE_ACTIONS_COMPLETE
    );

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    complete("unauthorized", 401);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await routeArgs.params;

  const env = serverEnv();
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    complete("not_configured_repo_write", 503, { slug: id });
    return NextResponse.json(
      {
        error: "operator not configured for repo write",
        reason: "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
      },
      { status: 503 }
    );
  }

  // ADMIN_GATED: flipping a node repo's GitHub Actions permissions is node-admin authority —
  // the grantable `admin` role, deliberately above env_manager. Fail-closed, no owner bypass.
  const gate = await resolveNodeAndAuthorize({
    id,
    userId: sessionUser.id,
    action: "node.administer",
  });
  if (!gate.ok) {
    complete(gate.errorCode ?? "authz_failed", gate.status, { slug: id });
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
    complete("not_configured_catalog_read", 503, { slug: node.slug });
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
    const httpStatus = typeof status === "number" ? status : 502;
    complete("error", httpStatus, { slug: node.slug, errorCode: code });
    return NextResponse.json(
      {
        error: "node actions reconcile failed",
        errorCode: code,
        reason,
      },
      { status: httpStatus }
    );
  }

  complete("success", 200, { slug: node.slug, repo: result.repo });
  return NextResponse.json({
    node: { id: node.nodeId, slug: node.slug },
    result,
  });
}
