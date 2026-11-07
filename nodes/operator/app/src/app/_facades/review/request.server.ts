// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/review/request.server`
 * Purpose: App-layer facade for a developer-requested PR review — pin the PR, bind the
 *   developer's own billing, and start `PrReviewWorkflow` with a request-bound identity.
 * Scope: Called only by POST /api/v1/vcs/review after node RBAC + repo resolution. Reads the PR
 *   through the review GitHub plane, resolves the developer's billing account, validates the
 *   workflow input via its source-of-truth schema, then starts the workflow. Never runs a graph.
 * Invariants:
 *   - REVIEW_IS_DEV_TRIGGERED (story.5102): this is the ONLY producer of PrReviewWorkflow.
 *   - ONE_ACTOR_ONE_ACCOUNT: actor = the requesting developer; payer = their own billing account
 *     and its default virtual key. Never the system tenant.
 *   - STABLE_REVIEW_ID: workflowId = pr-review:{owner}/{repo}/{pr}/{headSha}. A running duplicate
 *     → `review_running` (409); after it closes the same id starts again (re-run a SHA).
 *   - REVIEW_SUBJECT_IS_HOST_BOUND: codeSubject owner/repo come from resolveNodeRepo (the caller),
 *     head/base from the PR read here — never from the request body.
 *   - DISPATCH_FAIL_FAST: input parsed through `PrReviewWorkflowInputSchema` before start.
 * Side-effects: IO (GitHub reads via review plane, DB billing read/create, Temporal start)
 * Links: story.5102, https://cognidao.org/knowledge/pr-review-grounded-gate,
 *   packages/temporal-workflows/src/workflows/pr-review.schema.ts
 * @public
 */

import { randomUUID } from "node:crypto";
import { toUserId } from "@cogni/ids";
import { PrReviewWorkflowInputSchema } from "@cogni/temporal-workflows";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { Logger } from "pino";
import {
  getTemporalWorkflowClient,
  resolveAiAdapterDeps,
} from "@/bootstrap/container";
import { createReviewGithubPlane } from "@/bootstrap/review/resolve-review-route";
import { getOrCreateBillingAccountForUser } from "@/lib/auth/mapping";
import { getNodeId } from "@/shared/config";

export type StartPrReviewResult =
  | {
      readonly ok: true;
      readonly workflowId: string;
      readonly headSha: string;
      readonly requestId: string;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly errorCode: string;
      readonly error: string;
      readonly headSha?: string;
    };

function httpStatus(error: unknown): number | undefined {
  return error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

/** Start a review for one PR of a resolved node repository. Errors map to a typed result. */
export async function startPrReview(input: {
  readonly sessionUser: {
    readonly id: string;
    readonly walletAddress?: string | null | undefined;
  };
  /** Reviewed node (UUID) — goes ONLY into codeSubject.nodeId. */
  readonly reviewedNodeId: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly log: Logger;
}): Promise<StartPrReviewResult> {
  const plane = createReviewGithubPlane(input.log);
  if (!plane) {
    return {
      ok: false,
      status: 503,
      errorCode: "review_not_configured",
      error: "review GitHub App not configured",
    };
  }

  let pinned: Awaited<ReturnType<typeof plane.resolvePullRequest>>;
  try {
    pinned = await plane.resolvePullRequest({
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
    });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404) {
      return {
        ok: false,
        status: 404,
        errorCode: "pr_not_found",
        error: "pull request or review App installation not found",
      };
    }
    input.log.warn(
      { err: String(error), prNumber: input.prNumber },
      "review PR read failed"
    );
    return {
      ok: false,
      status: 502,
      errorCode: "pr_read_failed",
      error: "could not read the pull request",
    };
  }
  if (pinned.state !== "open") {
    return {
      ok: false,
      status: 409,
      errorCode: "pr_not_open",
      error: `pull request is ${pinned.state}`,
      headSha: pinned.headSha,
    };
  }

  // ONE_ACTOR_ONE_ACCOUNT: the developer pays, like chat.
  const { accountService } = resolveAiAdapterDeps(
    toUserId(input.sessionUser.id)
  );
  const billingAccount = await getOrCreateBillingAccountForUser(
    accountService,
    {
      userId: input.sessionUser.id,
      ...(input.sessionUser.walletAddress
        ? { walletAddress: input.sessionUser.walletAddress }
        : {}),
    }
  );

  const requestId = randomUUID();
  const workflowInput = PrReviewWorkflowInputSchema.parse({
    nodeId: getNodeId(),
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    headSha: pinned.headSha,
    baseSha: pinned.baseSha,
    installationId: pinned.installationId,
    actorUserId: input.sessionUser.id,
    billingAccountId: billingAccount.id,
    virtualKeyId: billingAccount.defaultVirtualKeyId,
    requestId,
    requestedBy: input.sessionUser.id,
    codeSubject: {
      nodeId: input.reviewedNodeId,
      owner: input.owner,
      repo: input.repo,
      baseSha: pinned.baseSha,
      headSha: pinned.headSha,
    },
  });
  const workflowId = `pr-review:${workflowInput.owner}/${workflowInput.repo}/${workflowInput.prNumber}/${workflowInput.headSha}`;

  const { client: workflowClient, taskQueue } =
    await getTemporalWorkflowClient();
  try {
    await workflowClient.start("PrReviewWorkflow", {
      taskQueue,
      workflowId,
      args: [workflowInput],
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      return {
        ok: false,
        status: 409,
        errorCode: "review_running",
        error: "a review of this PR head is already running",
        headSha: workflowInput.headSha,
      };
    }
    throw error;
  }

  return { ok: true, workflowId, headSha: workflowInput.headSha, requestId };
}
