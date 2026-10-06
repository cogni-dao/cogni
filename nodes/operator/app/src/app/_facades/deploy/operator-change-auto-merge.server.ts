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
 *   - EXPECTED_HEAD_IS_ATOMIC: webhook head, current PR head, and GitHub merge precondition agree.
 *   - ALL_REQUIRED_CHECKS_GREEN: GitHub's required-context set must be satisfied independently.
 * Side-effects: GitHub reads and, for a fully eligible tree, one direct merge.
 * Links: docs/spec/merge-queue-config.md
 * @internal
 */

import type { VcsCapability } from "@cogni/ai-tools";
import type { Logger } from "@/shared/observability";

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
  if (!proof.eligible || proof.headSha !== headSha) return;

  const ci = await vcs.getCiStatus({ owner, repo, prNumber });
  if (
    ci.headSha !== headSha ||
    ci.baseSha !== proof.baseSha ||
    ci.pending ||
    !ci.allGreen
  ) {
    return;
  }

  const result = await vcs.mergePr({
    owner,
    repo,
    prNumber,
    method: "squash",
    bypassQueue: true,
    expectedHeadSha: headSha,
  });
  log.info(
    {
      event: "operator_change.auto_merge",
      owner,
      repo,
      prNumber,
      headSha,
      operation: proof.operation,
      node: proof.node,
      merged: result.merged,
      status: result.status,
    },
    "operator generated-change auto-merge evaluated"
  );
}
