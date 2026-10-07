// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/operator-change-auto-merge.server`
 * Purpose: Internal-only merge executor woken by a GitHub check completion.
 * Scope: Consumes an already HMAC-verified GitHub check_run payload. It exposes no HTTP or caller
 *   authority and never accepts a repository, PR, or SHA from an agent request.
 * Invariants:
 *   - INTERNAL_EVENT_ONLY: invoked only after webhook verification.
 *   - CHECK_RUN_IS_WAKE_ONLY: no check name, conclusion, or producing App grants authority.
 *   - TRUSTED_RECLASSIFICATION: the operator re-fetches and verifies the current PR, commit,
 *     files, trusted-main registry, exact App identity/signature, and operation replay.
 *   - BASE_AND_HEAD_ARE_ATOMIC: the verified one-parent head may advance only its exact base;
 *     a concurrent base update makes the non-force ref update fail closed.
 *   - ALL_REQUIRED_CHECKS_GREEN: GitHub's required-context set must be satisfied independently.
 *   - REGISTER_DURABLE_BEFORE_CAS: node.register starts the stable Temporal workflow before any
 *     ref write; the Activity owns the CAS and post-land candidate dispatch as one retryable unit.
 *   - FAILED_EXECUTIONS_RESTART: redelivery may restart a failed/timed-out/canceled/terminated
 *     execution, while a running or successfully completed execution remains a duplicate no-op.
 * Side-effects: GitHub reads, a durable workflow start for node.register/recovery, and for other
 *   eligible trees one non-force ref fast-forward.
 * Links: docs/spec/merge-queue-config.md, task.5195
 * @internal
 */

import type { VcsCapability } from "@cogni/ai-tools";
import {
  OperatorChangeRecoveryWorkflowInputSchema,
  operatorChangeRecoveryWorkflowId,
} from "@cogni/temporal-workflows";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { getTemporalWorkflowClient } from "@/bootstrap/container";
import type { Logger } from "@/shared/observability";

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type RecoveryRequest = ReturnType<
  typeof OperatorChangeRecoveryWorkflowInputSchema.parse
>;

async function startRecoveryWorkflow(request: RecoveryRequest): Promise<void> {
  const { client, taskQueue } = await getTemporalWorkflowClient();
  try {
    await client.start("OperatorChangeRecoveryWorkflow", {
      taskQueue,
      workflowId: operatorChangeRecoveryWorkflowId(request),
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      args: [request],
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

export async function dispatchOperatorChangeAutoMerge(
  payload: Record<string, unknown>,
  vcs: VcsCapability,
  log: Logger
): Promise<void> {
  if (payload.action !== "completed") return;
  const checkRun = payload.check_run as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const pullRequests = checkRun?.pull_requests as
    | ReadonlyArray<Record<string, unknown>>
    | undefined;
  const fullName = repository?.full_name;
  const headSha = checkRun?.head_sha;
  const prNumber = pullRequests?.[0]?.number;
  if (
    typeof fullName !== "string" ||
    !REPOSITORY.test(fullName) ||
    typeof headSha !== "string" ||
    !SHA.test(headSha) ||
    typeof prNumber !== "number" ||
    !Number.isInteger(prNumber)
  ) {
    return;
  }
  const [owner, repo] = fullName.split("/") as [string, string];
  const proof = await vcs.verifyOperatorChange({
    owner,
    repo,
    prNumber,
    expectedHeadSha: headSha,
  });
  const staleButVerified = proof.reason === "base-advanced";
  if (
    (!proof.eligible && !staleButVerified) ||
    proof.headSha !== headSha ||
    proof.policyHeadSha === undefined ||
    !proof.intent
  )
    return;

  const ci = await vcs.getCiStatus({ owner, repo, prNumber });
  if (
    ci.headSha !== headSha ||
    ci.reviewDecision === "CHANGES_REQUESTED" ||
    ci.pending ||
    !ci.allGreen
  ) {
    return;
  }

  const request = OperatorChangeRecoveryWorkflowInputSchema.parse({
    owner,
    repo,
    prNumber,
    signedBaseSha: proof.baseSha,
    losingHeadSha: headSha,
    intent: proof.intent,
  });

  // The node birth CAS and its candidate dispatch must be one durable retryable operation. Starting
  // Temporal first leaves main untouched if the handoff fails; Activity retry can safely repeat the
  // exact node+source dispatch after it observes that this head already landed.
  if (request.intent.operation === "node.register") {
    await startRecoveryWorkflow(request);
    log.info(
      {
        event: "operator_change.auto_merge",
        owner,
        repo,
        prNumber,
        headSha,
        operation: request.intent.operation,
        node: request.intent.node,
        outcome: "durable_execution_started",
      },
      "operator generated-change auto-merge evaluated"
    );
    return;
  }

  const result = staleButVerified
    ? {
        outcome: "base_advanced" as const,
        currentBaseSha: ci.baseSha ?? "unknown",
        message: "Verified generated change already has a stale base",
      }
    : await vcs.fastForwardOperatorChange({
        owner,
        repo,
        prNumber,
        expectedBaseSha: proof.baseSha,
        expectedHeadSha: headSha,
        expectedPolicyHeadSha: proof.policyHeadSha,
      });
  if (
    result.outcome === "base_advanced" ||
    result.outcome === "retryable_or_ambiguous"
  ) {
    await startRecoveryWorkflow(request);
  }
  log.info(
    {
      event: "operator_change.auto_merge",
      owner,
      repo,
      prNumber,
      headSha,
      operation: proof.operation,
      node: proof.node,
      outcome: result.outcome,
      status: "status" in result ? result.status : undefined,
    },
    "operator generated-change auto-merge evaluated"
  );
}
