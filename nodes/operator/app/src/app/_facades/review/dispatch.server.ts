// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/review/dispatch.server`
 * Purpose: App-layer facade for dispatching PR reviews in the operator app.
 * Scope: Extracts webhook payload, resolves billing context, wires adapters, and calls the review feature. Fire-and-forget.
 * Invariants:
 *   - Review-specific orchestration lives in the operator app image, not the shared Temporal worker.
 *   - Graph execution still flows through GraphExecutorPort with the system billing decorators.
 * Side-effects: IO (GitHub API via adapter, LLM via graph executor)
 * Links: task.0191, task.0419, docs/spec/temporal-patterns.md
 * @public
 */

import { toUserId } from "@cogni/ids";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import type { Logger } from "pino";
import { getContainer } from "@/bootstrap/container";
import {
  createGraphExecutor,
  createScopedGraphExecutor,
} from "@/bootstrap/graph-executor.factory";
import { resolveGithubReviewAdapter } from "@/bootstrap/review/resolve-review-route";
import { executeStream } from "@/features/ai/public.server";
import { commitUsageFact } from "@/features/ai/services/billing";
import { preflightCreditCheck } from "@/features/ai/services/preflight-credit-check";
import { handlePrReview } from "@/features/review/public.server";
import type { GateStatus } from "@/features/review/types";
import type { PreflightCreditCheckFn } from "@/ports";

/** PR actions that trigger review. */
const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/**
 * Dispatch a PR review from a GitHub pull_request webhook payload.
 * Fire-and-forget: runs the review handler and exits.
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

  // Check credentials are configured.
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

  // Fire-and-forget: run review in the operator app image.
  void runPrReview(
    { owner: repoOwner, repo: repoName, prNumber, headSha, installationId },
    log
  );
}

/**
 * Resolve billing context and run PR review via the feature handler.
 * All errors caught and logged — never blocks webhook response.
 */
async function runPrReview(
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
    const adapter = resolveGithubReviewAdapter(log);
    if (!adapter) return;

    // Resolve system tenant billing account for virtual key
    const billingAccount =
      await container.serviceAccountService.getBillingAccountById(
        COGNI_SYSTEM_BILLING_ACCOUNT_ID
      );
    if (!billingAccount) {
      log.error("PR review failed — system tenant billing account not found");
      return;
    }

    const actorUserId = COGNI_SYSTEM_PRINCIPAL_USER_ID;
    const accountService = container.accountsForUser(toUserId(actorUserId));
    const preflightCheckFn: PreflightCreditCheckFn = (
      billingAccountId,
      model,
      messages
    ) =>
      preflightCreditCheck({
        billingAccountId,
        messages: [...messages],
        model,
        accountService,
      });

    const executor = createScopedGraphExecutor({
      executor: createGraphExecutor(executeStream, toUserId(actorUserId)),
      preflightCheckFn,
      commitByoUsage: async (fact, usageLog) => {
        await commitUsageFact(
          fact,
          {
            runId: fact.runId,
            attempt: fact.attempt,
            ingressRequestId: fact.runId,
          },
          accountService,
          usageLog as Logger
        );
      },
      billing: {
        billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
        virtualKeyId: billingAccount.defaultVirtualKeyId,
      },
      resolver: container.providerResolver,
      actorId: actorUserId,
      ...(container.connectionBroker
        ? { broker: container.connectionBroker }
        : {}),
    });

    const mapConclusion = (status: GateStatus) =>
      status === "pass" ? "success" : status === "fail" ? "failure" : "neutral";

    await handlePrReview(
      {
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        headSha: ctx.headSha,
        installationId: ctx.installationId,
      },
      {
        executor,
        log,
        virtualKeyId: billingAccount.defaultVirtualKeyId,
        createCheckRun: (owner, repo, headSha) =>
          adapter.createCheckRun({
            owner,
            repo,
            headSha,
            installationId: ctx.installationId,
          }),
        updateCheckRun: async (
          owner,
          repo,
          checkRunId,
          conclusion,
          summary
        ) => {
          await adapter.updateCheckRun({
            owner,
            repo,
            installationId: ctx.installationId,
            checkRunId,
            conclusion: mapConclusion(conclusion as GateStatus),
            title: `PR Review: ${conclusion.toUpperCase()}`,
            summary,
          });
        },
        loadReviewContext: (owner, repo, prNumber, installationId) =>
          adapter.fetchPrContext({ owner, repo, prNumber, installationId }),
        postPrComment: async (owner, repo, prNumber, expectedHeadSha, body) => {
          const result = await adapter.postPrComment({
            owner,
            repo,
            installationId: ctx.installationId,
            prNumber,
            body,
            expectedHeadSha,
          });
          return result.posted;
        },
      }
    );

    log.info({ prNumber: ctx.prNumber }, "PR review completed");
  } catch (error) {
    log.error(
      { error: String(error), prNumber: ctx.prNumber },
      "PR review dispatch failed"
    );
  }
}
