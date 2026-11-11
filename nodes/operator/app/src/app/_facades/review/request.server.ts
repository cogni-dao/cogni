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
 *   - ONE_ACTOR_ONE_ACCOUNT: holds for the operator's own PRs: actor = the requesting developer; payer =
 *     their own billing account and its default virtual key. For a LINKED node (story.0038) the actor is
 *     still the developer, the payer is the system tenant (`payerKind: "system_free"`, read through
 *     `serviceAccountService`, no developer account is made) and the model is the free default only.
 *   - LINKED_REVIEW_GATES (story.0038): before any GitHub read a linked review needs a `connected` link
 *     (one poll step runs for a `pending` one) else 409 `review_node_not_linked`; then the default model must
 *     be free (503 `review_free_model_unavailable`, the runtime free-model guard); then the caps hold (3 per
 *     developer and 10 per node per hour, 429 `review_rate_limited`).
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
import { COGNI_SYSTEM_BILLING_ACCOUNT_ID } from "@cogni/node-shared";
import { PrReviewWorkflowInputSchema } from "@cogni/temporal-workflows";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { Logger } from "pino";
import {
  getContainer,
  getTemporalWorkflowClient,
  resolveAiAdapterDeps,
} from "@/bootstrap/container";
import { getNodeServiceLinkService } from "@/bootstrap/node-service-links";
import { consumeLinkedReview } from "@/bootstrap/review/linked-review-caps";
import {
  createReviewGithubPlane,
  DEFAULT_REVIEW_MODELREF,
} from "@/bootstrap/review/resolve-review-route";
import { getOrCreateBillingAccountForUser } from "@/lib/auth/mapping";
import { isModelFree } from "@/shared/ai/model-catalog.server";
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
  // LINKED_REVIEW_GATES: a node other than this operator needs a connected link, a free default
  // model and spare cap, all before any GitHub read.
  const linked = input.reviewedNodeId !== getNodeId();
  if (linked) {
    const links = getNodeServiceLinkService();
    if (!links) {
      return {
        ok: false,
        status: 503,
        errorCode: "node_service_links_unavailable",
        error: "node service links are not configured",
      };
    }
    const link = await links.openLink(input.reviewedNodeId, "git-review");
    if (link?.state !== "connected") {
      return {
        ok: false,
        status: 409,
        errorCode: "review_node_not_linked",
        error: "this node has not linked the review service",
      };
    }
    if (!(await isModelFree(DEFAULT_REVIEW_MODELREF.modelId))) {
      return {
        ok: false,
        status: 503,
        errorCode: "review_free_model_unavailable",
        error: "the free review model is unavailable",
      };
    }
    if (
      !consumeLinkedReview({
        developerId: input.sessionUser.id,
        nodeId: input.reviewedNodeId,
      })
    ) {
      return {
        ok: false,
        status: 429,
        errorCode: "review_rate_limited",
        error: "review limit reached for this developer or node; try later",
      };
    }
  }

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

  // The payer. Operator PRs: the developer pays, like chat (ONE_ACTOR_ONE_ACCOUNT). Linked node: the
  // system tenant holds a $0 receipt (v0 free tier); no developer account is made, and the actor stays
  // the developer below.
  let billingAccount: { id: string; defaultVirtualKeyId: string };
  if (linked) {
    const system =
      await getContainer().serviceAccountService.getBillingAccountById(
        COGNI_SYSTEM_BILLING_ACCOUNT_ID
      );
    if (!system) {
      return {
        ok: false,
        status: 503,
        errorCode: "review_system_payer_unavailable",
        error: "the review payer account is unavailable",
      };
    }
    billingAccount = {
      id: system.id,
      defaultVirtualKeyId: system.defaultVirtualKeyId,
    };
  } else {
    const { accountService } = resolveAiAdapterDeps(
      toUserId(input.sessionUser.id)
    );
    billingAccount = await getOrCreateBillingAccountForUser(accountService, {
      userId: input.sessionUser.id,
      ...(input.sessionUser.walletAddress
        ? { walletAddress: input.sessionUser.walletAddress }
        : {}),
    });
  }

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
    payerKind: linked ? "system_free" : "developer",
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
