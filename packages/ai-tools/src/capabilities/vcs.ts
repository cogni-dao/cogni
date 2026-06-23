// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/vcs`
 * Purpose: VCS capability interface for AI tools — GitHub API operations (PR management, branches, CI status).
 * Scope: Defines VcsCapability for remote VCS operations. Does NOT implement transport.
 * Invariants:
 *   - CAPABILITY_INJECTION: Implementation injected at bootstrap, not imported
 *   - VCS_WRITE_CAPABLE: Supports both read and write operations (merge, branch creation)
 *   - ADAPTER_SWAPPABLE: Interface supports Octokit (v0) or gh CLI (future sandbox agents)
 * Side-effects: none (interface only)
 * Links: task.0242, task.0297, docs/guides/github-app-webhook-setup.md
 * @public
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Summary of a pull request for listing. */
export interface PrSummary {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly labels: readonly string[];
  readonly draft: boolean;
  readonly mergeable: boolean | null;
  readonly updatedAt: string;
}

/** Individual check run/status result. */
export interface CheckInfo {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** Combined CI status for a pull request. */
export interface CiStatusResult {
  readonly prNumber: number;
  readonly prTitle: string;
  readonly author: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly mergeable: boolean | null;
  readonly reviewDecision: string | null;
  readonly labels: readonly string[];
  readonly draft: boolean;
  readonly allGreen: boolean;
  readonly pending: boolean;
  readonly checks: readonly CheckInfo[];
}

/** Result of merging a pull request. */
export interface MergeResult {
  readonly merged: boolean;
  readonly sha?: string;
  readonly message: string;
  /**
   * GitHub HTTP status surfaced on a failed merge (`merged: false`).
   * Lets callers classify the failure structurally — 405 = GitHub refused
   * (not mergeable / branch protection / already merged), 409 = head modified —
   * instead of substring-matching `message`. Undefined on success.
   */
  readonly status?: number;
}

/** Result of creating a branch. */
export interface CreateBranchResult {
  readonly ref: string;
  readonly sha: string;
}

/**
 * Result of dispatching a candidate-a flight.
 *
 * GitHub's `POST /dispatches` returns HTTP 204 with no body — there is no
 * reliable way to identify the specific run it created short of a racey
 * polling lookup. We deliberately don't attempt that correlation here.
 * The caller observes the resulting workflow run from the returned workflow URL.
 */
export interface DispatchCandidateFlightResult {
  readonly dispatched: boolean;
  readonly nodeSlug: string;
  readonly sourceSha: string;
  readonly workflowUrl: string;
  readonly message: string;
}

/**
 * Result of dispatching the trusted-context fork-PR build (`pr-build.yml`'s
 * `workflow_dispatch` trigger — FORK_FREEDOM). Same 204-no-body caveat as
 * {@link DispatchCandidateFlightResult}: the caller observes the run from
 * `workflowUrl`.
 */
export interface DispatchForkPrBuildResult {
  readonly dispatched: boolean;
  readonly prNumber: number;
  readonly headRepo: string;
  readonly headSha: string;
  readonly workflowUrl: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Capability interface
// ---------------------------------------------------------------------------

/**
 * VCS capability for AI tools — remote GitHub operations.
 *
 * Per CAPABILITY_INJECTION: implementation injected at bootstrap time.
 * Per ADAPTER_SWAPPABLE: Octokit adapter for v0; gh CLI adapter for sandbox agents.
 *
 * The implementation resolves GitHub App auth internally —
 * tools never see tokens or installation IDs.
 */
export interface VcsCapability {
  /** List pull requests with optional state filter. */
  listPrs(params: {
    owner: string;
    repo: string;
    state?: "open" | "closed" | "all";
  }): Promise<readonly PrSummary[]>;

  /** Get detailed CI/review status for a specific PR. */
  getCiStatus(params: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<CiStatusResult>;

  /** Merge a pull request. */
  mergePr(params: {
    owner: string;
    repo: string;
    prNumber: number;
    method: "squash" | "merge" | "rebase";
  }): Promise<MergeResult>;

  /** Create a new branch from a ref (branch name or SHA). */
  createBranch(params: {
    owner: string;
    repo: string;
    branch: string;
    fromRef: string;
  }): Promise<CreateBranchResult>;

  /**
   * Dispatch the `candidate-flight.yml` workflow for a node source revision.
   *
   * Thin wrapper over GitHub's `workflow_dispatch` API. Does not check slot
   * availability, CI status, or permissions — those gates live in the
   * workflow (flight slot lease, digest promotion, Argo reconciliation).
   *
   * Per NO_AUTO_FLIGHT: agents must be explicitly instructed to call this.
   * The tool description repeats this to the planner.
   */
  dispatchCandidateFlight(params: {
    owner: string;
    repo: string;
    nodeSlug: string;
    sourceSha: string;
    workflowRef?: string;
  }): Promise<DispatchCandidateFlightResult>;

  /**
   * Dispatch the trusted-context fork-PR build (`pr-build.yml` via
   * `workflow_dispatch`) for an operator-approved fork PR — FORK_FREEDOM.
   *
   * Builds `{headRepo}@{headSha}` in the BASE repo's trusted context (writable
   * GHCR token), producing the immutable `pr-{prNumber}-{headSha}` images that
   * `candidate-flight.yml` already resolves. The workflow runs in the base repo
   * (`owner`/`repo`); `headRepo`/`headSha` are the fork tree to build.
   *
   * This is a thin GitHub-dispatch wrapper. The TRUST GATE (developer
   * `can_flight` on the operator node) lives in the calling route, NOT here.
   */
  dispatchForkPrBuild(params: {
    owner: string;
    repo: string;
    prNumber: number;
    headRepo: string;
    headSha: string;
    workflowRef?: string;
  }): Promise<DispatchForkPrBuildResult>;
}
