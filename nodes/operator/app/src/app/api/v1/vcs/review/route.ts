// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/vcs/review`
 * Purpose: Developer-requested PR review. The ONLY trigger of `PrReviewWorkflow` — no push,
 *   commit or PR webhook starts a review.
 * Scope: Auth → node RBAC (`node.flight`) → repo resolution → facade (PR pin + developer billing +
 *   workflow start). Adds no graph or GitHub write logic of its own.
 * Invariants:
 *   - AUTH_REQUIRED: Bearer token (machine agents) or SIWE session.
 *   - REVIEW_IS_DEV_TRIGGERED (story.5102): this verb is the single review producer.
 *   - SAME_AUTH_AS_FLIGHT: `node.flight` on the named node via `resolveNodeAndAuthorize`; fails
 *     closed (503) without an authority.
 *   - ONE_ACTOR_ONE_ACCOUNT: the requesting developer is the run actor and pays from their own
 *     billing account (resolved in the facade).
 *   - NO_REPO_FROM_AGENT: owner/repo come from `resolveNodeRepo`, never the body.
 *   - STABLE_REVIEW_ID: a review of the same head already running → 409 `review_running`.
 *   - V0_OPERATOR_ONLY (story.5102): code reads are authorized on the operator only, so a review of
 *     any other node is refused up front with 422 `review_node_unsupported`.
 *   - CONTRACTS_ARE_TRUTH: input/output parsed through `reviewOperation`.
 * Side-effects: IO (DB read, OpenFGA check, GitHub reads, Temporal start)
 * Links: packages/node-contracts/src/vcs.review.v1.contract.ts, story.5102,
 *   https://cognidao.org/knowledge/pr-review-grounded-gate
 * @public
 */

import { reviewOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { startPrReview } from "@/app/_facades/review/request.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "vcs.review", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    const durationMs = () => Math.round(performance.now() - startedAt);

    const fail = (
      status: number,
      errorCode: string,
      error: string,
      extra: Record<string, unknown> = {}
    ): NextResponse => {
      const level = status >= 500 ? "error" : "warn";
      ctx.log[level](
        {
          event: EVENT_NAMES.VCS_REVIEW_REQUEST_COMPLETE,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          outcome: "error",
          status,
          errorCode,
          durationMs: durationMs(),
          ...extra,
        },
        EVENT_NAMES.VCS_REVIEW_REQUEST_COMPLETE
      );
      return NextResponse.json({ error, errorCode, ...extra }, { status });
    };

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, "validation_error", "Invalid request");
    }
    const parsed = reviewOperation.input.safeParse(body);
    if (!parsed.success) {
      return fail(400, "validation_error", "Invalid request");
    }
    const { nodeId, prNumber } = parsed.data;

    // SAME_AUTH_AS_FLIGHT: node.flight on the named node, fail closed.
    const rbac = await resolveNodeAndAuthorize({
      id: nodeId,
      userId: sessionUser.id,
      action: "node.flight",
    });
    if (!rbac.ok) {
      return fail(
        rbac.status,
        rbac.errorCode,
        rbac.errorCode === "authz_unavailable"
          ? "authorization unavailable"
          : rbac.errorCode === "node_not_found"
            ? "node not found"
            : "not authorized",
        { prNumber }
      );
    }

    // V0_OPERATOR_ONLY: the reviewer's code reads are authorized on this node only.
    if (rbac.node.nodeId !== getNodeId()) {
      return fail(
        422,
        "review_node_unsupported",
        "v0 reviews operator PRs only",
        { prNumber }
      );
    }

    // NO_REPO_FROM_AGENT: one resolution path for every node (operator → parent monorepo).
    const env = serverEnv();
    const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER;
    const parentRepo = env.NODE_SUBMODULE_PARENT_REPO;
    if (!parentOwner || !parentRepo) {
      return fail(
        503,
        "review_target_not_configured",
        "review target repo not configured",
        { prNumber }
      );
    }
    let owner: string;
    let repo: string;
    try {
      const nodeRepo = await createOperatorDeployPlane(env).resolveNodeRepo({
        parentOwner,
        parentRepo,
        slug: rbac.node.slug,
      });
      owner = nodeRepo.owner;
      repo = nodeRepo.repo;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      return fail(
        code === "catalog_missing" ? 404 : 503,
        code === "catalog_missing" ? "catalog_missing" : "node_repo_unresolved",
        code === "catalog_missing"
          ? "node repo not resolvable from catalog"
          : "node repo could not be resolved",
        { prNumber }
      );
    }

    const result = await startPrReview({
      sessionUser,
      reviewedNodeId: rbac.node.nodeId,
      owner,
      repo,
      prNumber,
      log: ctx.log,
    });
    if (!result.ok) {
      return fail(result.status, result.errorCode, result.error, {
        prNumber,
        ...(result.headSha ? { headSha: result.headSha } : {}),
      });
    }

    const output = reviewOperation.output.parse({
      workflowId: result.workflowId,
      headSha: result.headSha,
      requestId: result.requestId,
    });
    logEvent(
      ctx.log,
      EVENT_NAMES.VCS_REVIEW_REQUEST_COMPLETE,
      {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        outcome: "success",
        status: 202,
        durationMs: durationMs(),
        prNumber,
        targetNodeId: rbac.node.nodeId,
        requestId: output.requestId,
        headSha8: output.headSha.slice(0, 8),
      },
      EVENT_NAMES.VCS_REVIEW_REQUEST_COMPLETE
    );
    return NextResponse.json(output, { status: 202 });
  }
);
