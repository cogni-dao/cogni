// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/operator-change-auto-merge.server`
 * Purpose: Internal-only merge executor for a trusted operator-change-ready check.
 * Scope: Consumes an already HMAC-verified GitHub check_run payload. It exposes no HTTP or caller
 *   authority and never accepts a repository, PR, or SHA from an agent request.
 * Invariants:
 *   - INTERNAL_EVENT_ONLY: invoked only after webhook verification.
 *   - TRUSTED_READY_CHECK: direct merge requires a successful check produced only when the
 *     origin/main classifier returned eligible.
 *   - EXPECTED_HEAD_IS_ATOMIC: webhook head, current PR head, and GitHub merge precondition agree.
 *   - ALL_REQUIRED_CHECKS_GREEN: the ready proof is necessary but not sufficient.
 * Side-effects: GitHub reads and, for a fully eligible tree, one direct merge.
 * Links: docs/spec/merge-queue-config.md
 * @internal
 */

import type { VcsCapability } from "@cogni/ai-tools";
import type { ServerEnv } from "@/shared/env";
import type { Logger } from "@/shared/observability";

const READY_CHECK = "operator-change-automerge-ready";
const SHA = /^[0-9a-f]{40}$/;

export async function dispatchOperatorChangeAutoMerge(
  payload: Record<string, unknown>,
  env: ServerEnv,
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
  const expectedRepo = `${env.NODE_SUBMODULE_PARENT_OWNER}/${env.NODE_SUBMODULE_PARENT_REPO}`;
  if (
    typeof fullName !== "string" ||
    fullName.toLowerCase() !== expectedRepo.toLowerCase() ||
    typeof headSha !== "string" ||
    !SHA.test(headSha) ||
    typeof prNumber !== "number" ||
    !Number.isInteger(prNumber)
  ) {
    return;
  }
  const [owner, repo] = fullName.split("/") as [string, string];
  const ci = await vcs.getCiStatus({ owner, repo, prNumber });
  const signedBaseMatches = ci.headCommitMessage
    ?.split("\n")
    .filter((line) => line.startsWith("Cogni-Base-SHA: "));
  const ready = ci.checks.some(
    (check) =>
      check.name === READY_CHECK &&
      check.status === "completed" &&
      check.conclusion === "success"
  );
  if (
    ci.headSha !== headSha ||
    !ci.baseSha ||
    ci.headParentSha !== ci.baseSha ||
    signedBaseMatches?.length !== 1 ||
    signedBaseMatches[0] !== `Cogni-Base-SHA: ${ci.baseSha}` ||
    ci.pending ||
    !ci.allGreen ||
    !ready
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
      merged: result.merged,
      status: result.status,
    },
    "operator generated-change auto-merge evaluated"
  );
}
