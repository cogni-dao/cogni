// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/review/dispatch.server`
 * Purpose: App-layer facade for dispatching PR reviews via Temporal workflow.
 * Scope: Extracts webhook payload, resolves billing context, starts PrReviewWorkflow. Fire-and-forget.
 * Invariants:
 *   - Per NORMATIVE_WEBHOOK_PATTERN: starts Temporal workflow and exits immediately
 *   - Per ACTIVITY_IDEMPOTENCY: workflowId = pr-review:{owner}/{repo}/{prNumber}/{headSha}
 *   - No inline graph execution — all AI runs through GraphRunWorkflow child
 *   - No secrets in workflow input — only installationId (public)
 * Side-effects: IO (starts Temporal workflow)
 * Links: task.0191, docs/spec/temporal-patterns.md
 * @public
 */

import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { Logger } from "pino";
import { getContainer, getTemporalWorkflowClient } from "@/bootstrap/container";
import { getNodeId } from "@/shared/config";

/** PR actions that trigger review. */
const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/**
 * Dispatch a PR review from a GitHub pull_request webhook payload.
 * Fire-and-forget: starts Temporal PrReviewWorkflow and exits.
 * Errors are logged, never thrown.
 */
export function dispatchPrReview(
  payload: Record<string, unknown>,
  env: {
    GH_REVIEW_APP_ID?: string | undefined;
    GH_REVIEW_APP_PRIVATE_KEY_BASE64?: string | undefined;
  },
  log: Logger
): void {
  // Filter: only review-triggering actions
  const action = payload.action as string | undefined;
  if (!action || !REVIEW_ACTIONS.has(action)) return;

  // Check credentials are configured (worker needs them in its env too)
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    log.debug(
      "PR review skipped — GH_REVIEW_APP_ID/PRIVATE_KEY not configured"
    );
    return;
  }

  // Extract context from payload
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const installation = payload.installation as
    | Record<string, unknown>
    | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;

  if (!pr || !installation || !repo) {
    log.warn(
      "PR review skipped — missing pull_request/installation/repository in payload"
    );
    return;
  }

  const head = pr.head as Record<string, unknown>;
  const repoOwner = (repo.owner as Record<string, unknown>)?.login as string;
  const repoName = repo.name as string;
  const prNumber = pr.number as number;
  const headSha = head.sha as string;
  const installationId = installation.id as number;

  // Fire-and-forget: start Temporal workflow
  void startPrReviewWorkflow(
    { owner: repoOwner, repo: repoName, prNumber, headSha, installationId },
    log
  );
}

/**
 * Resolve billing context and start PrReviewWorkflow via Temporal.
 * All errors caught and logged — never blocks webhook response.
 */
async function startPrReviewWorkflow(
  ctx: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    installationId: number;
  },
  log: Logger
): Promise<void> {
  try {
    const container = getContainer();

    // Resolve system tenant billing account for virtual key
    const billingAccount =
      await container.serviceAccountService.getBillingAccountById(
        COGNI_SYSTEM_BILLING_ACCOUNT_ID
      );
    if (!billingAccount) {
      log.error("PR review failed — system tenant billing account not found");
      return;
    }

    const { client: workflowClient, taskQueue } =
      await getTemporalWorkflowClient();

    // Stable business key for idempotency — retries on same headSha are no-ops
    const workflowId = `pr-review:${ctx.owner}/${ctx.repo}/${ctx.prNumber}/${ctx.headSha}`;

    await workflowClient.start("PrReviewWorkflow", {
      taskQueue,
      workflowId,
      args: [
        {
          nodeId: getNodeId(),
          owner: ctx.owner,
          repo: ctx.repo,
          prNumber: ctx.prNumber,
          headSha: ctx.headSha,
          installationId: ctx.installationId,
          actorUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
          billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
          virtualKeyId: billingAccount.defaultVirtualKeyId,
        },
      ],
    });

    log.info(
      { workflowId, prNumber: ctx.prNumber },
      "PrReviewWorkflow started"
    );
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      log.info(
        { prNumber: ctx.prNumber, headSha: ctx.headSha },
        "PR review workflow already running — idempotent skip"
      );
      return;
    }
    log.error(
      { error: String(error), prNumber: ctx.prNumber },
      "PR review dispatch failed"
    );
  }
}
