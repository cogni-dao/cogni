// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-vcs`
 * Purpose: VcsCapability adapter using Octokit + GitHub App authentication.
 * Scope: Implements VcsCapability for GitHub API operations (list PRs, CI status, merge, create branch, dispatch candidate-flight).
 * Invariants:
 *   - MERGE_IS_QUEUE_TOLERANT: `mergePr` detects the base branch's merge-queue state (GraphQL
 *     `mergeQueue`) and either direct-merges (no queue → `merged` + `sha`) or enqueues via
 *     `enablePullRequestAutoMerge` (queue required → `enqueued`, async, no `sha`).
 *   - AUTH_VIA_APP: Uses @octokit/auth-app for GitHub App JWT + installation token management
 *   - INSTALLATION_CACHED: Installation ID resolved once per owner/repo and cached
 *   - TOKEN_AUTO_REFRESH: Octokit auth-app handles token caching and refresh automatically
 *   - ADAPTER_SWAPPABLE: Implements VcsCapability — can be swapped for gh CLI adapter later
 *   - FLIGHT_WORKFLOW_REF: `candidate-flight.yml` is dispatched against `workflowRef ?? "main"`.
 *     Defaults to main; pass workflowRef to test workflow changes on a feature branch.
 * Side-effects: IO (GitHub REST API)
 * Links: task.0242, task.0297, services/scheduler-worker/src/adapters/ingestion/github-auth.ts
 * @internal
 */

import type {
  ApproveWorkflowRunsResult,
  CheckInfo,
  CiStatusResult,
  CreateBranchResult,
  DispatchCandidateFlightResult,
  MergeResult,
  PrSummary,
  VcsCapability,
} from "@cogni/ai-tools";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubVcsAdapterConfig {
  readonly appId: string;
  readonly privateKey: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GitHubVcsAdapter implements VcsCapability {
  private readonly config: GitHubVcsAdapterConfig;
  private readonly appAuth: ReturnType<typeof createAppAuth>;
  private readonly installationCache = new Map<string, number>();

  constructor(config: GitHubVcsAdapterConfig) {
    this.config = config;
    this.appAuth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
    });
  }

  async listPrs(params: {
    owner: string;
    repo: string;
    state?: "open" | "closed" | "all";
  }): Promise<readonly PrSummary[]> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: params.owner,
      repo: params.repo,
      state: params.state ?? "open",
      per_page: 50,
    });

    return data.map(
      (pr): PrSummary => ({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? "unknown",
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        labels: pr.labels.map(
          (l) => (typeof l === "string" ? l : l.name) ?? ""
        ),
        draft: pr.draft ?? false,
        mergeable: null, // List endpoint doesn't include mergeable
        updatedAt: pr.updated_at,
      })
    );
  }

  async getCiStatus(params: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<CiStatusResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    // Fetch PR metadata
    const { data: pr } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.prNumber,
      }
    );

    // Fetch check runs, combined status, and reviews in parallel
    const [checksResponse, statusResponse, reviewsResponse] = await Promise.all(
      [
        octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
          owner: params.owner,
          repo: params.repo,
          ref: pr.head.sha,
          per_page: 100,
        }),
        octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", {
          owner: params.owner,
          repo: params.repo,
          ref: pr.head.sha,
        }),
        octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          {
            owner: params.owner,
            repo: params.repo,
            pull_number: params.prNumber,
            per_page: 100,
          }
        ),
      ]
    );

    const rawCheckRuns = checksResponse.data.check_runs as Array<{
      name: string;
      status: string;
      conclusion: string | null;
      app: { slug: string } | null;
    }>;

    const checks: CheckInfo[] = [
      // Modern check runs (all — for observability)
      ...rawCheckRuns.map((cr) => ({
        name: cr.name,
        status: cr.status,
        conclusion: cr.conclusion,
      })),
      // Legacy commit statuses
      ...(
        statusResponse.data.statuses as Array<{
          context: string;
          state: string;
        }>
      ).map((s) => ({
        name: s.context,
        status: "completed",
        conclusion:
          s.state === "success"
            ? "success"
            : s.state === "pending"
              ? null
              : "failure",
      })),
    ];

    // Index GitHub-native check producers by context name — github-actions check
    // runs (by name) + legacy commit statuses (by context). Third-party app checks
    // (SonarCloud, etc.) are informational and never gate a merge.
    const byContext = new Map<
      string,
      { status: string; conclusion: string | null }
    >();
    for (const cr of rawCheckRuns) {
      if (cr.app?.slug === "github-actions") {
        byContext.set(cr.name, {
          status: cr.status,
          conclusion: cr.conclusion,
        });
      }
    }
    for (const s of statusResponse.data.statuses as Array<{
      context: string;
      state: string;
    }>) {
      byContext.set(s.context, {
        status: "completed",
        conclusion:
          s.state === "success"
            ? "success"
            : s.state === "pending"
              ? null
              : "failure",
      });
    }

    // REQUIRED_CHECKS_ARE_GITHUB_DEFINED: "green" is GitHub's OWN required-status-
    // check set for the PR's base branch (from branch protection), never an
    // operator-invented list. A required context is satisfied iff it completed
    // success|skipped — GitHub's own rule (a required check that legitimately
    // skips, e.g. a fork-guarded build, is passing). An unprotected branch (no
    // required checks) is NOT green: merge-on-green is meaningless without a
    // required set, so it fails closed.
    const requiredContexts = await this.getRequiredContexts(
      octokit,
      params.owner,
      params.repo,
      pr.base.ref
    );
    const pending = requiredContexts.some((ctx) => {
      const c = byContext.get(ctx);
      return !c || c.status !== "completed" || c.conclusion === null;
    });
    const allGreen =
      requiredContexts.length > 0 &&
      requiredContexts.every((ctx) => {
        const c = byContext.get(ctx);
        return (
          c != null &&
          c.status === "completed" &&
          (c.conclusion === "success" || c.conclusion === "skipped")
        );
      });

    // Compute review decision from individual reviews.
    // Take the latest review per reviewer; if any APPROVED and none CHANGES_REQUESTED → approved.
    const latestByReviewer = new Map<string, string>();
    for (const review of reviewsResponse.data as Array<{
      user: { login: string } | null;
      state: string;
    }>) {
      if (review.user && review.state !== "COMMENTED") {
        latestByReviewer.set(review.user.login, review.state);
      }
    }
    const reviewStates = [...latestByReviewer.values()];
    let reviewDecision: string | null = null;
    if (reviewStates.includes("CHANGES_REQUESTED")) {
      reviewDecision = "CHANGES_REQUESTED";
    } else if (reviewStates.includes("APPROVED")) {
      reviewDecision = "APPROVED";
    }

    return {
      prNumber: pr.number,
      prTitle: pr.title,
      author: pr.user?.login ?? "unknown",
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      mergeable: pr.mergeable,
      reviewDecision,
      labels: pr.labels.map((l) => (typeof l === "string" ? l : l.name) ?? ""),
      draft: pr.draft ?? false,
      allGreen,
      pending,
      checks,
    };
  }

  /**
   * The branch's REQUIRED status-check contexts, per GitHub branch protection —
   * the single source of truth for what "green" means (no operator-invented set).
   * Returns `[]` when the branch is unprotected or requires no checks (which the
   * merge gate treats as not-green / fail-closed). Uses the App's `administration`
   * read (the same privilege it uses to WRITE protection at node formation).
   */
  private async getRequiredContexts(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string
  ): Promise<string[]> {
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
        { owner, repo, branch }
      );
      return (data.contexts ?? []) as string[];
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return [];
      throw error;
    }
  }

  /**
   * Merge a PR — queue-tolerant. When the base branch requires a merge queue,
   * GitHub `405`s a direct `PUT .../merge`, so we instead enable auto-merge
   * (`enablePullRequestAutoMerge`), which GitHub routes through the queue: the
   * merge happens asynchronously on the queue's rebased candidate (`enqueued`,
   * no `sha` yet). When no queue is required (today's state everywhere), we
   * direct-merge exactly as before (`merged` + `sha`, synchronous). The branch's
   * queue state is detected deterministically up front (GraphQL `mergeQueue`) so
   * we never have to disambiguate a `405`.
   *
   * MERGED_XOR_ENQUEUED: the merge gate (caller) has already asserted the PR is
   * green; this method only chooses the execution path by queue requirement.
   */
  async mergePr(params: {
    owner: string;
    repo: string;
    prNumber: number;
    method: "squash" | "merge" | "rebase";
  }): Promise<MergeResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    // Resolve the PR's base branch + GraphQL node id once (node id is required by
    // the auto-merge mutation; base ref drives the queue check).
    let baseRef: string;
    let prNodeId: string;
    try {
      const { data: pr } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner: params.owner, repo: params.repo, pull_number: params.prNumber }
      );
      baseRef = pr.base.ref;
      prNodeId = pr.node_id;
    } catch (error) {
      return this.toMergeFailure(error);
    }

    const queueEnabled = await this.isMergeQueueEnabled(
      octokit,
      params.owner,
      params.repo,
      baseRef
    );

    if (queueEnabled) {
      try {
        await this.enableAutoMerge(octokit, prNodeId, params.method);
        return {
          merged: false,
          enqueued: true,
          message: `Pull request added to the merge queue on '${baseRef}' (async — merge completes on the queue's rebased candidate)`,
        };
      } catch (error) {
        return this.toMergeFailure(error);
      }
    }

    try {
      const { data } = await octokit.request(
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
        {
          owner: params.owner,
          repo: params.repo,
          pull_number: params.prNumber,
          merge_method: params.method,
        }
      );

      return {
        merged: data.merged,
        enqueued: false,
        sha: data.sha,
        message: data.message,
      };
    } catch (error) {
      return this.toMergeFailure(error);
    }
  }

  /**
   * Normalize a thrown GitHub error into a failed `MergeResult`, surfacing the
   * HTTP status so callers classify structurally (405 = refused/not-mergeable/
   * already-merged, 409 = head modified) rather than substring-matching.
   */
  private toMergeFailure(error: unknown): MergeResult {
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof (error as { status: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined;
    const message = error instanceof Error ? error.message : "Merge failed";
    // exactOptionalPropertyTypes: omit `status` rather than set it `undefined`.
    return status === undefined
      ? { merged: false, enqueued: false, message }
      : { merged: false, enqueued: false, status, message };
  }

  /**
   * True when `branch` has an active merge queue (a `merge_queue` ruleset or the
   * legacy "Require merge queue" toggle). GraphQL `repository.mergeQueue(branch)`
   * returns a non-null node when one exists. Fail-open to `false` (direct merge)
   * if the query errors — never block a merge on a flaky discovery call.
   */
  private async isMergeQueueEnabled(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string
  ): Promise<boolean> {
    try {
      const result = await octokit.graphql<{
        repository: { mergeQueue: { id: string } | null } | null;
      }>(
        `query ($owner: String!, $repo: String!, $branch: String!) {
          repository(owner: $owner, name: $repo) {
            mergeQueue(branch: $branch) { id }
          }
        }`,
        { owner, repo, branch }
      );
      return Boolean(result.repository?.mergeQueue?.id);
    } catch {
      return false;
    }
  }

  /** Enable auto-merge on a PR (routes through the merge queue when required). */
  private async enableAutoMerge(
    octokit: Octokit,
    pullRequestId: string,
    method: "squash" | "merge" | "rebase"
  ): Promise<void> {
    const mergeMethod = method.toUpperCase(); // GraphQL PullRequestMergeMethod
    await octokit.graphql(
      `mutation ($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
          pullRequest { id state }
        }
      }`,
      { pullRequestId, mergeMethod }
    );
  }

  async dispatchCandidateFlight(params: {
    owner: string;
    repo: string;
    nodeSlug: string;
    sourceSha: string;
    workflowRef?: string;
  }): Promise<DispatchCandidateFlightResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    const inputs: Record<string, string> = {
      node_slug: params.nodeSlug,
      source_sha: params.sourceSha,
    };

    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      {
        owner: params.owner,
        repo: params.repo,
        workflow_id: "candidate-flight.yml",
        ref: params.workflowRef ?? "main",
        inputs,
      }
    );

    const workflowUrl = `https://github.com/${params.owner}/${params.repo}/actions/workflows/candidate-flight.yml`;

    return {
      dispatched: true,
      nodeSlug: params.nodeSlug,
      sourceSha: params.sourceSha,
      workflowUrl,
      message: `Candidate flight dispatched for ${params.nodeSlug}@${params.sourceSha.slice(0, 8)}.`,
    };
  }

  async approveWorkflowRuns(params: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<ApproveWorkflowRunsResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    // Resolve the PR head SHA — workflow runs are keyed by head_sha.
    const { data: pr } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.prNumber,
      }
    );
    const headSha = pr.head.sha;

    // List the workflow runs GitHub is holding behind the fork-PR approval gate.
    const { data: runsData } = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs",
      {
        owner: params.owner,
        repo: params.repo,
        head_sha: headSha,
        status: "action_required",
        event: "pull_request",
        per_page: 100,
      }
    );

    const pending = runsData.workflow_runs as Array<{ id: number }>;

    // Approve each held run. `POST .../actions/runs/{run_id}/approve` requires
    // the installation to hold `actions: write` (cogni-node-template does).
    const runIds: number[] = [];
    for (const run of pending) {
      await octokit.request(
        "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve",
        {
          owner: params.owner,
          repo: params.repo,
          run_id: run.id,
        }
      );
      runIds.push(run.id);
    }

    const shortSha = headSha.slice(0, 8);
    return {
      approved: runIds.length,
      prNumber: params.prNumber,
      headSha,
      headRepo: pr.head.repo?.full_name ?? null,
      runIds,
      message:
        runIds.length > 0
          ? `Approved ${runIds.length} workflow run(s) for PR #${params.prNumber} @ ${shortSha}.`
          : `No workflow runs awaiting approval for PR #${params.prNumber} @ ${shortSha}.`,
    };
  }

  async createBranch(params: {
    owner: string;
    repo: string;
    branch: string;
    fromRef: string;
  }): Promise<CreateBranchResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

    let sha: string;
    if (/^[0-9a-f]{40}$/i.test(params.fromRef)) {
      sha = params.fromRef;
    } else {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/git/ref/{ref}",
        {
          owner: params.owner,
          repo: params.repo,
          ref: `heads/${params.fromRef}`,
        }
      );
      sha = data.object.sha;
    }

    const { data: refData } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/refs",
      {
        owner: params.owner,
        repo: params.repo,
        ref: `refs/heads/${params.branch}`,
        sha,
      }
    );

    return {
      ref: refData.ref,
      sha: refData.object.sha,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Get an Octokit instance authenticated as the GitHub App installation
   * for the given owner/repo. Installation ID is cached per owner/repo.
   */
  private async getOctokit(owner: string, repo: string): Promise<Octokit> {
    const installationId = await this.resolveInstallationId(owner, repo);
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.appId,
        privateKey: this.config.privateKey,
        installationId,
      },
    });
  }

  /**
   * Resolve GitHub App installation ID for a repo.
   * Cached per owner/repo to avoid redundant API calls.
   * Pattern from: services/scheduler-worker/src/adapters/ingestion/github-auth.ts:62-87
   */
  private async resolveInstallationId(
    owner: string,
    repo: string
  ): Promise<number> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.installationCache.get(cacheKey);
    if (cached) return cached;

    const { token } = await this.appAuth({ type: "app" });
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/installation`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `GitHub App not installed on ${cacheKey} (HTTP ${response.status})`
      );
    }

    const data = (await response.json()) as { id: number };
    this.installationCache.set(cacheKey, data.id);
    return data.id;
  }
}
