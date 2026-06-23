// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-vcs`
 * Purpose: VcsCapability adapter using Octokit + GitHub App authentication.
 * Scope: Implements VcsCapability for GitHub API operations (list PRs, CI status, merge, create branch, dispatch candidate-flight).
 * Invariants:
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

    // Gate on GitHub Actions check runs only — third-party app checks (SonarCloud, etc.)
    // are informational and do not block merge via branch protection.
    const ciChecks = [
      ...rawCheckRuns
        .filter((cr) => cr.app?.slug === "github-actions")
        .map((cr) => ({ status: cr.status, conclusion: cr.conclusion })),
      // Legacy commit statuses are always included (they are GitHub-native)
      ...(statusResponse.data.statuses as Array<{ state: string }>).map(
        (s) => ({
          status: "completed",
          conclusion:
            s.state === "success"
              ? "success"
              : s.state === "pending"
                ? null
                : "failure",
        })
      ),
    ];

    const pending = ciChecks.some(
      (c) => c.status !== "completed" || c.conclusion === null
    );
    const allGreen =
      ciChecks.length > 0 &&
      !pending &&
      ciChecks.every(
        (c) => c.conclusion === "success" || c.conclusion === "skipped"
      );

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

  async mergePr(params: {
    owner: string;
    repo: string;
    prNumber: number;
    method: "squash" | "merge" | "rebase";
  }): Promise<MergeResult> {
    const octokit = await this.getOctokit(params.owner, params.repo);

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
        sha: data.sha,
        message: data.message,
      };
    } catch (error) {
      // Surface the GitHub HTTP status so callers classify structurally
      // (405 = refused/not-mergeable/already-merged, 409 = head modified)
      // rather than substring-matching the message.
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
        ? { merged: false, message }
        : { merged: false, status, message };
    }
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
