// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/vcs/github-op-error`
 * Purpose: Classify an uncaught GitHub read/op error into a coded HTTP result for the node-scoped
 *   VCS routes (run-ci, merge), so they emit a terminal Loki event with a coded status instead
 *   of an opaque 500. Shared by both routes — node-scoped targets are arbitrary node repos the
 *   operator App may not be installed on.
 * Scope: Pure classification. No network, no Octokit, no logging.
 * Invariants:
 *   - APP_NOT_INSTALLED_IS_502: the App missing on a node repo is an operator-config gap (502), not
 *     a client error.
 *   - PR_NOT_FOUND_IS_404: a GitHub 404 on the read maps to a clean 404.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/vcs/{run-ci,merge}/route.ts
 * @public
 */

/** A coded HTTP result derived from an uncaught GitHub error. */
export interface GithubOpErrorResult {
  readonly status: number;
  readonly errorCode: string;
  readonly error: string;
}

/** Map an uncaught GitHub read/op error to a coded response. */
export function classifyGithubOpError(error: unknown): GithubOpErrorResult {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (/not installed/i.test(message)) {
    return {
      status: 502,
      errorCode: "app_not_installed",
      error: "operator GitHub App is not installed on the node's repo",
    };
  }
  if (status === 404) {
    return { status: 404, errorCode: "pr_not_found", error: "PR not found" };
  }
  return {
    status: 502,
    errorCode: "github_op_failed",
    error: "GitHub operation failed",
  };
}
