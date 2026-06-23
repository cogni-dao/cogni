// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/vcs/merge-gate`
 * Purpose: Pure decision logic for the operator-executed PR merge — the pre-merge
 *   CI/state gate and the failure classifier. No IO; the route composes these with
 *   auth, env, and the VcsCapability.
 * Scope: Two total functions over `CiStatusResult` / a GitHub status. Unit-testable
 *   without a container or GitHub.
 * Invariants:
 *   - BRANCH_PROTECTION_IS_AUTHORITY: this gate is fast-fail UX. GitHub branch
 *     protection independently rejects a non-green merge (405) — the real backstop.
 *     `allGreen` here gates on github-actions check runs (see GitHubVcsAdapter).
 *   - STATUS_NOT_SUBSTRING: failures are classified on the surfaced GitHub HTTP
 *     status, never a message substring.
 * Side-effects: none (pure)
 * Links: nodes/operator/app/src/app/api/v1/vcs/merge/route.ts
 * @public
 */

import type { CiStatusResult } from "@cogni/ai-tools";

/** A merge refusal: the HTTP status to return, a stable code, and a human message. */
export interface MergeGateRejection {
  readonly status: number;
  readonly errorCode: string;
  readonly error: string;
}

/**
 * Pre-merge gate over a PR's CI/state. Returns `null` when the PR is mergeable,
 * or the first failing reason. Order: base → draft → green → mergeable.
 */
export function evaluateMergeGate(
  ci: CiStatusResult
): MergeGateRejection | null {
  if (ci.baseBranch !== "main") {
    return {
      status: 422,
      errorCode: "wrong_base",
      error: `PR base is '${ci.baseBranch}', expected 'main'`,
    };
  }
  if (ci.draft) {
    return { status: 422, errorCode: "pr_draft", error: "PR is a draft" };
  }
  if (!ci.allGreen || ci.pending) {
    return {
      status: 422,
      errorCode: "not_green",
      error: "required checks are not all green",
    };
  }
  if (ci.mergeable === false) {
    return {
      status: 422,
      errorCode: "pr_not_mergeable",
      error: "PR is not mergeable (conflicts)",
    };
  }
  if (ci.mergeable === null) {
    return {
      status: 422,
      errorCode: "pr_not_mergeable",
      error: "mergeability is still computing, retry",
    };
  }
  return null;
}

/**
 * Classify a failed `mergePr()` by the surfaced GitHub HTTP status.
 * 405 → GitHub refused (not mergeable / branch protection / already merged/closed);
 * 409 → PR head modified mid-merge (retry); anything else → opaque merge failure.
 */
export function classifyMergeFailure(
  status: number | undefined,
  message: string
): MergeGateRejection {
  if (status === 405) {
    return {
      status: 409,
      errorCode: "merge_rejected",
      error:
        message ||
        "GitHub refused the merge (not mergeable, branch protection, or already merged)",
    };
  }
  if (status === 409) {
    return {
      status: 409,
      errorCode: "head_modified",
      error: message || "PR head was modified during merge; retry",
    };
  }
  return {
    status: 502,
    errorCode: "merge_failed",
    error: message || "merge failed",
  };
}
